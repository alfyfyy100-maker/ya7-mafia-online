/**
 * مافيا أونلاين — المرحلة ١+٢: الغرفة + اللوبي + توزيع الأدوار الخاص
 * Ya7 STUDIO
 *
 * يشتغل كـ Cloudflare Worker + Durable Object واحد باسم MafiaRoom.
 * كل غرفة = instance مستقل من MafiaRoom، معرّف بكود الغرفة (6 أحرف).
 *
 * نشر:
 *   wrangler deploy
 * يحتاج wrangler.toml مرفق بجانب هذا الملف.
 */

// ══════════════════════ أعلام ══════════════════════
const ALLOWED_ORIGINS = [
  'https://games.playsmart2030.com',
];

function isAllowedOrigin(origin) {
  return !!origin && ALLOWED_ORIGINS.includes(origin);
}

function corsFor(origin) {
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function withCors(resp, origin) {
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsFor(origin))) h.set(k, v);
  return new Response(resp.body, { status: resp.status, headers: h });
}

// ══════════════════════ حدود وتنقية عامة ══════════════════════
const MAX_PLAYERS = 20;

// تنقية الاسم في الخادم: يمنع الحقن في الواجهة ويحدّ الطول
function cleanName(raw) {
  const s = String(raw == null ? '' : raw)
    .replace(/[<>&"'`\\]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14);
  return s || 'لاعب';
}

function newSeatToken() {
  return crypto.randomUUID().replace(/-/g, '');
}

// ── عشوائية آمنة: crypto لا Math.random ──
// Math.random في V8 هو xorshift128+ ويُعكَس من أربع مخرجات متتالية.
// كل ما يقرّر دورًا أو كرتًا أو رمز غرفة يمر من هنا. رميات البوتات
// الاحتمالية تبقى على Math.random — ما فيها سر يُتوقّع.
function randInt(n) {
  if (!(n > 0)) return 0;
  const limit = Math.floor(0xFFFFFFFF / n) * n;
  const buf = new Uint32Array(1);
  let x;
  do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
  return x % n;
}

// تنقية أي نص حر يرسله لاعب: يمنع الحقن ويحدّ الطول قبل التخزين والبث
function cleanText(raw, max = 60) {
  return String(raw == null ? '' : raw)
    .replace(/[<>&"'`\\]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// مقارنة توكن بزمن ثابت — تمنع استنتاج التوكن عبر قياس زمن الرد
function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// يبني منقّي إعدادات: مفاتيح معروفة فقط، بلا حقن مفاتيح عشوائية أو قيم ضخمة
function makeConfigSanitizer(boolKeys, numKeys = {}) {
  return function (raw) {
    const out = {};
    for (const k of boolKeys) out[k] = !!(raw && raw[k]);
    for (const [k, [min, max, def]] of Object.entries(numKeys)) {
      const v = Number(raw && raw[k]);
      out[k] = Number.isInteger(v) ? Math.min(Math.max(v, min), max) : def;
    }
    return out;
  };
}

const sanitizeMafiaConfig = makeConfigSanitizer(
  ['doctor','detective','heir','spy','witch','avenger','trap','twins'],
  { mafia: [1, 6, 1] }
);
const sanitizeGotConfig = makeConfigSanitizer(
  ['varys','melisandre','hound','baelish','lovers','craster','bronn','faceless']
);

// خنق الرسائل: كل رسالة تقريبًا تكتب في التخزين، فبلا حدّ يقدر لاعب واحد
// يستنزف الفاتورة. نُطبّق ١٢ رسالة/ثانية لكل لاعب.
const MSG_PER_SEC = 12;

// عمر الغرفة الخاملة قبل الحذف التلقائي
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

// خليط مشترك لكل الغرف: خنق + تنظيف تلقائي + استعادة المقعد بتوكن
const RoomCommon = {
  // ── خنق الرسائل ──
  allowMsg(playerId) {
    if (!this._rate) this._rate = new Map();
    const now = Date.now();
    const r = this._rate.get(playerId) || { n: 0, t: now };
    if (now - r.t > 1000) { r.n = 0; r.t = now; }
    r.n++;
    this._rate.set(playerId, r);
    return r.n <= MSG_PER_SEC;
  },

  // ── تنظيف الغرف الخاملة ──
  async touchRoom() {
    this.room.lastSeen = Date.now();
    try { await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS); } catch {}
  },

  async alarm() {
    const idle = Date.now() - (this.room.lastSeen || 0);
    const live = (this.sockets ? this.sockets.size : 0) + (this.screens ? this.screens.size : 0);
    if (idle >= ROOM_TTL_MS && live === 0) {
      await this.state.storage.deleteAll();
    } else {
      try { await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS); } catch {}
    }
  },

  // ── الهوية: التوكن السري وحده يفتح مقعدًا قائمًا ──
  // المعرّف (playerId) يُبَث للجميع في اللوبي، فلا يصلح إثبات هوية أبدًا.
  seatByToken(token) {
    if (!token) return null;
    return this.room.players.find(p => tokenEquals(p.seatToken, token)) || null;
  },
};

/* أبجدية كود الغرفة: 31 حرفًا (بلا I و L و O لالتباسها).
   كانت تُفهرَس بـ *32 فيخرج undefined ويبتلعه join() ⇒ كود من 5 محارف
   لا يطابق مسار الانضمام [A-Z0-9]{6} ⇒ 17% من الغرف تُنشأ ولا يدخلها أحد. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function newRoomCode() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);          // الكود هو بيان الاعتماد الوحيد للغرفة
  return Array.from(b, x => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
}

/* المعرّف يأتي من الرابط ويُستعمل مفتاحًا في كائنات ويُخزَّن ويُبَث.
   بلا هذا: __proto__ يبتلع الأصوات بصمت فتتجمّد المرحلة، ومعرّف ضخم
   يتجاوز سقف قيمة الـ Durable Object فتفشل الكتابة للغرفة كلها. */
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
function validPlayerId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) && !RESERVED_IDS.has(v);
}

function applyRoomCommon(cls) {
  for (const [k, v] of Object.entries(RoomCommon)) {
    if (!(k in cls.prototype)) cls.prototype[k] = v;
  }
}

// ══════════════════════ تعريف الأدوار (نفس منطق اللعبة الأصلي) ══════════════════════
const ROLES = {
  mafia:      { team: 'evil', name: 'المافيا' },
  doctor:     { team: 'good', name: 'الطبيب' },
  detective:  { team: 'good', name: 'المحقق' },
  citizen:    { team: 'good', name: 'مواطن' },
  heir:       { team: 'good', name: 'الوريث' },
  spy:        { team: 'good', name: 'الجاسوس' },
  witch:      { team: 'good', name: 'الساحرة' },
  avenger:    { team: 'good', name: 'المنتقم الأعمى' },
  trap:       { team: 'evil', name: 'الفخ الصامت' },
  twin_good:  { team: 'good', name: 'التوأم' },
  twin_evil:  { team: 'evil', name: 'التوأم' },
};
const BOT_NAMES_M = ['فهد','عبدالله','خالد','تركي','سلطان','ماجد','بندر','ناصر','راكان','مشعل'];
const BOT_NAMES_F = ['سارة','نورة','ريم','لمى','هند','جود','شهد','دانة','العنود','غلا'];
const BOT_NAMES = [...BOT_NAMES_M, ...BOT_NAMES_F];
function pickRandom(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// يبني قائمة الأدوار حسب إعدادات الغرفة، بنفس منطق اللعبة المحلية
function buildRoleList(config, playerCount) {
  const roles = [];
  for (let i = 0; i < config.mafia; i++) roles.push('mafia');
  if (config.doctor) roles.push('doctor');
  if (config.detective) roles.push('detective');
  if (config.heir) roles.push('heir');
  if (config.spy) roles.push('spy');
  if (config.witch) roles.push('witch');
  if (config.avenger) roles.push('avenger');
  if (config.trap) roles.push('trap');
  let hasTwins = false;
  if (config.twins) {
    const evilTwin = Math.random() < 0.3; // ٣٠٪ أن أحد التوأمين شرير
    roles.push(evilTwin ? 'twin_evil' : 'twin_good');
    roles.push('twin_good');
    hasTwins = true;
  }
  while (roles.length < playerCount) roles.push('citizen');
  return { roles: roles.slice(0, playerCount), hasTwins };
}

// يحسب عدد المقاعد اللي تحتاجها الأدوار المفعّلة
function neededSeats(config) {
  let n = config.mafia;
  for (const k of ['doctor','detective','heir','spy','witch','avenger','trap']) if (config[k]) n++;
  if (config.twins) n += 2;
  return n;
}

// ══════════════════════ Durable Object: غرفة واحدة ══════════════════════
// ══════════════════════ مافيا — مكتبة جُمل البوتات ══════════════════════
// مكتوبة من الصفر لعالم مافيا (قرية/مجلس/فجر/جثة) — لا علاقة لها بجُمل لمن العرش؟
// نجدي + فصحى. الاتهام وكلام الفجر مطابقان لجنس المذكور، والدفاع مطابق لجنس المتكلّم.
// {t} = اسم المقصود.
const MAFIA_LINES = {
  // ─────────── اتهام: {t} = المتهَم، والجملة تطابق جنسه ───────────
  accuse: {
    m: { najdi: [
      "من أول ليلة و{t} يتفادى النظر بعيوننا — وش يخبّي؟",
      "{t} كل ما ذكرنا القتيل غيّر السالفة بسرعة.",
      "لاحظتوا إن {t} أول من اقترح نصوّت على غيره؟ لعبة قديمة.",
      "{t} ساكت زيادة عن اللزوم، والساكت بهالمجلس له سبب.",
      "كلام {t} ما يجي على بعضه، مرة يقول نام ومرة يقول كان صاحي.",
      "{t} يدافع عن كل واحد نتهمه — يمكن يحمي عياله.",
      "وش دخّل {t} حوش القتيل قبل الفجر؟ ما أحد جاوبنا.",
      "{t} يعرف تفاصيل ما أحد قالها — منين جابها؟",
      "أرفع صوتي بوجه {t}، ترى الظلام يعرفه أكثر منّا.",
      "{t} يضحك والقرية فيها ميت — هذا وحده يكفيني.",
      "ما ارتحت لـ {t} أبد، ومن أول جولة وأنا أراقبه.",
      "{t} يبي يستعجلنا بالتصويت، واللي يستعجل يخاف من الوقت.",
      "شفت {t} يهمس مع أحد قبل لا ينطفي السراج.",
      "{t} أول من صوّت على البريء أمس، ومين يستفيد غير المافيا؟",
      "لو {t} بريء، ليه يرتجف كل ما جا دوره يتكلم؟",
      "{t} حافظ جوابه من قبل لا نسأله — هذا مو طبيعي.",
      "خلّونا نجرّب {t} اليوم، وإن طلع بريء أنا أول من يعتذر.",
      "{t} يبدّل كلامه كل ما ضاقت عليه — أنا صوتي له.",
      "كل قتيل يطلع قريب من {t}، والصدفة ما تتكرر ثلاث مرات.",
      "{t} ما نام أمس، وأنا شفت ضوّه شغّال لين الفجر."
    ], fusha: [
      "منذ الليلة الأولى و{t} يتهرّب من الأسئلة المباشرة.",
      "أرى في هدوء {t} ترتيبًا لا براءة.",
      "كان {t} أسرعنا إلى الاتهام، وتلك حيلة معروفة.",
      "روايات {t} متضاربة، وما يقوله اليوم ينقض ما قاله بالأمس.",
      "لا أثق في {t}، فحماسه في الدفاع عن نفسه مبالغ فيه.",
      "علِم {t} بتفاصيل الجريمة قبل أن نعلنها، فمن أخبره؟",
      "أدعو المجلس إلى محاسبة {t} قبل أن يسقط بيننا قتيل آخر.",
      "صمت {t} في موضع الكلام أبلغ من أي اعتراف.",
      "كلما ضاق الخناق على {t} حوّل الاتهام إلى غيره.",
      "اسم {t} يتكرر قرب كل جثة، والتكرار لا يكون مصادفة.",
      "أرى في نظرات {t} اضطرابًا لا يصدر عن بريء.",
      "لم يقدّم {t} تفسيرًا واحدًا مقنعًا منذ بدأنا.",
      "خرج {t} ليلًا ولم يعد إلا مع الفجر، وهذا وحده يكفي.",
      "دفاع {t} قائم على العاطفة لا على دليل.",
      "لو كان {t} بريئًا لما اضطرب هذا الاضطراب كله."
    ] },
    f: { najdi: [
      "من أول ليلة و{t} تتفادى النظر بعيوننا — وش تخبّي؟",
      "{t} كل ما ذكرنا القتيل غيّرت السالفة بسرعة.",
      "لاحظتوا إن {t} أول من اقترحت نصوّت على غيرها؟ لعبة قديمة.",
      "{t} ساكتة زيادة عن اللزوم، والساكت بهالمجلس له سبب.",
      "كلام {t} ما يجي على بعضه، مرة تقول نامت ومرة تقول كانت صاحية.",
      "{t} تدافع عن كل واحد نتهمه — يمكن تحمي أهلها.",
      "وش دخّل {t} حوش القتيل قبل الفجر؟ ما أحد جاوبنا.",
      "{t} تعرف تفاصيل ما أحد قالها — منين جابتها؟",
      "أرفع صوتي بوجه {t}، ترى الظلام يعرفها أكثر منّا.",
      "{t} تضحك والقرية فيها ميت — هذا وحده يكفيني.",
      "ما ارتحت لـ {t} أبد، ومن أول جولة وأنا أراقبها.",
      "{t} تبي تستعجلنا بالتصويت، واللي يستعجل يخاف من الوقت.",
      "شفت {t} تهمس مع أحد قبل لا ينطفي السراج.",
      "{t} أول من صوّتت على البريء أمس، ومين يستفيد غير المافيا؟",
      "لو {t} بريئة، ليه ترتجف كل ما جا دورها تتكلم؟",
      "{t} حافظة جوابها من قبل لا نسألها — هذا مو طبيعي.",
      "خلّونا نجرّب {t} اليوم، وإن طلعت بريئة أنا أول من يعتذر.",
      "{t} تبدّل كلامها كل ما ضاقت عليها — أنا صوتي لها.",
      "كل قتيل يطلع قريب من {t}، والصدفة ما تتكرر ثلاث مرات.",
      "{t} ما نامت أمس، وأنا شفت ضوّها شغّال لين الفجر."
    ], fusha: [
      "منذ الليلة الأولى و{t} تتهرّب من الأسئلة المباشرة.",
      "أرى في هدوء {t} ترتيبًا لا براءة.",
      "كانت {t} أسرعنا إلى الاتهام، وتلك حيلة معروفة.",
      "روايات {t} متضاربة، وما تقوله اليوم ينقض ما قالته بالأمس.",
      "لا أثق في {t}، فحماسها في الدفاع عن نفسها مبالغ فيه.",
      "علِمت {t} بتفاصيل الجريمة قبل أن نعلنها، فمن أخبرها؟",
      "أدعو المجلس إلى محاسبة {t} قبل أن يسقط بيننا قتيل آخر.",
      "صمت {t} في موضع الكلام أبلغ من أي اعتراف.",
      "كلما ضاق الخناق على {t} حوّلت الاتهام إلى غيرها.",
      "اسم {t} يتكرر قرب كل جثة، والتكرار لا يكون مصادفة.",
      "أرى في نظرات {t} اضطرابًا لا يصدر عن بريئة.",
      "لم تقدّم {t} تفسيرًا واحدًا مقنعًا منذ بدأنا.",
      "خرجت {t} ليلًا ولم تعد إلا مع الفجر، وهذا وحده يكفي.",
      "دفاع {t} قائم على العاطفة لا على دليل.",
      "لو كانت {t} بريئة لما اضطربت هذا الاضطراب كله."
    ] },
    // محايدة: تصلح للاثنين، ما فيها فعل ولا وصف يطابق المتهَم
    any: { najdi: [
      "الشبهة كلها تروح لـ {t}، وأنا ما ألوم إلا الأدلة.",
      "صوتي اليوم لـ {t}، وخلّوا الفجر يحكم بينّا.",
      "من يوم بدينا وعيني على {t}.",
      "ترى الخيوط تشير لـ {t} من غير ما نبيها.",
      "ما عندي شك: أقرب واحد للجثة أمس هو {t}.",
      "خلّونا نصوّت على {t} ونشوف الليلة الجاية تهدأ ولا لا.",
      "كل خيط بيدنا يرجع لـ {t}.",
      "لو أخطأنا في {t} نعتذر، بس الشك أثقل من السكوت.",
      "اسم {t} تكرر في كل نقاش، وهذا مو من فراغ.",
      "بنندم لو تركنا {t} لليلة ثانية.",
      "المصلحة كلها كانت عند {t}، وشوفوا مين ربح من موت أمس.",
      "ما بقى إلا {t}، بقية القرية كلامها مترابط.",
      "الصمت اللي حول {t} أثقل من أي كلام.",
      "أنا أرشّح {t} للحبل، والباقي عليكم.",
      "لو فيه عدالة اليوم، فهي عند اسم {t}.",
      "خلّونا نضيّق الدايرة: {t} وبس.",
      "أنا مستعد أتحمّل غلطي، بس صوتي لـ {t}.",
      "الليل يعرف {t} أكثر من النهار.",
      "أقول {t}، وأقولها بصوت عالي قدّام الكل.",
      "من صوّت مع {t} أمس يعرف عن وش أتكلم."
    ], fusha: [
      "أوجّه صوتي إلى {t}، وليشهد المجلس.",
      "كل القرائن تقود إلى {t} دون تكلّف.",
      "لا أرى في القرية اسمًا أحقّ بالمساءلة من {t}.",
      "المصلحة في جريمة الأمس كانت في جهة {t}.",
      "أرشّح {t} لحكم المجلس اليوم.",
      "خيوط الليل كلها تنتهي عند {t}.",
      "لن نبلغ الحقيقة ما لم نبدأ بـ {t}.",
      "اسم {t} يتردّد منذ الفجر، والصدى لا يأتي من فراغ.",
      "إن أخطأنا في {t} اعتذرنا، وإن أصبنا نجونا.",
      "أضع ثقل صوتي كله على {t}.",
      "لا أملك يقينًا، لكنّ الشك في {t} أثقل من غيره.",
      "ضاقت دائرة الشك حتى صارت اسمًا واحدًا: {t}.",
      "لو أُتيح لي اتهام واحد فقط لقلت {t}.",
      "المجلس مطالب اليوم بمساءلة {t} قبل غروب الشمس.",
      "أرى في ليلة أمس طريقًا واحدًا لا ثاني له: {t}."
    ] }
  },

  // ─────────── دفاع: الجملة تطابق جنس المتكلّم نفسه ───────────
  defend: {
    m: { najdi: [
      "أنا بريء والله، وتصويتكم عليّ يضيّع عليكم القاتل الحقيقي.",
      "اسمعوني، كنت نايم من أول الليل ومحد شافني برّا.",
      "لو أنا القاتل، ليه أفتح فمي وأثير الشك عليّ؟",
      "اتهامي سهل، بس بكرة بتندمون وتعرفون إني كنت معكم.",
      "أنا معكم من أول جولة، وكل تصويتي راح على أهل الشر.",
      "خذوا وقتكم، أنا ما راح أهرب — بس لا تعلّقوني بلا دليل.",
      "وش دليلكم غير الحدس؟ الحدس ما يعلّق رقاب.",
      "أنا من أهل هالقرية قبل لا تصير فيها جثث، لا تنسون.",
      "علّقوني اليوم وبكرة يجيكم قتيل ثاني، وبتعرفون إني بريء.",
      "خلاص، صوّتوا عليّ، بس اسألوا نفسكم مين اللي وجّهكم لي.",
      "أنا أول من نبّهكم أمس، ومكافأتي اتهام؟",
      "والله ما لي علاقة، والقاتل قاعد يضحك علينا وإحنا نتخانق.",
      "دوّروا على اللي ساقكم لي، هو اللي يستفيد لا أنا.",
      "أنا واضح، كلامي واحد من أول ليلة.",
      "لا تستعجلون، الاستعجال سلاح المافيا مو سلاحنا."
    ], fusha: [
      "أنا بريء، وإن حكمتم عليّ اليوم فستكتشفون غدًا خطأكم.",
      "لم أخرج من داري ليلة أمس، ولا شاهد لديكم يقول غير ذلك.",
      "اتهامي لا يقوم على دليل، بل على ظنٍّ متسرّع.",
      "لو كنت القاتل لالتزمت الصمت، لا أن أنازعكم الحديث.",
      "أطلب من المجلس دليلًا واحدًا، ثم احكموا عليّ كما شئتم.",
      "من ساقكم إليّ هو من ينبغي أن تسألوه.",
      "لست خائفًا من الحكم، بل من ضياع الحقيقة معي.",
      "كنت أول المنبّهين بالأمس، فكيف أصير اليوم متّهمًا؟",
      "احكموا عليّ وستأتيكم جثة الليلة كما أتت من قبل.",
      "لن أزيد على قولي: أنا بريء، والوقت شاهدي."
    ] },
    f: { najdi: [
      "أنا بريئة والله، وتصويتكم عليّ يضيّع عليكم القاتل الحقيقي.",
      "اسمعوني، كنت نايمة من أول الليل ومحد شافني برّا.",
      "لو أنا القاتلة، ليه أفتح فمي وأثير الشك عليّ؟",
      "اتهامي سهل، بس بكرة بتندمون وتعرفون إني كنت معكم.",
      "أنا معكم من أول جولة، وكل تصويتي راح على أهل الشر.",
      "خذوا وقتكم، أنا ما راح أهرب — بس لا تعلّقوني بلا دليل.",
      "وش دليلكم غير الحدس؟ الحدس ما يعلّق رقاب.",
      "أنا من أهل هالقرية قبل لا تصير فيها جثث، لا تنسون.",
      "علّقوني اليوم وبكرة يجيكم قتيل ثاني، وبتعرفون إني بريئة.",
      "خلاص، صوّتوا عليّ، بس اسألوا نفسكم مين اللي وجّهكم لي.",
      "أنا أول من نبّهتكم أمس، ومكافأتي اتهام؟",
      "والله ما لي علاقة، والقاتل قاعد يضحك علينا وإحنا نتخانق.",
      "دوّروا على اللي ساقكم لي، هو اللي يستفيد لا أنا.",
      "أنا واضحة، كلامي واحد من أول ليلة.",
      "لا تستعجلون، الاستعجال سلاح المافيا مو سلاحنا."
    ], fusha: [
      "أنا بريئة، وإن حكمتم عليّ اليوم فستكتشفون غدًا خطأكم.",
      "لم أخرج من داري ليلة أمس، ولا شاهد لديكم يقول غير ذلك.",
      "اتهامي لا يقوم على دليل، بل على ظنٍّ متسرّع.",
      "لو كنت القاتلة لالتزمت الصمت، لا أن أنازعكم الحديث.",
      "أطلب من المجلس دليلًا واحدًا، ثم احكموا عليّ كما شئتم.",
      "من ساقكم إليّ هو من ينبغي أن تسألوه.",
      "لست خائفة من الحكم، بل من ضياع الحقيقة معي.",
      "كنت أول المنبّهات بالأمس، فكيف أصير اليوم متّهمة؟",
      "احكموا عليّ وستأتيكم جثة الليلة كما أتت من قبل.",
      "لن أزيد على قولي: أنا بريئة، والوقت شاهدي."
    ] }
  },

  // ─────────── شك عام: بلا هدف، ومحايدة لجنس المتكلّم ───────────
  suspect: {
    najdi: [
      "فيه شي غلط بهالقرية، وإحنا ما نبي نشوفه.",
      "الليلة الجاية بتكشف كل شي، بس بشرط نصحى الحين.",
      "خلّونا نراجع كلام كل واحد من أول جولة، الخيط موجود.",
      "القاتل قاعد بينّا ويسمع كلامنا الحين.",
      "أكثر واحد ساكت هو أكثر واحد يستفيد.",
      "لا تتسرعون، صوت واحد غلط يكلّفنا القرية كلها.",
      "مين شاف شي أمس بالليل؟ ولو شي بسيط.",
      "التصويت العشوائي هدية للمافيا، خلّونا نفكر.",
      "ما أثق بأحد اليوم، ولا بنفسي.",
      "الأصوات اللي راحت أمس، مين وجّهها؟ هذا هو السؤال.",
      "لاحظوا مين يستعجل ومين يهدّي، وبتعرفون كثير.",
      "القرية تصغر كل ليلة وإحنا نلف بنفس الدايرة.",
      "كل واحد يقول وش سوّى أمس بالضبط، وبنقارن.",
      "الصمت اليوم غالي، والكلام أغلى.",
      "أشك باللي يوافق الكل، الموافقة الزايدة مريبة.",
      "خلّونا نبدأ بالأسئلة قبل الاتهامات.",
      "المافيا تحب الفوضى، فخلّونا نمشي بترتيب.",
      "من نجا ليلتين ورا بعض بلا خدش، يستاهل سؤال.",
      "الحقيقة قدامنا، بس محد يبي يشوفها.",
      "ما نبي نعلّق بريء اليوم ونخسر مرتين."
    ],
    fusha: [
      "في القرية خللٌ لا يخفى، ولكن أحدًا لا يريد قوله.",
      "القاتل بيننا الآن، يسمع كل كلمة نقولها.",
      "لنراجع أقوال كل واحد منذ الليلة الأولى، فالخيط موجود.",
      "التصويت العشوائي هديةٌ للمافيا، فلنُعمل العقل.",
      "من نجا ليلتين متتاليتين دون أذى يستحق سؤالًا.",
      "الصمت اليوم مكلف، والكلام أنفع.",
      "لنبدأ بالأسئلة قبل أن نبدأ بالأحكام.",
      "أكثر الناس موافقةً لكل رأي أقلّهم صدقًا.",
      "القرية تنقص كل ليلة ونحن ندور في الحلقة ذاتها.",
      "من وجّه أصوات الأمس هو من يجب أن نبدأ به.",
      "لا أثق بأحد اليوم، ولا أطلب من أحد أن يثق بي.",
      "الفوضى سلاح المافيا، فلنلتزم الترتيب.",
      "ليقل كل واحد أين كان ليلة أمس، ثم نقارن.",
      "الحقيقة أمامنا، لكنّ الخوف يحجبها.",
      "لنضيّق الدائرة بالمنطق لا بالحماس.",
      "خسارة بريء اليوم تعني خسارتين: هو، والليلة القادمة."
    ]
  },

  // ─────────── كلام بعد قتيل الفجر: {t} = القتيل، مطابق لجنسه ───────────
  dawn: {
    m: { najdi: [
      "الله يرحمك يا {t}... رحت وأنت أنقى واحد فينا.",
      "{t} ما كان يستاهل هالنهاية، والقاتل قاعد بينّا.",
      "أمس كان {t} يضحك معنا، واليوم اسمه بالقايمة السودا.",
      "خذوا {t} مثال: القاتل يختار الأقرب لنا.",
      "ليه {t} بالذات؟ الجواب يوصّلنا للقاتل.",
      "دم {t} ما يروح هدر، لازم نطلع بقرار اليوم.",
      "{t} راح، ومين بعده لو نمنا اليوم زي أمس؟",
      "شوفوا مين ما تأثر بموت {t}، وابدأوا منه.",
      "لسّه ما صدّقت إن {t} ما راح يجلس معنا."
    ], fusha: [
      "رحمة الله على {t}، فقدنا صوتًا صادقًا في هذا المجلس.",
      "لم يكن {t} يستحق هذه النهاية، وقاتله بيننا الآن.",
      "لماذا {t} تحديدًا؟ في الجواب دليلٌ على الفاعل.",
      "دم {t} أمانة في أعناقنا، فلا نضيّع اليوم.",
      "انظروا إلى من لم يتأثّر بموت {t}، ومنه ابدأوا.",
      "بالأمس كان {t} يجلس بيننا، واليوم نعدّ أسماءنا الناقصة.",
      "سقط {t} في الظلام، ولن نهنأ حتى ينكشف من أسقطه."
    ] },
    f: { najdi: [
      "الله يرحمك يا {t}... رحتي وأنتِ أنقى وحدة فينا.",
      "{t} ما كانت تستاهل هالنهاية، والقاتل قاعد بينّا.",
      "أمس كانت {t} تضحك معنا، واليوم اسمها بالقايمة السودا.",
      "خذوا {t} مثال: القاتل يختار الأقرب لنا.",
      "ليه {t} بالذات؟ الجواب يوصّلنا للقاتل.",
      "دم {t} ما يروح هدر، لازم نطلع بقرار اليوم.",
      "{t} راحت، ومين بعدها لو نمنا اليوم زي أمس؟",
      "شوفوا مين ما تأثر بموت {t}، وابدأوا منه.",
      "لسّه ما صدّقت إن {t} ما راح تجلس معنا."
    ], fusha: [
      "رحمة الله على {t}، فقدنا صوتًا صادقًا في هذا المجلس.",
      "لم تكن {t} تستحق هذه النهاية، وقاتلها بيننا الآن.",
      "لماذا {t} تحديدًا؟ في الجواب دليلٌ على الفاعل.",
      "دم {t} أمانة في أعناقنا، فلا نضيّع اليوم.",
      "انظروا إلى من لم يتأثّر بموت {t}، ومنه ابدأوا.",
      "بالأمس كانت {t} تجلس بيننا، واليوم نعدّ أسماءنا الناقصة.",
      "سقطت {t} في الظلام، ولن نهنأ حتى ينكشف من أسقطها."
    ] },
    any: { najdi: [
      "الدم اللي بالميدان مو دم غريب — واحد منّا سوّاه.",
      "ما نبي ندفن أحد ثاني بكرة، اليوم لازم نقرر.",
      "القاتل نام مرتاح، وإحنا نعد الأسماء.",
      "كل فجر ينقص واحد، وكل يوم نضيّعه بالكلام.",
      "الجثة تتكلم لو أحد فينا يسمع."
    ], fusha: [
      "الدم الذي في الميدان ليس دم غريب، بل من بيننا.",
      "لن ندفن أحدًا آخر غدًا، فليكن قرارنا اليوم.",
      "ينقص فجرنا واحدًا كل ليلة، ونضيّع نهارنا في الجدل.",
      "الجثة تنطق لو أصغى إليها أحد."
    ] }
  },

  // ─────────── ليلة بلا قتيل ───────────
  quiet: {
    najdi: [
      "الفجر طلع بلا قتيل — يا أحد حماه، يا القاتل غيّر خطته.",
      "ليلة بلا دم ما تعني إننا بأمان، بالعكس.",
      "محد راح الليلة، بس لا تفرحون بدري.",
      "أول ليلة يفشل فيها القاتل، وهذا يقول إن أحدنا يشتغل صح."
    ],
    fusha: [
      "طلع الفجر ولا جثة — إمّا حماه أحدنا، وإمّا غيّر القاتل خطته.",
      "ليلةٌ بلا دم لا تعني أننا في أمان.",
      "لم نفقد أحدًا الليلة، فلا يغرّنا الهدوء.",
      "فشل القاتل الليلة، وهذا يعني أن أحدنا يحسن دوره."
    ]
  }
};

// يختار جملة بلهجة القائل، مع مطابقة الجنس المطلوب (المتهَم/القتيل للاتهام والفجر، والمتكلّم للدفاع)
function mafiaPick(kind, dialect, gender) {
  const d = (dialect === 'fusha') ? 'fusha' : 'najdi';
  const g = (gender === 'f') ? 'f' : 'm';
  const node = MAFIA_LINES[kind];
  if (!node) return null;
  let pool;
  if (kind === 'accuse' || kind === 'dawn') {
    pool = (node[g][d] || []).concat(node.any ? (node.any[d] || []) : []);
  } else if (kind === 'defend') {
    pool = node[g][d] || [];
  } else {
    pool = node[d] || [];
  }
  if (!pool.length) pool = MAFIA_LINES.suspect[d];
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

export class MafiaRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map(); // playerId -> WebSocket
    this.state.blockConcurrencyWhile(async () => {
      this.room = (await this.state.storage.get('room')) || {
        code: null,
        hostId: null,
        phase: 'lobby', // lobby | night | day | over
        players: [],    // {id, name, gender, alive, role, twinId, connected}
        config: {
          mafia: 1, doctor: true, detective: true, heir: false,
          spy: false, witch: false, avenger: false, trap: false, twins: false,
        },
        nightActions: {},
        dayVotes: {},
        dayNum: 1,
        lastDeaths: [],
      };
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/ws')) {
      return this.handleWebSocket(request);
    }
    if (url.pathname.endsWith('/create')) {
      return this.handleCreate(request);
    }
    return new Response('غير موجود', { status: 404 });
  }

  async handleCreate(request) {
    let body;
    try { body = await request.json(); } catch { return new Response('bad-json', { status: 400 }); }
    const { name, gender, roomCode } = body || {};
    if (this.room.code && this.room.players.length && this.room.phase !== 'over') {
      return new Response('room-exists', { status: 409 });
    }
    this.room.code = roomCode;
    const hostId = crypto.randomUUID();
    const hostToken = newSeatToken();
    this.room.hostId = hostId;
    this.room.players = [{
      id: hostId, name: cleanName(name), gender: gender || 'm', alive: true,
      role: null, twinId: null, connected: false,
      seatToken: hostToken,
    }];
    await this.persist();
    // seatToken يعود للمضيف فقط في رد الإنشاء — هو مفتاح مقعده عند إعادة الاتصال
    return withCors(Response.json({ roomCode: this.room.code, playerId: hostId, seatToken: hostToken }));
  }

  async handleWebSocket(request) {
    const url = new URL(request.url);
    const playerId = url.searchParams.get('playerId');
    const name = url.searchParams.get('name');
    const gender = url.searchParams.get('gender') || 'm';

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('يتطلب WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    // ── الهوية بالتوكن السري فقط ──
    // كان: البحث بـ playerId القادم من الرابط. ومعرّفات كل اللاعبين تُبَث في
    // اللوبي، فأي لاعب كان يقدر يفتح اتصالًا بمعرّف غيره ويستقبل دوره السري.
    const token = url.searchParams.get('token');
    let player = this.seatByToken(token);

    if (player) {
      // عودة بمقعد قائم — نسمح بتغيير المعرّف (بعض المتصفحات تفقد التخزين)
      const oldId = player.id;
      const newId = (validPlayerId(playerId) && !this.room.players.some(p => p.id === playerId)) ? playerId : oldId;
      if (newId !== oldId && !this.room.players.some(p => p.id === newId)) {
        player.id = newId;
        if (this.room.hostId === oldId) this.room.hostId = newId;
        this.remapId(oldId, newId);
        const stale = this.sockets.get(oldId);
        if (stale) { try { stale.close(); } catch {} }
        this.sockets.delete(oldId);
      } else {
        const stale = this.sockets.get(oldId);
        if (stale && stale !== server) { try { stale.close(); } catch {} }
      }
    }

    // ع-١ · رمز لم تُنشأ له غرفة: لا نُنشئها من اتصال WebSocket.
    // بدون هذا يتجاوز المهاجم حدّ allowCreate بالكامل ويفرّخ غرفًا بلا سقف.
    if (!player && !this.room.code) {
      server.send(JSON.stringify({ type: 'error', message: 'ما فيه غرفة بهذا الرمز' }));
      server.close();
      return new Response(null, { status: 101, webSocket: client });
    }

    if (!player) {
      // لاعب جديد ينضم
      if (this.room.phase !== 'lobby') {
        server.send(JSON.stringify({ type: 'error', message: 'اللعبة بدأت، ما تقدر تنضم الحين' }));
        server.close();
        return new Response(null, { status: 101, webSocket: client });
      }
      if (this.room.players.length >= MAX_PLAYERS) {
        server.send(JSON.stringify({ type: 'error', message: 'الغرفة ممتلئة' }));
        server.close();
        return new Response(null, { status: 101, webSocket: client });
      }
      player = {
        id: crypto.randomUUID(), name: cleanName(name), gender,
        alive: true, role: null, twinId: null, connected: true,
        seatToken: newSeatToken(),
      };
      this.room.players.push(player);
    } else {
      player.connected = true;
    }
    if (!player.seatToken) player.seatToken = newSeatToken();

    this.sockets.set(player.id, server);
    server.addEventListener('message', (evt) => this.onMessage(player.id, evt));
    server.addEventListener('close', () => this.onClose(player.id));

    await this.persist();
    this.broadcastLobby();
    // إرسال حالة اللاعب الحالية له (مهم لو أعاد الاتصال بعد انقطاع)
    this.sendPrivate(player.id, {
      type: 'welcome', playerId: player.id, roomCode: this.room.code,
      seatToken: player.seatToken,
    });
    if (player.role) this.sendPrivate(player.id, this.roleMessageFor(player));
    if (this.room.phase !== 'lobby') this.sendRoundStateTo(player.id);

    return new Response(null, { status: 101, webSocket: client });
  }

  // نقل كل ما هو مرتبط بمعرّف قديم بعد إعادة الاتصال بتوكن
  remapId(oldId, newId) {
    const na = this.room.nightActions || {};
    if (na.mafiaVotes && oldId in na.mafiaVotes) {
      na.mafiaVotes[newId] = na.mafiaVotes[oldId];
      delete na.mafiaVotes[oldId];
    }
    if (na.mafiaVotes) {
      for (const k of Object.keys(na.mafiaVotes)) {
        if (na.mafiaVotes[k] === oldId) na.mafiaVotes[k] = newId;
      }
    }
    for (const k of ['doctorTarget','detectiveTarget','spyTarget','witchSaveTarget','witchPoisonTarget']) {
      if (na[k] === oldId) na[k] = newId;
    }
    const dv = this.room.dayVotes || {};
    if (oldId in dv) { dv[newId] = dv[oldId]; delete dv[oldId]; }
    for (const k of Object.keys(dv)) if (dv[k] === oldId) dv[k] = newId;
    for (const p of this.room.players) {
      if (p.twinId === oldId) p.twinId = newId;
      if (p.revengeTargetId === oldId) p.revengeTargetId = newId;
    }
  }

  async onMessage(playerId, evt) {
    if (!this.allowMsg(playerId)) return;   // خنق: ١٢ رسالة/ثانية
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'updateConfig' && playerId === this.room.hostId) {
      // مفاتيح معروفة فقط — Object.assign كان يسمح بحقن أي مفتاح وأي حجم
      this.room.config = sanitizeMafiaConfig(msg.config);
      await this.persist();
      this.broadcastLobby();
    }

    if (msg.type === 'kickPlayer' && playerId === this.room.hostId && this.room.phase === 'lobby') {
      await this.kickPlayer(msg.targetId);
    }

    if (msg.type === 'addBot' && playerId === this.room.hostId && this.room.phase === 'lobby') {
      await this.addBot(msg.gender, msg.dialect);
    }

    if (msg.type === 'removeBot' && playerId === this.room.hostId && this.room.phase === 'lobby') {
      await this.removeBot(msg.targetId);
    }

    if (msg.type === 'startGame' && playerId === this.room.hostId) {
      await this.startGame();
    }

    if (msg.type === 'nightAction' && this.room.phase === 'night') {
      await this.handleNightAction(playerId, msg);
    }

    if (msg.type === 'startVoting' && playerId === this.room.hostId && this.room.phase === 'day') {
      await this.startVoting();
    }

    if (msg.type === 'vote' && this.room.phase === 'voting') {
      await this.handleVote(playerId, msg.targetId);
    }

    if (msg.type === 'skipVote' && this.room.phase === 'voting') {
      await this.handleVote(playerId, null);
    }

    if (msg.type === 'hostForceAdvance' && playerId === this.room.hostId) {
      await this.forceAdvance();
    }
  }

  async onClose(playerId) {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) player.connected = false;
    this.sockets.delete(playerId);
    this.migrateHostIfNeeded();
    await this.persist();
    this.broadcastLobby();
    await this.maybeAdvanceOnDisconnect();
  }

  // نقل المضيف تلقائيًا لو انقطع — بدونها تتجمّد الغرفة نهائيًا
  migrateHostIfNeeded() {
    const host = this.room.players.find(p => p.id === this.room.hostId);
    if (host && host.connected) return false;
    const next = this.room.players.find(p => p.connected && !p.isBot && p.id !== this.room.hostId);
    if (!next) return false;
    this.room.hostId = next.id;
    this.broadcastPublic({ type: 'hostChanged', hostId: next.id, hostName: next.name });
    return true;
  }

  // لو كان المنقطع آخر من ننتظره، نحسم المرحلة بدل ما تعلّق
  async maybeAdvanceOnDisconnect() {
    if (this.room.phase === 'night' && this.allNightActionsIn()) await this.resolveNight();
    else if (this.room.phase === 'voting' && this.votesComplete()) await this.resolveVote();
  }

  async kickPlayer(targetId) {
    if (targetId === this.room.hostId) return; // المضيف ما يقدر يطرد نفسه
    const target = this.room.players.find(p => p.id === targetId);
    if (!target) return;
    this.sendPrivate(targetId, { type: 'kicked' });
    const ws = this.sockets.get(targetId);
    if (ws) { try { ws.close(); } catch {} this.sockets.delete(targetId); }
    this.room.players = this.room.players.filter(p => p.id !== targetId);
    await this.persist();
    this.broadcastLobby();
  }

  async addBot(wanted, dialect) {
    if (this.room.players.length >= MAX_PLAYERS) {
      this.sendPrivate(this.room.hostId, { type: 'error', message: 'الغرفة ممتلئة' });
      return;
    }
    // الجنس يحدده المضيف عشان جُمل البوت تكون مطابقة؛ وإن ما حدد نختار عشوائيًا
    const gender = (wanted === 'm' || wanted === 'f') ? wanted : (Math.random() < 0.5 ? 'm' : 'f');
    const used = new Set(this.room.players.map(p => p.name));
    // الاسم لازم يتبع الجنس — قبلها كانا يُختاران مستقلين فيطلع اسم ولد ببوت بنت
    const pool = gender === 'f' ? BOT_NAMES_F : BOT_NAMES_M;
    const name = pool.find(n => !used.has(n))
      || BOT_NAMES.find(n => !used.has(n))
      || ('بوت' + (this.room.players.length + 1));
    this.room.players.push({
      id: 'bot-' + crypto.randomUUID(), name, gender, alive: true,
      role: null, twinId: null, connected: true, isBot: true,
      // اللهجة تتبع اختيار المضيف — وإلا نوّعنا بين نجدي وفصحى
      dialect: (dialect === 'fusha' || dialect === 'najdi') ? dialect : (Math.random() < 0.5 ? 'fusha' : 'najdi'),
    });
    await this.persist();
    this.broadcastLobby();
  }

  async removeBot(targetId) {
    const target = this.room.players.find(p => p.id === targetId);
    if (!target || !target.isBot) return;
    this.room.players = this.room.players.filter(p => p.id !== targetId);
    await this.persist();
    this.broadcastLobby();
  }

  async startGame() {
    // بدون هذا الشرط يقدر المضيف يعيد توزيع الأدوار في نص اللعبة
    if (this.room.phase !== 'lobby' && this.room.phase !== 'over') return;
    const n = this.room.players.length;
    if (n < 4) {
      this.sendPrivate(this.room.hostId, { type: 'error', message: 'أقل عدد للبدء ٤ لاعبين' });
      return;
    }
    const need = neededSeats(this.room.config);
    if (need > n) {
      this.sendPrivate(this.room.hostId, { type: 'error',
        message: `الأدوار المفعّلة تحتاج ${need} لاعبين وعندك ${n} — قلّل الأدوار أو زد اللاعبين` });
      return;
    }
    const { roles, hasTwins } = buildRoleList(this.room.config, n);
    shuffle(roles);
    this.room.players.forEach((p, i) => {
      p.role = roles[i];
      p.alive = true;
      p.twinId = null;
      p.usedSave = false; p.usedPoison = false;
      /* بدون تصفير المعلّق: لعبة انتهت والساحرة عندها إنقاذ معلّق تُحرق
         قدرتها في اللعبة الجاية على لاعب ما اختارها */
      p.pendingWitchSave = false; p.pendingWitchPoison = false;
      p.revengeTargetId = null;
    });
    // ربط التوأمين حسب الدور الفعلي بعد الخلط (مو حسب موضعهم قبله)
    if (hasTwins) {
      const twins = this.room.players.filter(p => p.role === 'twin_good' || p.role === 'twin_evil');
      if (twins.length === 2) {
        twins[0].twinId = twins[1].id;
        twins[1].twinId = twins[0].id;
      }
    }
    // تصفير حالة اللعبة السابقة — بدونه تُحسم أول ليلة بأهداف الجولة الماضية
    this.room.firstDeathDone = false;
    this.room.nightActions = {};
    this.room.dayVotes = {};
    this.room.lastDeaths = [];
    this.room.phase = 'night';
    this.room.dayNum = 1;
    await this.persist();

    // كل لاعب يستقبل دوره الخاص فقط — ما حد غيره يشوفه
    for (const p of this.room.players) {
      this.sendPrivate(p.id, this.roleMessageFor(p));
    }
    this.autoBotNightActions();
    this.broadcastPublic({ type: 'phaseChanged', phase: 'night', dayNum: 1 });
    this.sendAvengerInfo();
    if (this.allNightActionsIn()) await this.resolveNight();
  }

  // ═══════════ مساعدات ═══════════
  alivePlayers() { return this.room.players.filter(p => p.alive); }
  findPlayer(id) { return this.room.players.find(p => p.id === id); }
  isAliveRole(role) {
    return this.alivePlayers().some(p => p.role === role);
  }
  // البوت حاضر دائمًا؛ اللاعب الحقيقي لازم يكون متصلًا — وإلا علّق الدور اللعبة
  isHere(p) { return !!p && (p.isBot || p.connected); }
  presentRole(role) { return this.alivePlayers().some(p => p.role === role && this.isHere(p)); }
  votersExpected() { return this.alivePlayers().filter(p => this.isHere(p)).length; }
  votesComplete() {
    const exp = this.votersExpected();
    return exp > 0 && Object.keys(this.room.dayVotes).length >= exp;
  }

  // البوتات تقرر أفعالها تلقائيًا فور دخول الليل — بنفس شكل رسائل اللاعبين الحقيقيين
  autoBotNightActions() {
    const na = this.room.nightActions;
    const alive = this.alivePlayers();
    for (const bot of alive.filter(p => p.isBot)) {
      const others = alive.filter(p => p.id !== bot.id);
      if (!others.length) continue;
      switch (bot.role) {
        case 'mafia': {
          const targets = alive.filter(p => p.role !== 'mafia');
          if (targets.length) { na.mafiaVotes = na.mafiaVotes || {}; na.mafiaVotes[bot.id] = pickRandom(targets).id; }
          break;
        }
        case 'doctor':
          if (na.doctorTarget === undefined) na.doctorTarget = pickRandom(alive).id;
          break;
        case 'detective':
          if (na.detectiveTarget === undefined) na.detectiveTarget = pickRandom(others).id;
          break;
        case 'spy':
          if (na.spyTarget === undefined) na.spyTarget = pickRandom(others).id;
          break;
        case 'witch':
          if (!bot.usedSave && Math.random() < 0.4) { na.witchSaveTarget = pickRandom(alive).id; bot.pendingWitchSave = true; }
          else if (!bot.usedPoison && Math.random() < 0.25) { na.witchPoisonTarget = pickRandom(others).id; bot.pendingWitchPoison = true; }
          na.witchResponded = true; // البوت حسم أمره — عشان ما يعلّق الليل
          break;
        case 'avenger':
          // المنتقم يختار/يغيّر هدف انتقامه، أو يتخطّى ويبقي هدفه السابق
          if (Math.random() < 0.7) bot.revengeTargetId = pickRandom(others).id;
          na.avengerResponded = true;
          break;
      }
    }
  }

  // البوتات تصوّت تلقائيًا فور دخول مرحلة التصويت
  autoBotVotes() {
    const alive = this.alivePlayers();
    for (const bot of alive.filter(p => p.isBot)) {
      if (this.room.dayVotes[bot.id] !== undefined) continue;
      let others = alive.filter(p => p.id !== bot.id);
      // بوت المافيا ما يصوّت على رفيقه إن لقى غيره
      if (bot.role === 'mafia') {
        const outsiders = others.filter(p => p.role !== 'mafia');
        if (outsiders.length) others = outsiders;
      }
      // ٨٠٪ يصوّتون لأحد، ٢٠٪ يمتنعون — لتنويع طبيعي
      this.room.dayVotes[bot.id] = (others.length && Math.random() < 0.8) ? pickRandom(others).id : null;
    }
  }

  // ═══════════ كلام البوتات ═══════════
  // الجملة تُبنى بلهجة البوت، والجنس المطلوب يختلف حسب النوع:
  // اتهام/فجر → جنس المذكور، دفاع → جنس البوت نفسه، شك عام → بلا جنس
  botSay(bot, kind, target) {
    const gender = (kind === 'defend') ? bot.gender : (target ? target.gender : 'm');
    let txt = mafiaPick(kind, bot.dialect || 'najdi', gender);
    if (!txt) return;
    txt = txt.split('{t}').join(target ? target.name : 'أحدهم');
    this.broadcastPublic({
      type: 'botSpeak', id: bot.id, name: bot.name, gender: bot.gender,
      kind, text: txt, phase: this.room.phase, dayNum: this.room.dayNum,
    });
  }

  // ينطقون بالترتيب بدون ما يتكلم الكل — عشان لا يصير اللوح ضجيج
  speakingBots(max) {
    const bots = this.alivePlayers().filter(p => p.isBot);
    return shuffle(bots.slice()).slice(0, Math.max(0, Math.min(max, bots.length)));
  }

  // بعد الفجر: تعليق على القتيل (أو على ليلة بلا دم) + شك عام
  botsTalkDawn() {
    const deaths = this.room.lastDeaths || [];
    const victim = deaths.length ? this.findPlayer(deaths[0].id) : null;
    const speakers = this.speakingBots(deaths.length ? 3 : 2);
    speakers.forEach((bot, i) => {
      if (i === 0) {
        if (victim) this.botSay(bot, 'dawn', victim);
        else this.botSay(bot, 'quiet', null);
      } else {
        this.botSay(bot, 'suspect', null);
      }
    });
  }

  // عند التصويت: اتهام لمن صوّت عليه، ثم دفاع ممن اتُّهم
  botsTalkVoting() {
    const accused = new Set();
    for (const bot of this.speakingBots(3)) {
      const tid = this.room.dayVotes[bot.id];
      const target = tid ? this.findPlayer(tid) : null;
      if (target && target.alive) { this.botSay(bot, 'accuse', target); accused.add(target.id); }
      else this.botSay(bot, 'suspect', null);
    }
    for (const id of accused) {
      const p = this.findPlayer(id);
      if (p && p.isBot && p.alive && Math.random() < 0.85) this.botSay(p, 'defend', null);
    }
  }

  // ═══════════ مرحلة الليل ═══════════
  async handleNightAction(playerId, msg) {
    const player = this.findPlayer(playerId);
    if (!player || !player.alive) return;
    const na = this.room.nightActions;

    // الهدف لازم يكون لاعبًا حقيقيًا حيًّا — كان أي نص يُقبل ويُخزَّن
    if (msg.targetId != null) {
      const tgt = this.findPlayer(msg.targetId);
      if (!tgt || !tgt.alive) { msg = { ...msg, targetId: null }; }
    }

    switch (player.role) {
      case 'mafia':
        // بدون هذا: هدف غير صالح يُخزَّن كـ null، و allNightActionsIn
        // ينتظر صوتًا ما يجي أبدًا فتعلّق الليلة على الجميع
        if (!msg.targetId) {
          this.sendPrivate(playerId, { type: 'error', message: 'اختر هدفًا حيًّا' });
          return;
        }
        na.mafiaVotes = na.mafiaVotes || {};
        na.mafiaVotes[playerId] = msg.targetId;
        break;
      case 'doctor':
        na.doctorTarget = msg.targetId;
        break;
      case 'detective':
        na.detectiveTarget = msg.targetId;
        break;
      case 'spy':
        na.spyTarget = msg.targetId;
        break;
      case 'witch':
        // لازم ردّ صريح كل ليلة: إنقاذ أو سُم أو تخطّي — عشان ما يُحسم الليل من تحتها
        if (msg.action === 'save' && !player.usedSave) {
          na.witchSaveTarget = msg.targetId; player.pendingWitchSave = true;
        } else if (msg.action === 'poison' && !player.usedPoison) {
          na.witchPoisonTarget = msg.targetId; player.pendingWitchPoison = true;
        } else if (msg.action === 'skip') {
          // تخطّي: ما تستخدم شي هذي الليلة
        } else {
          this.sendPrivate(playerId, { type: 'error', message: 'هذي القدرة انتهت — اختر غيرها أو تخطَّ' });
          return;
        }
        na.witchResponded = true;
        break;
      case 'avenger':
        // يختار/يغيّر هدف انتقامه (يموت معه لو مات)، أو يتخطّى فيبقى هدفه السابق
        if (msg.action === 'skip') {
          // تخطّي: الهدف السابق يبقى كما هو
        } else if (msg.targetId && msg.targetId !== playerId) {
          player.revengeTargetId = msg.targetId;
        } else {
          this.sendPrivate(playerId, { type: 'error', message: 'اختر شخصًا غيرك أو تخطَّ' });
          return;
        }
        na.avengerResponded = true;
        break;
    }
    await this.persist();

    // نتحقق هل خلص الجميع أفعالهم عشان نحسم الليل تلقائيًا
    if (this.allNightActionsIn()) await this.resolveNight();
  }

  allNightActionsIn() {
    const na = this.room.nightActions;
    const alive = this.alivePlayers();
    const mafiaAlive = alive.filter(p => p.role === 'mafia' && this.isHere(p));
    if (mafiaAlive.length && !mafiaAlive.every(p => (na.mafiaVotes || {})[p.id])) return false;
    if (this.presentRole('doctor') && na.doctorTarget === undefined) return false;
    if (this.presentRole('detective') && na.detectiveTarget === undefined) return false;
    if (this.presentRole('spy') && na.spyTarget === undefined) return false;
    // ننتظر ردًّا صريحًا من الساحرة (إلا لو انتهت قدرتاها) ومن المنتقم كل ليلة
    const witch = alive.find(p => p.role === 'witch' && this.isHere(p));
    if (witch && !(witch.usedSave && witch.usedPoison) && !na.witchResponded) return false;
    const avenger = alive.find(p => p.role === 'avenger' && this.isHere(p));
    if (avenger && !na.avengerResponded) return false;
    return true;
  }

  async resolveNight() {
    // حماية من الحسم المزدوج (مثلًا آخر فعل يصل بنفس لحظة "تقديم قسري")
    if (this.room.phase !== 'night') return;
    this.room.phase = 'resolvingNight';
    const na = this.room.nightActions;
    const deaths = new Set();

    // حسم تصويت المافيا (أغلبية، مع كسر تعادل عشوائي)
    let killedByMafia = null;
    if (na.mafiaVotes && Object.keys(na.mafiaVotes).length) {
      const tally = {};
      // الصوت الفاضي كان يصير مفتاحًا اسمه "null" ويربح الأغلبية أحيانًا
      for (const t of Object.values(na.mafiaVotes)) { if (!t) continue; tally[t] = (tally[t] || 0) + 1; }
      const keys = Object.keys(tally);
      if (keys.length) {
        const max = Math.max(...keys.map(k => tally[k]));
        const top = keys.filter(k => tally[k] === max);
        killedByMafia = top[Math.floor(Math.random() * top.length)];
      }
    }

    // نثبّت الفاحصين الحقيقيين قبل تنفيذ أي وفاة — عشان لا تُسلّم النتيجة لوريث ورث الدور توًّا
    const detectiveActor = this.alivePlayers().find(p => p.role === 'detective');
    const spyActor = this.alivePlayers().find(p => p.role === 'spy');

    // الفخ الصامت: لو المحقق أو الجاسوس حقق فيه، الفاحص نفسه يموت ولا يحصل على نتيجة
    let detectiveResult = null, spyResult = null;
    if (na.detectiveTarget) {
      const target = this.findPlayer(na.detectiveTarget);
      if (target && target.role === 'trap') {
        if (detectiveActor) deaths.add(detectiveActor.id);
      } else if (target) {
        detectiveResult = { targetId: target.id, targetName: target.name, team: ROLES[target.role].team };
      }
    }
    if (na.spyTarget) {
      const target = this.findPlayer(na.spyTarget);
      if (target && target.role === 'trap') {
        if (spyActor) deaths.add(spyActor.id);
      } else if (target) {
        spyResult = { targetId: target.id, targetName: target.name, role: target.role, roleName: ROLES[target.role].name };
      }
    }

    // تطبيق قتل المافيا، إلا لو الطبيب أنقذ نفس الهدف أو الساحرة أنقذته
    if (killedByMafia && killedByMafia !== na.doctorTarget && killedByMafia !== na.witchSaveTarget) {
      deaths.add(killedByMafia);
    }
    // سُم الساحرة
    if (na.witchPoisonTarget) deaths.add(na.witchPoisonTarget);

    // تثبيت استخدام قدرات الساحرة لمرة واحدة
    const witch = this.room.players.find(p => p.pendingWitchSave || p.pendingWitchPoison);
    if (witch) {
      if (witch.pendingWitchSave) witch.usedSave = true;
      if (witch.pendingWitchPoison) witch.usedPoison = true;
      witch.pendingWitchSave = false; witch.pendingWitchPoison = false;
    }

    // تنفيذ الوفيات + ترقية الوريث لو المحقق مات
    const deadNames = [];
    for (const id of deaths) {
      this.killPlayer(this.findPlayer(id), deadNames);
    }

    // النتيجة تروح للفاحص الحقيقي نفسه، وفقط لو نجا هذي الليلة — لا تُورَّث
    if (detectiveResult && detectiveActor && detectiveActor.alive) {
      this.sendPrivate(detectiveActor.id, { type: 'investigateResult', ...detectiveResult });
    }
    if (spyResult && spyActor && spyActor.alive) {
      this.sendPrivate(spyActor.id, { type: 'spyResult', ...spyResult });
    }

    this.room.nightActions = {};
    this.room.phase = 'day';
    this.room.lastDeaths = deadNames.map(d => ({ id: d.id, name: d.name, twin: !!d.twin, revenge: !!d.revenge }));
    await this.persist();

    this.broadcastPublic({
      type: 'dawnResult',
      dayNum: this.room.dayNum,
      deaths: this.room.lastDeaths, // بالعلن: الاسم بس، بدون كشف الدور
    });
    this.broadcastLobby(); // لتحديث حالة alive بواجهة كل لاعب
    this.botsTalkDawn();

    const winner = this.checkWinCondition();
    if (winner) await this.endGame(winner);
  }

  // قتل موحّد: وراثة الوريث على أول وفاة، يسحب التوأم معه، والمنتقم يسحب هدف انتقامه
  killPlayer(p, out, reason) {
    if (!p || !p.alive) return;
    p.alive = false;
    const entry = { id: p.id, name: p.name, role: p.role, roleName: ROLES[p.role].name };
    if (reason) entry[reason] = true;
    out.push(entry);
    this.tryInherit(p);

    // التوأم يموت مع توأمه
    if (p.twinId) {
      const twin = this.findPlayer(p.twinId);
      if (twin && twin.alive) {
        this.killPlayer(twin, out, 'twin');
        this.sendPrivate(twin.id, { type: 'twinDied' });
      }
    }

    // المنتقم الأعمى: أي سبب موت يسحب هدف انتقامه معه، والسلسلة تُطبّق تعاقبيًا
    if (p.role === 'avenger' && p.revengeTargetId) {
      const victim = this.findPlayer(p.revengeTargetId);
      if (victim && victim.alive) this.killPlayer(victim, out, 'revenge');
    }
  }

  // الوريث يرث دور وفريق أول من يموت باللعبة — مرة واحدة فقط، أيًّا كان دوره أو فريقه
  tryInherit(deadPlayer) {
    if (this.room.firstDeathDone) return;
    this.room.firstDeathDone = true;
    const heir = this.room.players.find(p => p.alive && p.role === 'heir');
    if (!heir || heir.id === deadPlayer.id) return;
    heir.role = deadPlayer.role;
    heir.twinId = null; // ما يرث ارتباط التوأم — التوأم الآخر مات معه أصلًا
    const info = ROLES[heir.role];
    const payload = {
      type: 'roleChanged', role: heir.role, roleName: info.name, team: info.team,
      note: `مات ${deadPlayer.name} — ورثت دوره: ${info.name}`,
    };
    // لو ورث المافيا لازم يعرف رفاقه، وإلا ما عرف يصوّت وعلّقت الليلة
    if (heir.role === 'mafia') {
      payload.mafiaNames = this.room.players
        .filter(p => p.alive && p.role === 'mafia' && p.id !== heir.id)
        .map(p => p.name);
    }
    this.sendPrivate(heir.id, payload);
  }

  // ═══════════ مرحلة النهار / التصويت ═══════════
  async startVoting() {
    this.room.phase = 'voting';
    this.room.dayVotes = {};
    this.autoBotVotes();
    await this.persist();
    this.broadcastPublic({ type: 'phaseChanged', phase: 'voting', dayNum: this.room.dayNum });
    this.botsTalkVoting();
    if (this.votesComplete()) await this.resolveVote();
  }

  async handleVote(playerId, targetId) {
    const voter = this.findPlayer(playerId);
    if (!voter || !voter.alive) return;
    // الهدف لازم يكون لاعبًا حيًّا فعلًا — وإلا فاز اسم وهمي بالأغلبية وانتهى النهار بصمت
    if (targetId != null) {
      const t = this.findPlayer(targetId);
      if (!t || !t.alive) return;
    }
    this.room.dayVotes[playerId] = targetId; // null = امتناع
    await this.persist();
    this.broadcastPublic({
      type: 'voteUpdate',
      votesIn: Object.keys(this.room.dayVotes).length,
      totalAlive: this.votersExpected(),
    });
    if (this.votesComplete()) {
      await this.resolveVote();
    }
  }

  async resolveVote() {
    if (this.room.phase !== 'voting') return;
    this.room.phase = 'resolvingVote';
    const tally = {};
    for (const t of Object.values(this.room.dayVotes)) {
      if (!t) continue;
      tally[t] = (tally[t] || 0) + 1;
    }
    let executedId = null, executedName = null;
    const entries = Object.entries(tally);
    if (entries.length) {
      const max = Math.max(...entries.map(e => e[1]));
      const top = entries.filter(e => e[1] === max);
      if (top.length === 1) executedId = top[0][0]; // لازم أغلبية واضحة بدون تعادل
    }
    const execP = executedId ? this.findPlayer(executedId) : null;
    if (execP && execP.alive) {
      {
        const p = execP;
        const execDead = [];
        this.killPlayer(p, execDead);
        executedName = p.name;
        this.broadcastPublic({
          type: 'executionResult', id: p.id, name: p.name, role: p.role, roleName: ROLES[p.role].name,
          // كل من سُحب معه — توأمًا كان أو هدف انتقام — لازم يُعلن، وإلا بقي ظاهرًا حيًّا
          alsoDead: execDead
            .filter(d => d.id !== p.id)
            .map(d => ({ id: d.id, name: d.name, roleName: d.roleName, twin: !!d.twin, revenge: !!d.revenge })),
        });
      }
    } else {
      // يشمل التعادل وأي هدف لم يعد صالحًا — لازم يوصل بث للواجهة في الحالتين
      this.broadcastPublic({ type: 'executionResult', id: null, name: null, message: 'تعادل الأصوات — ما حد أُعدم اليوم' });
    }

    this.broadcastLobby();
    const winner = this.checkWinCondition();
    if (winner) { await this.endGame(winner); return; }

    this.room.dayNum++;
    this.room.phase = 'night';
    this.room.nightActions = {};
    this.autoBotNightActions();
    await this.persist();
    this.broadcastPublic({ type: 'phaseChanged', phase: 'night', dayNum: this.room.dayNum });
    this.sendAvengerInfo();
    if (this.allNightActionsIn()) await this.resolveNight();
  }

  checkWinCondition() {
    const alive = this.alivePlayers();
    const evilCount = alive.filter(p => ROLES[p.role].team === 'evil').length;
    const goodCount = alive.length - evilCount;
    if (evilCount === 0) return 'good';
    if (evilCount >= goodCount) return 'evil';
    return null;
  }

  async endGame(winner) {
    this.room.phase = 'over';
    await this.persist();
    this.broadcastPublic({
      type: 'gameOver',
      winner, // 'good' | 'evil'
      players: this.room.players.map(p => ({ id: p.id, name: p.name, role: p.role, roleName: ROLES[p.role].name, alive: p.alive })),
    });
  }

  roleMessageFor(player) {
    const roleInfo = ROLES[player.role];
    const payload = {
      type: 'yourRole',
      role: player.role,
      roleName: roleInfo.name,
      team: roleInfo.team,
    };
    if (player.twinId) {
      const twin = this.room.players.find(p => p.id === player.twinId);
      payload.twinName = twin ? twin.name : null;
    }
    return payload;
  }

  // بث حالة اللوبي العلنية (بدون أي معلومات أدوار)
  broadcastLobby() {
    const publicPlayers = this.room.players.map(p => ({
      id: p.id, name: p.name, gender: p.gender, connected: p.connected, alive: p.alive, isBot: !!p.isBot,
    }));
    this.broadcastPublic({
      type: 'lobbyUpdate',
      players: publicPlayers,
      hostId: this.room.hostId,
      config: this.room.config,
    });
  }

  // إعادة إرسال حالة الجولة الحالية لمن أعاد الاتصال أثناء اللعب
  sendRoundStateTo(playerId) {
    if (this.room.phase === 'night' || this.room.phase === 'voting') {
      this.sendPrivate(playerId, { type: 'phaseChanged', phase: this.room.phase, dayNum: this.room.dayNum });
      const me = this.findPlayer(playerId);
      if (me && me.alive && me.role === 'avenger' && this.room.phase === 'night') this.sendAvengerInfo();
    } else if (this.room.phase === 'day') {
      this.sendPrivate(playerId, { type: 'dawnResult', dayNum: this.room.dayNum, deaths: this.room.lastDeaths || [] });
    }
  }

  // يخبر المنتقم بهدف انتقامه الحالي عشان الواجهة تعرضه وما يظن إنه ما اختار
  sendAvengerInfo() {
    const avenger = this.alivePlayers().find(p => p.role === 'avenger');
    if (!avenger) return;
    const t = avenger.revengeTargetId ? this.findPlayer(avenger.revengeTargetId) : null;
    this.sendPrivate(avenger.id, {
      type: 'avengerTargetInfo',
      targetId: (t && t.alive) ? t.id : null,
      targetName: (t && t.alive) ? t.name : null,
    });
  }

  // صمام أمان: المضيف يقدر يفرض حسم المرحلة لو علقت (مثلًا لاعب انقطع وما رجع)
  async forceAdvance() {
    if (this.room.phase === 'night') { await this.resolveNight(); return; }
    if (this.room.phase === 'voting') { await this.resolveVote(); return; }
    /* لو انقطع الحسم في نصّه بقيت الغرفة على طور مؤقّت ما يستقبل شيئًا —
       المضيف يقدر يخرجها منه بدل ما تموت الجلسة */
    if (this.room.phase === 'resolvingNight') {
      this.room.phase = 'day';
      this.room.nightActions = {};
      await this.persist();
      this.broadcastPublic({ type: 'dawnResult', dayNum: this.room.dayNum, deaths: this.room.lastDeaths || [] });
      this.broadcastLobby();
    } else if (this.room.phase === 'resolvingVote') {
      this.room.dayNum++;
      this.room.phase = 'night';
      this.room.nightActions = {};
      this.autoBotNightActions();
      await this.persist();
      this.broadcastPublic({ type: 'phaseChanged', phase: 'night', dayNum: this.room.dayNum });
      this.sendAvengerInfo();
      if (this.allNightActionsIn()) await this.resolveNight();
    }
  }

  broadcastPublic(payload) {
    const json = JSON.stringify(payload);
    for (const ws of this.sockets.values()) {
      try { ws.send(json); } catch {}
    }
  }

  sendPrivate(playerId, payload) {
    const ws = this.sockets.get(playerId);
    if (ws) { try { ws.send(JSON.stringify(payload)); } catch {} }
  }

  async persist() {
    await this.touchRoom();
    await this.state.storage.put('room', this.room);
  }
}

// ══════════════════════ نقطة الدخول الرئيسية للـ Worker ══════════════════════
// ══════════════════════ لمن العرش؟ — تعريف الأدوار (منقول من نسخة اللعب المحلي) ══════════════════════
const GOT_ROLES = {
  cersei:     { name:'سيرسي لانيستر', team:'lannister', icon:'🦁', desc:'سيف لانستر الخفي — تختار ضحية الليل إن كنتِ القائدة الحيّة.' },
  tywin:      { name:'تايوين لانيستر', team:'lannister', icon:'👑', desc:'زعيم لانستر — أنت من يقرر ضحية الليل.' },
  joffrey:    { name:'جوفري براثيون', team:'lannister', icon:'😈', desc:'الملك الصبي — واجهة لانستر، القرار الحقيقي بيد تايوين وسيرسي.' },
  varys:      { name:'فاريس',         team:'stark',     icon:'🕸️', desc:'كل ليلة تفحص شخصًا وتعرف ولاءه.' },
  melisandre: { name:'ميليساندرا',     team:'stark',     icon:'🔥', desc:'كل ليلة تحمي شخصًا، أو مرة واحدة بكل اللعبة تُحيي ميتًا.' },
  hound:      { name:'الهاوند',       team:'stark',     icon:'🐕', desc:'تحرس شخصًا كل ليلة — لو هوجم محروسك، تموت بدلًا عنه.' },
  baelish:    { name:'بيليش',         team:'neutral',   icon:'🃏', desc:'يعرف ولاء الجميع، وينحاز سرًّا لفريق بعد سقوط قتيلين.' },
  stark:      { name:'حرس وينترفيل',  team:'stark',     icon:'🐺', desc:'لا قدرات خاصة — سلاحك عقلك وصوتك بالتصويت.' },
  robb:       { name:'روب ستارك',     team:'stark',     icon:'⚔️', desc:'مرتبط بمصير تاليسا — إن ماتت مات معها.' },
  talisa:     { name:'تاليسا ستارك',  team:'stark',     icon:'💞', desc:'مرتبطة بمصير روب — إن مات ماتت معه.' },
  craster:    { name:'أبناء كرستر',   team:'neutral',   icon:'👶', desc:'بريء بالظاهر، حتى يتحوّل لقاتل مستقل بعد الليلة الرابعة أو نجاته من هجوم.' },
  bronn:      { name:'برون',          team:'neutral',   icon:'🏹', desc:'سهم واحد طوال اللعبة، ولاؤك يتحدد بأثر رجعي حسب من تقتل.' },
  faceless:   { name:'متعدد الوجوه',  team:'neutral',   icon:'🎭', desc:'لا وجه لك ولا فريق — أول من يموت في اللعبة ترث دوره وفريقه، وتلعب به إلى النهاية.' },
};

// ══════════════════════ لمن العرش؟ — مكتبة جُمل البوتات ══════════════════════
// مستخرجة من نسخة اللعب المحلي: نجدي/فصحى، ومطابقة لجنس المتهَم
const GOT_LINES = {
  accuse: {
    m: { najdi: [
   "أول وحد صوّت ضد البريء الجولة اللي فاتت كان {t}، وهذا يريبني.",
   "أنا أشوف إن {t} يحاول يبعد الشبهة عن نفسه بذكاء زايد.",
   "صار صوت {t} أخفض من المعتاد هذه الليلة.",
   "{t} كان يضحك بوقت ما كان له داعي يضحك فيه.",
   "{t} كان يتصرف بشكل غريب أمس، ولا أدري وش السالفة.",
   "{t} كان قريب من الضحية آخر ليلة، وهذا مو مصادفة.",
   "لاحظت إن {t} كان متوتر وقت ما ذكرنا اسم الضحية.",
   "شفت {t} يراقب ردود أفعالنا أكثر من مشاركته بالحديث.",
   "{t} كان قاعد لحاله بعيد عن الجميع، ليش كذا بالضبط؟",
   "كان {t} أول من أجاب بسرعة، وكأنه كان مستعدًا للسؤال مسبقًا.",
   "{t} ما رمش عينه وهو يجاوب، وكأنه حافظ الجواب من قبل.",
   "ما أطمّن لـ {t} إطلاقًا، عيونه تقول شي غير كلامه.",
   "{t} كان بعيد شوي وقت النقاش، ما شارك زي الباقين.",
   "{t} كان يكتب شي بالجوال وقت النقاش، وش يكتب يا ترى؟",
   "ليه {t} يدافع عن نفسه بحماس زايد؟ هذا يثير الشك.",
   "{t} كان أول من اقترح اتهامي، وهذا مريب جدًا.",
   "من الغريب أن يدافع {t} عن نفسه بهذا الحماس المفرط."
 ], fusha: [
   "{t} كان أول وحد يجاوب بسرعة، وكأنه جاهز للسؤال قبل لا يجي.",
   "كان {t} منعزلًا أثناء النقاش، ولم يشارك كبقية الحاضرين.",
   "{t} صار يتكلم بصوت أخفض من العادة الليلة.",
   "يبدو أنّ {t} يحمي أحدًا آخر أكثر مما يحمي نفسه.",
   "إنّ {t} كان قريبًا جدًا من الضحية دون تفسير مقنع.",
   "لاحظت إن {t} كان يهمس مع حد ثاني قبل شوي.",
   "{t} يتكلم بثقة زايدة، والمذنب الحقيقي دايم كذا يسوّي.",
   "شكلكم نسيتوا إن {t} كان متضارب بكلامه قبل شوي."
 ] },
    f: { najdi: [
   "ما أطمّن لـ {t} إطلاقًا، عيونها تقول شي غير كلامها.",
   "{t} ما رمشت عينها وهي تجاوب، وكأنها حافظة الجواب من قبل.",
   "صراحة {t} تتصرف زي وحدة تحاول تخفي شي كبير.",
   "{t}، ليش تتجنبين عيوننا كل ما نسولف؟",
   "{t} أول من اتهمت غيرها، وهذي حيلة قديمة يستخدمها المذنبين.",
   "تصرف {t} المريب يجعلني أعيد النظر في موقفها بيننا.",
   "{t} كانت بعيدة شوي وقت النقاش، ما شاركت زي الباقين.",
   "{t} كانت قاعدة لحالها بعيدة عن الجميع، ليش كذا بالضبط؟",
   "من الغريب أن تدافع {t} عن نفسها بهذا الحماس المفرط.",
   "كانت {t} أول من أجابت بسرعة، وكأنها كانت مستعدة للسؤال مسبقًا.",
   "{t} حاولت توجّه الشك لغيرها أكثر من مرة، وهذا يفضحها.",
   "{t} كانت تكتب شي بالجوال وقت النقاش، وش تكتب يا ترى؟",
   "أنا بريء، والدليل إن {t} أكثر وحدة متوترة بالمجلس.",
   "أراهن إن {t} وراها، بس ودي أثبتها.",
   "أشك إن {t} عندها تحالف سري ما نعرف عنه.",
   "أول وحدة صوّتت ضد البريء الجولة اللي فاتت كانت {t}، وهذا يريبني.",
   "{t} كانت تتصرف بشكل غريب أمس، ولا أدري وش السالفة.",
   "سؤال بسيط لـ {t}: أين كنتِ بالضبط وقت وقوع الجريمة؟",
   "راقبوا {t} زين، تصرفاتها أوضح من أي دليل ضدي.",
   "صدقوني، {t} يخبي ورقة رابحة يبيلها يستخدمها ضدنا.",
   "{t} تتصرف وكأنها بريئة زيادة عن اللزوم، وهذا بحد ذاته مريب.",
   "ليش {t} تتغيّر موضوعها كل ما نقرب من الحقيقة؟",
   "شكلها {t} تعرف أكثر من اللي تقوله لنا.",
   "لو تراقبون {t} زيني، بتلاحظون إنها تتفادى العيون.",
   "{t} ما شاركت بالتصويت الأول، وهذا مو طبيعي منها.",
   "سؤال بسيط لـ {t}: وين كنتِ بالضبط وقت الجريمة؟",
   "أنا أشوف إن {t} تحاول تبعد الشبهة عن نفسها بذكاء زايد.",
   "صدقوني، {t} تخبي ورقة رابحة يبيلها تستخدمها ضدنا.",
   "أشك في {t} من زمان، فيه شي مو طبيعي فيها.",
   "{t} أول من اتهم غيره، وهذي حيلة قديمة يستخدمها المذنبين.",
   "ليه {t} تدافع عن نفسها بحماس زايد؟ هذا يثير الشك.",
   "ليه {t} صامتة كذا؟ الصامتة غالبًا عندها شي تسوّيه.",
   "انتبهت إن {t} تغيّر جلستها كل ما نقرب من موضوع معين.",
   "وش دخل {t} بهالموضوع أصلاً؟ ردة فعلها ما تطمّن.",
   "سلوك {t} المتوتر يفضح ما تحاول إخفاءه بابتسامتها.",
   "{t} تصرفاتها الليلة تفضحها أكثر من كلامها.",
   "أبي أفهم من {t}: ليش كنتِ مستعجلة تتهمين غيرك بالبداية؟",
   "بدل ما تشكون فيني، ليه محد يسأل {t} عن تصرفاتها؟",
   "ليه محد يسأل {t} عن مكانها وقت الحادثة؟"
 ], fusha: [
   "{t}، ممكن توضحين لنا وش كنتِ تسوين قبل ما نكتشف الجثة؟",
   "أرى أنّ {t} تحاول صرف الأنظار عن نفسها بمهارة.",
   "لماذا لا يتحدث أحد عن {t}؟ تصرفاتها أغرب من تصرفاتي.",
   "شكلكم نسيتوا إن {t} كانت متضاربة بكلامها قبل شوي.",
   "{t} صارت تتكلم بصوت أخفض من العادة الليلة.",
   "{t} تتكلم بثقة زايدة، والمذنبة الحقيقية دايم كذا تسوّي.",
   "{t} كانت أول وحدة تجاوب بسرعة، وكأنها جاهزة للسؤال قبل لا يجي.",
   "كانت {t} منعزلة أثناء النقاش، ولم تشارك كبقية الحاضرين.",
   "إنّ تناقض أقوال {t} يكشف الكثير عن حقيقتها.",
   "ثقتي بأنّ {t} متورطة تزداد مع كل كلمة تقولها.",
   "لاحظت إن {t} كانت تهمس مع حد ثاني قبل شوي.",
   "راجعت {t} كلامها أكثر من مرة قبل أن تجيب.",
   "لاحظتُ أنّ {t} كانت تهمس مع أحدهم قبل قليل.",
   "إنّ {t} كانت قريبة جدًا من الضحية دون تفسير مقنع.",
   "إنّ محاولات {t} المتكررة لتوجيه الشبهة لغيرها تفضحها.",
   "أعتقد أنّ {t} يمتلك معلومات لا يشاركنا إياها.",
   "أعتقد جازمًا أنّ {t} تخفي حقيقة لا تريد كشفها.",
   "انتبهتُ إلى أنّ {t} تغيّر مجلسها كلما اقتربنا من موضوع معين.",
   "أعتقد جازمًا أنّ {t} يخفي حقيقة لا يريد كشفها.",
   "ثقتي بأنّ {t} متورط تزداد مع كل كلمة يقولها.",
   "يبدو أنّ {t} تحمي أحدًا آخر أكثر مما تحمي نفسها.",
   "لماذا لا تجيب {t} بوضوح حين نوجّه لها سؤالًا مباشرًا؟",
   "لم تشارك {t} في التصويت الأول، وهذا ليس من عادتها.",
   "أرى أنّ الجميع نسي مراقبة {t} رغم قربها من الشبهة.",
   "أعتقد أنّ {t} تمتلك معلومات لا تشاركنا إياها.",
   "إنّ نظرات {t} تفضح ما تحاول إخفاءه بكلماتها.",
   "{t}، لماذا تتجنبين النظر إلينا كلما تحدثنا؟"
 ] },
    any: { najdi: [
   "{t} تحاول تبين هادئة، بس أنا أشوف التوتر بعينيها.",
   "لاحظت إن {t} تتجنب الحديث عن الليلة اللي فاتت.",
   "شفت {t} تراقب ردود أفعالنا أكثر من مشاركتها بالحديث.",
   "ليه {t} صامت كذا؟ الصامت غالبًا عنده شي يسوّيه.",
   "{t} تعرف أكثر مما تظهر، وأنا واثق من كلامي.",
   "أنا أشك إن {t} يحاول يبعد الأنظار عني عشان يفلت هو.",
   "ليش {t} يتغيّر موضوعه كل ما نقرب من الحقيقة؟",
   "{t} هي اللي وجّهت الشك ضدي من البداية، وهذا يثير الريبة.",
   "أنا بريء، والدليل إن {t} أكثر واحد متوتر بالمجلس.",
   "لاحظت إن {t} يتجنب الحديث عن الليلة اللي فاتت.",
   "ليه محد يسأل {t} عن مكانه وقت الحادثة؟",
   "كل مرة نتهم حد، {t} تكون أول من يدافع عنه بقوة غريبة.",
   "خلونا نرجع لـ {t}، هو اللي بدأ الشك من الأصل.",
   "يا {t}، ليش صوتك يرتجف وأنتِ تدافعين عن نفسك؟",
   "بدل ما تضيعون وقتكم فيني، راقبوا {t} زين.",
   "تجنّب {t} الجلوس بالقرب من الضحية طوال الليلة الماضية.",
   "كلما اقترب الحديث من {t}، سارع إلى تغيير الموضوع.",
   "انتبهت إن {t} يغيّر جلسته كل ما نقرب من موضوع معين.",
   "أشوف إن {t} متوتر أكثر من العادة، وهذا مو صدفة.",
   "صراحة {t} يتصرف زي شخص يحاول يخفي شي كبير.",
   "أنا واثق إن {t} تعرف مين القاتل، بس ساكتة لسبب.",
   "شفت {t} تراقب الباب أكثر من العادة، ليه؟",
   "{t} دايم تحوّل الكلام كل ما حد يقرب من الموضوع الصح.",
   "وش دخل {t} بهالموضوع أصلاً؟ ردة فعله ما تطمّن.",
   "كل مرة يقرب الحديث من {t}، تسرع تغير الموضوع.",
   "من وجهة نظري {t} هو الأقرب للشبهة الليلة.",
   "سلوك {t} المتوتر يفضح ما يحاول إخفاءه بابتسامته.",
   "سؤال إلى {t}: من كان برفقتكِ آخر مرة رأيناكِ فيها؟",
   "بدل ما تشكون فيني، ليه محد يسأل {t} عن تصرفاته؟",
   "أنا واثق إن {t} يعرف مين القاتل، بس ساكت لسبب.",
   "سؤال إلى {t}: من كان برفقتك آخر مرة رأيناك فيها؟",
   "وش السبب إن {t} ما دافعت عن الضحية إطلاقًا؟",
   "لاحظت {t} يتحاشى يذكر اسم الضحية بالكلام.",
   "شفت {t} يراقب الباب أكثر من العادة، ليه؟",
   "لاحظت {t} تتحاشى تذكر اسم الضحية بالكلام.",
   "أنا متأكد إن {t} تخفي شي كبير، بس محتاج دليل.",
   "{t} ما شارك بالتصويت الأول، وهذا مو طبيعي منه.",
   "سؤال بسيط لـ {t}: وين كنت بالضبط وقت الجريمة؟",
   "أنا أتفاجأ إن محد شاك بـ {t} إلى الآن.",
   "وش السبب إن {t} تتجنب النظر بعيوننا وقت الكلام؟",
   "كل مرة نتهم حد، {t} يكون أول من يدافع عنه بقوة غريبة.",
   "كل ما تكلمنا عن الشك، اسم {t} يطلع بذهني أول شي.",
   "{t} دايم يحوّل الكلام كل ما حد يقرب من الموضوع الصح.",
   "أستغرب صمت {t} في اللحظات الحاسمة من النقاش.",
   "صراحة أنا حاطّ عيني على {t} من أول الجلسة.",
   "{t} تصرفاته الليلة تفضحه أكثر من كلامه.",
   "يا {t}، ليش صوتك يرتجف وأنت تدافع عن نفسك؟",
   "لو تراقبون {t} زيني، بتلاحظون إنه يتفادى العيون.",
   "{t} كانت تضحك بوقت ما كان لها داعي تضحك فيه.",
   "أنا حاسّ إن {t} يكذب علينا بابتسامة.",
   "{t} يعرف أكثر مما يظهر، وأنا واثق من كلامي.",
   "أنا متأكد إن {t} يخفي شي كبير، بس محتاج دليل.",
   "أشك إن {t} عنده تحالف سري ما نعرف عنه.",
   "بدلًا من الشك بي، ألا تستحق {t} مزيدًا من التساؤل؟",
   "أنا أشوف إن الكل ناسي يراقب {t} وهي الأقرب للشبهة.",
   "{t} حاول يوجّه الشك لغيره أكثر من مرة، وهذا يفضحه.",
   "بدت {t} متوترة حين ذكرنا اسم الضحية.",
   "ليه {t} يبتسم بوقت مو مناسب للابتسام؟",
   "من وجهة نظري، {t} هي من تستحق المراقبة الدقيقة الليلة.",
   "أشوف إن {t} متوترة أكثر من العادة، وهذا مو صدفة.",
   "ليه {t} تبتسم بوقت مو مناسب للابتسام؟",
   "سؤال بسيط لـ {t}: أين كنت بالضبط وقت وقوع الجريمة؟",
   "راقبوا {t} زين، تصرفاته أوضح من أي دليل ضدي.",
   "تصرف {t} المريب يجعلني أعيد النظر في موقفه بيننا.",
   "كلما اقترب الحديث من {t}، سارعت إلى تغيير الموضوع.",
   "بدلًا من الشك بي، ألا يستحق {t} مزيدًا من التساؤل؟",
   "أشك في {t} من زمان، فيه شي مو طبيعي فيه.",
   "{t} يتصرف وكأنه بريء زيادة عن اللزوم، وهذا بحد ذاته مريب.",
   "وش السبب إن {t} يتجنب النظر بعيوننا وقت الكلام؟",
   "{t} هو اللي وجّه الشك ضدي من البداية، وهذا يثير الريبة.",
   "لاحظت نظرة غريبة بين {t} وواحد ثاني بالمجلس.",
   "{t}، ليش تتجنب عيوننا كل ما نسولف؟",
   "{t} أول من اقترحت ننهي النقاش بسرعة، وهذا يريبني.",
   "{t} يتصرف بغرابة، وأنا ما أنسى هالتفاصيل.",
   "شفت {t} يتجنب يجلس جنب الضحية طول الليلة اللي فاتت.",
   "أبي أفهم من {t}: ليش كنت مستعجل تتهم غيرك بالبداية؟",
   "من وجهة نظري {t} هي الأقرب للشبهة الليلة.",
   "من وجهة نظري، {t} هو من يستحق المراقبة الدقيقة الليلة.",
   "شكله {t} يعرف أكثر من اللي يقوله لنا.",
   "شفت {t} تتجنب تجلس جنب الضحية طول الليلة اللي فاتت.",
   "أنا أشوف إن الكل ناسي يراقب {t} وهو الأقرب للشبهة.",
   "لاحظتُ نظرة غريبة تبودلت بين {t} وأحد الحاضرين."
 ], fusha: [
   "يبدو لي أنّ {t} تعرف أكثر مما تظهر لنا.",
   "{t}، لماذا تتجنب النظر إلينا كلما تحدثنا؟",
   "لماذا لا يجيب {t} بوضوح حين نوجّه له سؤالًا مباشرًا؟",
   "أرى في هدوء {t} الزائد إشارة إلى شيء يخفيه.",
   "إنّ {t} هي من وجّهت الاتهام نحوي أولًا، وهذا مريب بحد ذاته.",
   "ليش محد يتكلم عن {t}؟ تصرفاته أغرب من تصرفاتي.",
   "إنّ تصرفات {t} تثير الريبة بشكل واضح.",
   "ما رأيكِ يا {t}؟ نريد أن نسمع دفاعكِ قبل التصويت.",
   "أجزم أنّ {t} هو الأقرب إلى الشبهة في هذه الجلسة.",
   "شفت {t} يبتسم بس شافنا نتكلم عن الجريمة، غريب.",
   "انتبهتُ إلى أنّ {t} يغيّر مجلسه كلما اقتربنا من موضوع معين.",
   "من الملاحظ أنّ {t} يغيّر الموضوع كلما اقتربنا من الحقيقة.",
   "الدليل الحقيقي هو أنّ {t} أكثرنا توترًا هذه الليلة.",
   "لا أستطيع تجاهل الشكوك التي تحوم حول {t} الليلة.",
   "{t}، هل يمكن أن توضح لنا ماذا كنت تفعل قبل اكتشاف الجثة؟",
   "{t}، ممكن توضح لنا وش كنت تسوي قبل ما نكتشف الجثة؟",
   "لم يشارك {t} في التصويت الأول، وهذا ليس من عادته.",
   "لنعُد إلى {t}، فهو من أثار الشكوك منذ البداية.",
   "لاحظتُ أنّ {t} أول من وجّه أصابع الاتهام لغيره.",
   "شفت {t} يراجع كلامه أكثر من مرة قبل ما يجاوب.",
   "سلوك {t} الليلة الماضية لم يكن طبيعيًا على الإطلاق.",
   "لست مطمئنًا لتصرفات {t} منذ اللحظة الأولى.",
   "رأيتُ {t} تراقب الباب أكثر من المعتاد، فلماذا؟",
   "أرى أنّ الجميع نسي مراقبة {t} رغم قربه من الشبهة.",
   "إنّ نظرات {t} تفضح ما يحاول إخفاءه بكلماته.",
   "لماذا تتجنب {t} الحديث عن أحداث الليلة الفائتة؟",
   "يبدو أنكم نسيتم تناقض أقوال {t} قبل قليل.",
   "رأيتُ {t} يراقب الباب أكثر من المعتاد، فلماذا؟",
   "لماذا تلتزم {t} الصمت في وقتٍ يستدعي الإفصاح؟",
   "من الصعب تصديق أنّ {t} بريء تمامًا مما يجري.",
   "إنّ {t} هو من وجّه الاتهام نحوي أولًا، وهذا مريب بحد ذاته.",
   "ضحكت {t} في وقتٍ لم يكن يستدعي الضحك إطلاقًا.",
   "راجع {t} كلامه أكثر من مرة قبل أن يجيب.",
   "أشكّ في أمر {t} منذ بداية هذا المجلس.",
   "أرى في هدوء {t} الزائد إشارة إلى شيء تخفيه.",
   "يبدو لي أنّ {t} يعرف أكثر مما يظهر لنا.",
   "من الملاحظ أنّ {t} تغيّر الموضوع كلما اقتربنا من الحقيقة.",
   "إنّ محاولات {t} المتكررة لتوجيه الشبهة لغيره تفضحه.",
   "لنعُد إلى {t}، فهي من أثارت الشكوك منذ البداية.",
   "ضحك {t} في وقتٍ لم يكن يستدعي الضحك إطلاقًا.",
   "أرى أنّ {t} يتصنع الطمأنينة أكثر من اللازم.",
   "أجزم أنّ {t} هي الأقرب إلى الشبهة في هذه الجلسة.",
   "أرى أنّ {t} تتصنع الطمأنينة أكثر من اللازم.",
   "لماذا يتجنب {t} الحديث عن أحداث الليلة الفائتة؟",
   "إنّ تناقض أقوال {t} يكشف الكثير عن حقيقته.",
   "لماذا لا يتحدث أحد عن {t}؟ تصرفاته أغرب من تصرفاتي.",
   "ما رأيك يا {t}؟ نريد أن نسمع دفاعك قبل التصويت."
 ] },
  },
  defend: { najdi: [
   "صراحتي هي اللي تخليني أبين مريب أحيانًا، بس أنا بريء.",
   "ما عندي مشكلة أدافع عن نفسي، بس عطوني فرصة أتكلم.",
   "أنا واثق من براءتي، والحق بيبان مهما تأخر.",
   "صدقوني أنا بريء زي طفل يحاول ينكر إنه كسر الكاسة.",
   "ضميري مرتاح كفنجان شاي فارغ، لا شيء يقلقني.",
   "براءتي أكبر من ثقتي بنفسي في أيام الامتحانات.",
   "أنا بريء، والوقت بيثبت كلامي عاجلًا أو آجلًا.",
   "خلوني بس أشرب مويه وأرجع أدافع عن نفسي بقوة أكبر.",
   "يا جماعة أنا بريء بنسبة توازي حبي للشاي بالحليب.",
   "دعوني أشرب قليلًا من الماء ثم أعود لأدافع عن نفسي بقوة أكبر.",
   "أقسم بالله أنا بريء، وما لي أي دخل بالموضوع.",
   "أنا هنا من أول اللعبة أدافع عن الحق، مو أخفيه.",
   "أنا واثق من براءتي، والحق يظهر مهما طال الزمن."
 ], fusha: [
   "ضميري مرتاح، لأنني لم أرتكب ما يستوجب هذا الحكم.",
   "أنا بريء، وأنت الدناءة الحقيقية التي تمشي بيننا.",
   "لستُ خائنًا، لكن عينيّ متعبتان من قلة النوم فحسب.",
   "ضميري مرتاح لأنني لم أرتكب خطأً يُذكر."
 ] },
  idle: { najdi: [
   "كل واحد فينا مشتبه فيه لين يثبت العكس.",
   "كل من يرتدي قناع البراءة، يسقط أعمق حين ينكشف أمره.",
   "كل مملكة سقطت يومًا، بسبب ثقة زايدة بشخص غلط.",
   "من يفعل فعلتك يستحق الطرد من الجولة الأولى.",
   "يا وسخ، حتى الطين أنضف من سمعتك.",
   "لو نبني ثقة حقيقية بيننا، الخيانة ما تقدر تختبي طويل.",
   "القصص القديمة تقول: الأقرب دايم أخطر من الأبعد.",
   "✅ عاد الاتصال — بانتظار التحديث...",
   "العدل يتأخر أحيانًا، بس الجوع أبد ما يتأخر، خلصونا بسرعة.",
   "إن حكمتم عليّ اليوم، فستندمون حين تظهر الحقيقة غدًا.",
   "يتحول لقاتل مستقل لاحقًا",
   "خلونا نراقب ردود الأفعال أكثر من الكلام نفسه.",
   "لنمنح بعضنا بعض الثقة، فالشك المبالغ فيه يفرّقنا.",
   "خلونا نبني تحالف مؤقت لين نوصل للحقيقة.",
   "إذا ما تكلمنا اليوم، بكرة يصير الوضع أصعب.",
   "أنا هنا لأحمي المجلس، مو لأخون أحد فيه.",
   "إن وُجد دليل حقيقي ضدي، فليُعرض عليّ الآن.",
   "العدالة تتأخر بعض المرات، بس لما تجي، ما ترحم.",
   "ثقوا بي، فأنا معكم لا ضدكم في هذه المعركة.",
   "ليش تشكون فيني أنا بالذات؟ ما سويت شي يستاهل الشك.",
   "من يخاف من السؤال، غالبًا يخفي جواب يخاف نسمعه.",
   "أقترح نصوّت بضمير مرتاح، مو بخوف من الغلط.",
   "كلامك السافل لا يستحق نصف دقيقة تفكير.",
   "لا تشكون فيني بس لأني أحب أضحك بلحظات التوتر.",
   "لو عندكم دليل حقيقي، وروني إياه الحين.",
   "لو فيه مسابقة أطول جلسة نقاش، فزنا فيها بلا منازع.",
   "أقسم أنني بريء، ولا علاقة لي بما جرى.",
   "العدل يتأخر، بس اللي يستاهل العقاب ما يفلت أبد.",
   "العدل بطيء، بس ما يفوّت أحد مهما اختبأ.",
   "اسألوا نفسكم، وش المنطق إني أخون ناس أعرفهم؟",
   "\" placeholder=\"لاعب",
   "لو كنتُ الخائن، لتركتُ غيري يتحمل التهمة بدلًا مني.",
   "أفضل أكون صريح وأتحمل النتيجة، من أسكت وأندم.",
   "لو أعدموني اليوم، وصيتي إنكم تكملون اللعبة من دوني.",
   "تأكد محد ثاني يشوف الشاشة",
   "فيه وحد بينا يمثل دور الطيب، وأنا بعرف مين هو قريب.",
   "خلونا نتفق سوا، الاتحاد أقوى من التفرق بهالمرحلة.",
   "العصفور بصدري يقول إن الليلة بتكشف شي كبير.",
   "الظلام دايم يخبي أكثر مما يبين، خلونا ننتبه.",
   "أشعر إن أحدهم يمثل دور غير حقيقي بيننا.",
   "مين يدري، ممكن يكون الخائن أقرب وحد لنا بالمجلس.",
   "ما فيه وقت للتردد، لازم نتحرك الحين.",
   "خلونا نراقب سوا، أربع عيون أفضل من وحدة.",
   "الحقيقة لا تموت، مهما حاول الخونة دفنها في الظلام.",
   "يحرس ويفدي محروسه بروحه",
   "يا خايس، خيانتك ما فيها إبداع، حتى بيليش يستحي منك.",
   "إن أعدمتموني، فستندمون حين يُكشف الفاعل الحقيقي!",
   "كل خطوة غلط الليلة، ممكن تكلفنا حياة بريء.",
   "إن جمعنا ملاحظاتنا معًا، فسنصل إلى الخائن بشكل أسرع.",
   "إن كنتم تشكّون بي بسبب صمتي، فأنا فقط أفكر بعمق شديد.",
   "أقترح أن نجمع كل الملاحظات ونخرج بقرار موحّد.",
   "لا مكان للضعفاء على عرشٍ يُبنى فوق الدماء والخيانة.",
   "ما كان لي أي تحرك مريب الليلة، تأكدوا بأنفسكم.",
   "خلونا نجمع كل الملاحظات ونطلع بقرار واحد.",
   "أنا متأكد إن أحدنا يكذب علينا بوجه بريء.",
   "من يقف صامتًا الليلة، ربما يحمل أثقل الأسرار بيننا.",
   "لو فيه جائزة لأكثر واحد بريء بالمظهر، أنا الفايز أكيد.",
   "لو كانت هناك ميدالية لأكثر شخص لا يفهم ما يجري، لفزتُ بها.",
   "لنبنِ تحالفًا مؤقتًا حتى نصل إلى الحقيقة كاملة.",
   "أنا مستعد أشارك كل اللي أعرفه عشان نحل اللغز سوا.",
   "أنت أوضح خاين من سيرسي وهي تحمل الوايلدفاير.",
   "يا حثالة، حتى كذبتك ما فيها إبداع.",
   "لاحظتم كيف تغيّرت الأصوات بسرعة في الجولة الماضية؟",
   "أنا أثق بعيني أكثر من ثقتي بأي كلام يتقال.",
   "خلونا نحسم الموضوع اليوم، ما نقدر نضيع وقت أكثر.",
   "لازم نوصل لقرار اليوم، الغموض ما يفيدنا.",
   "أنا بس هادئ الطبع، مو معناها إني مذنب.",
   "كل كلمة قلتها الليلة كانت صدق محض.",
   "لو كنت الخائن، كنت خليت غيري يقع بدالي.",
   "لو نجمع ملاحظاتنا سوا، بنوصل للخائن أسرع.",
   "لو صدقنا بعض أكثر، بنوصل لنتيجة أسرع وأدق.",
   "ما عندي شي أخفيه، اسألوني أي سؤال.",
   "ما يقعد على العرش إلا اللي يقدر يتحمل الدم بيديه.",
   "أنا أسمع كل كلمة تنقال، وأحلل كل تصرف بصمت.",
   "عقلي يخبرني بشيء، وقلبي يوافقه، فأنا أسير معهما.",
   "لو تراقبون الأيدي مو بس الوجوه، بتكتشفون أشياء أكثر.",
   "صدقوني، أنا أخاف على المجلس أكثر من نفسي.",
   "أخشى التصويت أكثر مما أخشى الخيانة نفسها، بصراحة.",
   "الوحدة ضرورية الآن، فالانقسام يخدم الخائن وحده.",
   "ثقوا فيني، أنا معكم مو ضدكم.",
   "كل ليلة تمر بدون حسم، الظلام يكسب أرض جديدة.",
   "لو أعدمتوني اليوم، بتندمون لما تعرفون الحقيقة بكرة.",
   "الشتاء قادم لا محالة، والخيانة أشد برودة من أي ريح.",
   "أعذارك السخيفة يرفضها حتى الذكاء الاصطناعي نفسه.",
   "اقعد يا خايس، دورك خلص من زمان.",
   "لو تصدقون كل اللي يتقال، بتنخدعون بسهولة.",
   "يجب ألا نخشى الاتهام، فالصمت أخطر من الخطأ أحيانًا.",
   "إذا سكتنا كذا، الخائن بيربح بدون تعب.",
   "والله لو أعرف شي كنت قلته من أول لحظة.",
   "أنت أفشل خاين شفته، حتى جوفري كان أذكى منك.",
   "أنا أثق بأغلبكم، وودي نتعاون عشان مصلحة الكل.",
   "أشك إن فيه تحالف مخفي يلعب ضدنا كلنا.",
   "لا يهمس الغراب إلا لمن يستحق معرفة الحقيقة.",
   "لو تراقبون التنفس السريع وقت الأسئلة، بتفهمون أكثر.",
   "كل عين في هذا المجلس تخفي سرًا، والزمن وحده يكشفه.",
   "حتى العرش الحديدي أكثر راحة من هذه المقاعد الصلبة.",
   "الثقة المفرطة قد تكون أخطر من الشك نفسه.",
   "الثقة الزايدة أحيانًا أخطر من الشك نفسه.",
   "العرش لا يرحم المتردد، ووقتنا أضيق مما نظن.",
   "خلونا نحاسب من دون خوف، العدالة تستاهل الجرأة.",
   "أنا طفشت من كلامك الفاضي يا خايس.",
   "كل اتهام بلا برهان لا يستحق حتى الرد عليه.",
   "خلونا نكون فريق واحد الليلة، ضد أي خيانة تحاول تفرقنا.",
   "يا مخادع، عمرك ما بتقنعنا بكلامك الفاضي.",
   "الليل الطويل ابتلع الجميع",
   "لا تكلمني وأنت وسخ إلى هالدرجة، قول الحقيقة بس.",
   "إن أُعدم أحد اليوم، فليكن من لا يرد على الرسائل أبدًا.",
   "يا للوقاحة أن تدافع وأنت أوضح خائن رأيته في حياتي.",
   "أعذارك الكاذبة يكشفها حتى الأطفال بسهولة.",
   "(يقف صامت، عيونه بس تتحرك بين الوجوه)",
   "لو أعدمتوني، بتندمون لما يكتشف الفاعل الحقيقي!",
   "لاحظتُ كل التفاصيل، وقراري مبني على المنطق لا العاطفة.",
   "أقترح أن نصوّت بضمير مرتاح لا بخوف من الخطأ.",
   "مين قال إن اللي يدافع عن نفسه بحرارة بريء أكيد؟",
   "أحس إن الخيانة قريبة منا أكثر مما نتوقع.",
   "الجولة اللي فاتت علمتنا درس: التسرع يكلفنا غالي.",
   "(يقف صامتًا، وعيناه فقط تتحركان بين الوجوه)",
   "خلونا نثق ببعض شوي، الشك المبالغ فيه يفرقنا.",
   "مين قال إن الخاين لازم يكون غريب الأطوار؟ أحيانًا يكون ألطف واحد فينا.",
   "شفت كل التفاصيل، وقراري مبني على منطق مو عاطفة.",
   "كل من يلبس قناع البراءة، يوم ينكشف يسقط أعمق من غيره.",
   "ما اتهمت حد اليوم إلا بعد ما راقبته زين.",
   "أكثر ما يزعجني في هذا المجلس هو نقص القهوة، لا الخيانة.",
   "أفضّل أن أكون صريحًا وأتحمل النتيجة على أن أصمت وأندم.",
   "لو الكذب رياضة، كنت بطل أولمبي يا خايس.",
   "لا مجال للتردد بعد الآن، يجب أن نتحرك فورًا.",
   "ثقوا إني ما قدر أوذي حد بينكم.",
   "أشوف إن فيه أكثر من قصة تُروى الليلة، ومو كلها صادقة.",
   "مرتبطان بمصير واحد (مقعدان)",
   "مراقبة ردود الأفعال أجدى من الاستماع إلى الكلام وحده.",
   "يعيش الغادرون بيننا في الظل حتى تحين لحظة الكشف.",
   "صدقوني، تحليلي مبني على أدلة مو تخمين عشوائي.",
   "لو أعدمتوني اليوم، الخائن الحقيقي بيضحك علينا كلنا.",
   "تحمل مملكتنا الصغيرة هذه من الغدر ما يكفي مملكة كاملة.",
   "خلونا ما نخاف نتهم، الصمت أخطر من الخطأ أحيانًا.",
   "العرش يبيله صبر، وأنا صبري خلص من الجوع بس.",
   "يا رجّال، حتى الوحوش البيضاء تعبت من طولة هالنقاش.",
   "ثقتي بحكمي نابعة من تجربتي في مواقف مشابهة.",
   "الخيانة أرهقتني أقل مما أرهقني من يحاول كشفها.",
   "أشعر بالتعب من الوقوف، فلنجلس ثم نكمل الدفاع بشكل لائق.",
   "الشك حقّ مشروع، لكنه يجب أن يُبنى على الملاحظة لا الهوى.",
   "أتمنى ما نكرر غلط الجولة اللي طافت، خلونا نفكر أعمق.",
   "من صوّت ضد البريء أول مرة، لازم يعيد التفكير بمنطقه.",
   "من صوّت ضد البريء سابقًا، عليه أن يعيد النظر في منطقه.",
   "كل اتهام بدون برهان، ما يستاهل حتى الرد عليه.",
   "الثقة سلاح ذو حدين، والليلة سنرى من يُحسن استخدامه.",
   "لو الاتهام سهل كذا، الكل بيصير مذنب بسرعة.",
   "صراحة الجلسة هذي أطول من كل مواسم ذا وولكنج داد مجتمعة.",
   "صدقوني، الحقيقة دايم تطلع مهما حاولوا يدفنونها.",
   "لا أخشى قول رأيي حتى لو خالف رأي الأغلبية.",
   "أظن إن فيه شخصين يتعاونون سرًا الليلة.",
   "لو صوتوا عليّ، خلوها آخر وجبة أطيب وجبة بحياتي.",
   "تحليلي مبني على أدلة واضحة لا على تخمين عابر.",
   "الأدلة أمامنا واضحة، فلا داعٍ للإطالة أكثر من ذلك.",
   "إن صوّتم ضدي، فسأرحل بابتسامة، لكن اسمحوا لي بوجبة أخيرة.",
   "عقلي يقول لي شي، وقلبي يوافقه، فأنا ماشي وياهم.",
   "لنحسم الأمر اليوم، فلا وقت لدينا للتأجيل.",
   "أوعدكم لو نجوت الليلة، بجيب حلا للجلسة الجاية.",
   "أقترح نصوت على أكثر شخص شكوك حوله الليلة.",
   "التاريخ يذكر الشجعان، مو الصامتين اللي خافوا يتكلمون.",
   "أنا وياكم بهذا القرار، ما بروح لحالي.",
   "أنا أول من يسعى لكشف الخائن، لا أن أكون سببًا في حمايته.",
   "أنا قلق على الجميع، مو بس على نفسي.",
   "أقترح التصويت على من تحوم حوله أكبر الشكوك.",
   "في هذا المجلس، الصمت أحيانًا أعلى صوتًا من الكلام.",
   "الغراب ما يهمس إلا اللي يستاهل يعرف الحقيقة.",
   "لو تراقبون مين يتغير موقفه بسرعة، بتكتشفون شي مهم.",
   "لازم نصوت بعقلانية، مو بمزاج اللحظة.",
   "ما عندي أي مصلحة أخون أحد بينكم.",
   "العدالة قد تتأخر، لكنها حين تأتي لا ترحم أحدًا.",
   "كان التصويت السابق متسرعًا، وأخشى أن نكرر الخطأ ذاته.",
   "أنا يدي ممدودة لكل واحد يبي الحق يظهر.",
   "يجب أن يكون تصويتنا مبنيًا على المنطق لا العاطفة.",
   "حتى فاريس نفسه يحتاج إلى فنجان قهوة ليتأمل في الأمر.",
   "قرار مصيري بانتظارك",
   "كل واحد منا يحمل قناعًا، والليلة سنرى من يسقطه.",
   "حتى الموتى البيض تعبوا من طول هذا النقاش، على ما أظن.",
   "تفرض حسم الاتهام بدون انتظار البقية؟",
   "كل ليلة تمرّ دون حسم تمنح الخائن فرصة إضافية.",
   "أنا أحترم شكوككم، بس أرجو تكون مبنية على شي حقيقي.",
   "أنا أراقب كل حركة بهالمجلس، ولا شي يفوتني.",
   "أنا آخر من يستحق هذه التهمة، صدقوني.",
   "هذه الجلسة أطول من مسلسل كامل بموسمين متتاليين.",
   "أنا مستعد أتعاون مع أي واحد يبي يكشف الحقيقة معي.",
   "وين كنت يا زبال وقت الجريمة؟",
   "اللي يوقف صامت الليلة، يمكن يحمل أثقل سر بينا.",
   "أنا آخر شخص لازم تشكون فيه، صدقوني.",
   "الحرب الحقيقية مو بالسيوف، هي بالثقة اللي تنكسر بيننا.",
   "لقد ظُلمت، لكنني أسامحكم إن تراجعتم عن قراركم.",
   "زبالتك تلمع من بعيد يا خايس، ما تحتاج غراب يكشفك.",
   "لو كنتُ الخائن، لجعلتكم جميعًا تشترون لي هدية أولًا.",
   "كل شكوككم فيني مبنية على إحساس، مو دليل حقيقي.",
   "العدالة بطيئة، لكنها لا تفوّت أحدًا مهما اختبأ.",
   "اتهاماتك سافلة، لا تحمل كلمة واحدة صادقة.",
   "أنا أرحب بأي سؤال، بس مو بأي اتهام فاضي.",
   "يعرف الجميع، ينحاز سرًّا لاحقًا",
   "دع الدناءة تظهر منك واعترف كالرجال.",
   "ربما يكون أقرب الناس إلينا أبعدهم عن الحقيقة.",
   "العرش ما يرحم المتردد، وقتنا محدود.",
   "خلونا نصوت بناء على الأدلة مو على العاطفة.",
   "إن اتفقتم معي، فسنتمكن من حصر الشك بسرعة أكبر.",
   "هدوئي طبيعة في شخصيتي، ولا يعني بالضرورة الذنب.",
   "أشوف إن فيه أكثر من طرف يلعب لعبته الخاصة الليلة.",
   "كل تأخير يخدم الخائن ولا يخدمنا نحن.",
   "من يحمل السيف بالخفاء، أخطر ممن يحمله بالعلن.",
   "إن كنت تظن أنك ستفلت، فأنت أغبى مما تصورت.",
   "تفرض الحكم بدون انتظار البقية؟",
   "الوقت يمشي، والخائن يستفيد من ترددنا.",
   "اللي يسوي زيك يستاهل يطرد من أول جولة.",
   "علمتنا الجولة السابقة درسًا: التسرع يكلّفنا كثيرًا.",
   "لازم نتحد اليوم، الانقسام بيخدم الخائن بس.",
   "أين كنت يا وضيع وقت وقوع الجريمة؟",
   "كل واحد فينا يحمل قناع، والليلة بنشوف مين يسقطه.",
   "كل خطوة نخطوها الليلة تقرّبنا من النهاية أو تبعدنا عنها.",
   "الشتا جاي، والخيانة أبرد من أي ريح تجينا.",
   "لو نساعد بعض بالمراقبة، ما راح يفلت منا حد.",
   "يا معفن، ليش ما تخجل من نفسك؟",
   "لا أخجل من تغيير رأيي إن ظهر دليل جديد يستدعي ذلك.",
   "يحمي الظلام الخائن، لكنّ الفجر يفضح كل شيء دائمًا.",
   "لا تخاطبني وأنت بهذا الدناءة، قل الحقيقة فحسب.",
   "إن كانت هذه نهايتي، فليشهد الجميع أنني رحلت بريئًا.",
   "لو هذي نهايتي، فليشهد الجميع إني رحت بريء.",
   "لو تلاحظون التفاصيل الصغيرة، بتكتشفون الكذب بسهولة.",
   "لا أحكم بسرعة، لكن حين أحكم أكون متيقنًا تمامًا.",
   "قراري اليوم نابع من مراقبة متأنية لا من ردة فعل.",
   "كل كلمة قلتها الليلة كانت صدقًا خالصًا.",
   "صراحتي قد تجعلني أبدو مريبًا أحيانًا، لكنني بريء.",
   "يا جماعة، حتى فاريس نفسه يحتاج قهوة يقعد يفكر فيها.",
   "الشك حق طبيعي، بس لازم يبنى على ملاحظة مو مزاج.",
   "لو كنتُ مكانكم، لوجّهتُ الشك نحو غيري لا نحوي.",
   "يفحص شخصًا كل ليلة ويعرف فريقه",
   "أثق بحدسي، وحدسي نادر يخطئ بهالمواقف.",
   "كل قرار نتخذه الليلة يحدد مصير هذه المملكة بأكملها.",
   "أثق بحدسي، ونادرًا ما يخذلني في مثل هذه المواقف.",
   "أنا واثق من قراري، وما بغيره مهما قلتوا لي.",
   "لو تفكرون إني هادئ يعني ما أفهم، فأنتم غلطانين.",
   "لو تشكون فيني بسبب سكوتي، فأنا بس أفكر بعمق شديد.",
   "العتمة تحمي الخائن، بس الصبح دايم يفضح كل شي.",
   "أنا أول من يبي يكشف الخائن الحقيقي، مو أخفيه.",
   "تفرض متابعة الليل بدون انتظار البقية؟",
   "مملكتنا الصغيرة هذي فيها غدر يكفي مملكة كاملة.",
   "يجب أن نتفق على شخص واحد ونركّز جهودنا عليه اليوم.",
   "ربما يكون الخائن أقرب الحاضرين إلينا الليلة.",
   "لو فيه دليل حقيقي ضدي، وريوني إياه.",
   "انتظر بقية اللاعبين",
   "كل واحد فينا يحمل قصة، بس مو كل القصص صادقة.",
   "صدقوني، قلبي مرتاح لأني ما سويت شي غلط.",
   "التصويت اللي فات كان متسرع، وأخاف نكرر نفس الغلط.",
   "ما فيه داعي نطول، الأدلة قدامنا واضحة.",
   "الليل الطويل لا يرحم أحدًا، والخيانة تكبر في الظلام.",
   "التاريخ يعيد نفسه، والخيانة دايم تلبس وجه صديق.",
   "اسمك صار مرتبط بالخيانة يا حثالة.",
   "سهم واحد طوال اللعبة",
   "أخشى على مصير هذا المجلس أكثر مما أخشى على نفسي.",
   "مصيرك بيد الآخرين الآن...",
   "أنا أراهن إن الحقيقة أقرب مما نتخيل، بس محد يبيها تطلع.",
   "خلونا نتفق على شخص واحد ونركز عليه اليوم.",
   "لو فيه ميدالية لأكثر واحد ما يفهم شي بهالنقاش، أنا الفايز.",
   "تحمي أو تُحيي مرة واحدة",
   "أنا أشوف إن الجلسة هذي فيها أكثر من لغز.",
   "أعذارك سافلة، لا تقنع طفلاً صغيرًا.",
   "قراري اليوم نابع من مراقبة دقيقة، مو رد فعل.",
   "أحس إن فيه اتفاق سري بين اثنين مننا.",
   "ما نقدر نأجل القرار أكثر من هذا.",
   "كل ليلة يمر بدون حسم، الخائن يفرح أكثر.",
   "كل عين بهالمجلس تخفي سر، والوقت وحده يكشفه.",
   "أنا واضح من أول الجلسة وما غيّرت كلامي.",
   "لاحظتوا كيف تغيرت الأصوات بسرعة الجولة اللي طافت؟",
   "الوقت يمشي، وكل تأخير يخدم الخائن مو إحنا.",
   "من المحتمل أن يكون هناك تحالف خفي يعمل ضدنا جميعًا.",
   "يا معفن، لو الخيانة مهنة، كنت أفشل موظف فيها.",
   "يجب أن نوسّع دائرة شكوكنا لا أن نحصرها في شخص واحد.",
   "كل قرار نسويه الليلة، بيحدد مصير المملكة كلها.",
   "كل سؤال نسأله الليلة، يقرّبنا خطوة من الحقيقة.",
   "أنا آخر واحد يستاهل هالتهمة، صدقوني.",
   "كل كلامي كان صدق، وما أخفي عنكم شي.",
   "الليل الطويل ما يرحم أحد، والخيانة تكبر وسط الظلام.",
   "يا قذر، عيونك تفضحك أكثر من لسانك.",
   "يا معفن، ريحتك الوسخة توصل من هنا.",
   "الشك ما لازم يوقف عند شخص وحد، خلونا نوسّع دائرتنا.",
   "خلونا نوحد جهودنا، الخيانة تخاف من التعاون الحقيقي.",
   "والله ظلمتوني، بس أنا أسامحكم لو تراجعتوا.",
   "يا قذر، لو الصدق يجرحك، فأنت ميت من زمان.",
   "كل خطوة نخطوها الليلة، تقرب أو تبعد النهاية.",
   "مين يدري، ربما القاتل يجلس بيننا ويشرب الشاي وياكم.",
   "العرش الحديدي يريحني أكثر من هالكراسي الصلبة، بصراحة.",
   "كل اتهام موجّه إليّ باطل، اسألوا من يستحق الشك الحقيقي.",
   "أنا ما أحكم بسرعة، بس لما أحكم أكون متأكد.",
   "الخيانة ما تولد فجأة، تكبر بصمت لين تنفجر.",
   "كل ليلة تمرّ دون حسم يكسب فيها الظلام أرضًا جديدة."
 ], fusha: [
   "لا أطلق الأحكام جزافًا، بل أبني موقفي على وقائع ملموسة.",
   "اللي يخون الليلة، بيدفع الثمن قبل ما تطلع الشمس.",
   "العرش الحديدي يشرب الدم قبل ما يعطي التاج.",
   "أيها المقيت، رائحة خبثك تصل من هنا.",
   "أرجوكم أن تحكموا بعقل هادئ قبل إصدار أي قرار.",
   "أرحّب بأي سؤال، لكن لا أقبل اتهامًا فارغًا من المضمون.",
   "خلونا نراجع كل الأدلة قبل ما نصوت.",
   "خذوا وقتكم، لكن فكروا جيدًا قبل أن تندموا.",
   "موقفي واضح منذ بداية الجلسة ولم يتغير.",
   "روب وتاليسا 💞 (مقعدان)",
   "العدالة لا تأتي من تلقاء نفسها، بل تحتاج إلى شجاعتنا.",
   "الحرب الحقيقية ليست بالسيوف، بل بالثقة التي تنكسر بيننا.",
   "أرجوكم فكروا بعقلانية قبل ما تحكمون عليّ.",
   "الوقت المناسب نحسمها الآن قبل ما يفوتنا.",
   "أشعر أنّ أحدنا يمثل دور البراءة ببراعة فائقة.",
   "ليس لديّ أي مصلحة في خيانة من أعرفهم.",
   "لا أخشى التصويت، بل أخشى طول هذه الجلسة فحسب.",
   "العرش الحديدي يتذوق الدم قبل أن يمنح التاج.",
   "أيها القذر، لو كان الصدق يؤلمك، فأنت ميت منذ زمن.",
   "أيها الوضيع، حتى الطين أنظف من سمعتك.",
   "أنا أرى إن التعاون هو طريقنا الوحيد لنكشف الحقيقة الليلة.",
   "أقسم أنني بريء… لماذا تشكّون فيّ أنا بالذات؟",
   "الغدر ما يعلن عن نفسه، هو يجلس معنا ويبتسم.",
   "لقد سئمت كلامك الفارغ أيها الوضيع.",
   "لم يصدر مني أي تصرف مريب، تأكدوا بأنفسكم.",
   "يبدو أنّ الخيانة أقرب إلينا مما نتصور.",
   "لم أتهم أحدًا اليوم إلا بعد مراقبة دقيقة.",
   "كل ما قلته كان صادقًا، ولم أُخفِ عنكم شيئًا.",
   "لو تبون تتهموني، وروني دليل واحد ملموس بس.",
   "أيها الفاشل، حتى خيانتك جاءت بشكل رخيص.",
   "ليس كل صامت مذنبًا، وليس كل متكلم بريئًا.",
   "أرى أنّ هناك أكثر من طرف يخفي أجندة خاصة به.",
   "اصمت أيها المقيت، كلامك يزيد ريبتي فيك فحسب.",
   "فيه لاعب بينا يمسك الخيوط من وراء الكواليس.",
   "أظن أنّ اثنين من بيننا يتعاونان في الخفاء.",
   "أيها المقيت، ألا تخجل من نفسك؟",
   "إنّ الظلام يخفي أكثر مما يكشف، فلنكن حذرين.",
   "إنّ الوقت يمضي والخائن يستفيد من ترددنا الجماعي.",
   "لو كنتُ الخائن، لتركتُ لكم وصية غداء قبل رحيلي.",
   "اصمت أيها الدجال، لا أحد يشتري كلامك الفارغ.",
   "كفى نفاقًا أيها المزيف، وجهك يفضحك أكثر من لسانك.",
   "لو كنتُ أعلم شيئًا لأفصحتُ عنه منذ البداية.",
   "أقترح كل واحد يقول شكه بصوت عالي قبل التصويت.",
   "أيها الوضيع، حتى التحديثات التقنية أسرع من اعترافك.",
   "اتهموني إن شئتم، لكن تذكّروا أنّ الوقت كفيل بكشف الحقيقة.",
   "أيها المقيت، حتى الإعلانات المزعجة أكثر احتمالًا منك.",
   "أشعر بالظلم، لأنني لم أفعل ما يستحق هذا الاتهام.",
   "اصمت أيها الكاذب، كلامك لا يعنيني إطلاقًا.",
   "أيها المقيت، حتى أسوأ التقييمات ترفض أن تصفك بالعدل.",
   "لم أتغيّر منذ اللحظة الأولى، وموقفي ثابت.",
   "أزن كلماتي جيدًا قبل أن أوجّه أي اتهام.",
   "لو نتكلم بصراحة أكثر، بنوفر وقت ومجهود على الجميع.",
   "اهدأ أيها المرتجف، ارتجافك يفضحك أكثر من كلامك.",
   "لنراجع الأدلة المتوفرة قبل أن نصوّت.",
   "الوقت المناسب للحسم هو الآن، قبل أن تفوتنا الفرصة.",
   "اسألوا أنفسكم: ما المنطق الذي يدفعني لخيانة رفاقي؟",
   "خذوا وقتكم، بس فكروا زين قبل ما تندمون.",
   "أيها القذر، عيناك تفضحانك أكثر من لسانك.",
   "إن لم نتحدث بصراحة اليوم، فسيصعب الأمر غدًا.",
   "يا جماعة الخير، خلونا نحسمها بسرعة قبل لا يبرد الشاي.",
   "أنا معكم في هذا القرار، ولن أنفرد برأيي.",
   "صراحة ودي أفهم ليش محد يتكلم بصراحة أكثر.",
   "لو نتفق الليلة، بنقدر نوقف الخيانة قبل ما تكبر.",
   "لنُنهِ هذا النقاش قبل أن يبرد الشاي، رحمة بنا جميعًا.",
   "مو كل اللي يتكلم كثير بريء، ومو كل الساكت مذنب.",
   "أيها الوضيع، حتى اسمك بات يذكرني بالخيانة.",
   "صراحة أخاف من اللي يبتسم بس نتكلم عن الموت.",
   "لن أصمت أمام اتهام بلا دليل، فهذا حقي الطبيعي.",
   "لو أُعدمت، لن يخسر هذا المجلس شيئًا يُذكر.",
   "أيها الوضيع، سيرتك الذاتية فيها خيانات أكثر من إنجازات.",
   "لا يمكننا إغفال أنّ الخطر قد يكون بيننا منذ البداية.",
   "أنا واثق من قراري، ولن أغيّره مهما قيل لي.",
   "الخيانة لا تولد فجأة، بل تكبر في صمت حتى تنفجر.",
   "لماذا توجّهون الشكوك نحوي أنا بالذات؟",
   "صدقوني، الخائن بيننا يتكلم الحين ويضحك وياكم.",
   "على كل واحد منا أن يُبدي رأيه بصراحة قبل التصويت.",
   "إنّ الصمت الجماعي هذه الليلة قد يكلفنا الكثير.",
   "يذكر التاريخ الشجعان، لا الصامتين الذين خافوا الكلام.",
   "أيها الغبي، أظننت أنك ستفلت بهذه السذاجة؟"
 ] },
  harsh: { najdi: [
   "يا تافه، عقلك أصغر من عصفور فاريس.",
   "يا خسيس، حتى الهاوند ما يحرسك من فضيحتك هذي.",
   "يا خسيس، شفناك وأنت تحاول تلعب بعقولنا.",
   "اسكت يا كذاب، كلامك ما يفرق معي أبد.",
   "اسكت يا تافه، صوتك يذكرني بصرير الأبواب القديمة.",
   "يا خسيس، حتى الوحوش البيضاء ما تتجرأ تقرب منك من الريحة.",
   "يا حقير، اعترافك أسهل من حفظ اسم بيت لانستر.",
   "اسمك صار مزحة بين الحضور يا تافه.",
   "وش تبي يا خسيس، تكمل الكذب ولا تعترف؟",
   "يا نذل، خيانتك أضعف من سهم برون الوحيد.",
   "يا حقير، حتى الفلتر ما يقدر يحسّن صورتك بعد هالفضيحة.",
   "زق أعذارك، حتى الذكاء الاصطناعي يرفض يصدقها.",
   "أنت زق حقيقي يا تافه، والكل شايف هالحقيقة غيرك بس.",
   "أنا بريء وأنت اللي زق حقيقي يمشي بيننا.",
   "زبالة رقمية بمعنى الكلمة يا وقح.",
   "اسكت يا وقح، كلامك أضعف من دفاع طفل عن كسر كاسة.",
   "اسمع يا تافه، محد مصدقك من الجملة الأولى.",
   "لا تكون وقح وتتهمني وأنت أول المشتبه فيهم.",
   "يا خسيس، لو فيه لايك للكذب، كنت وصلت مليون بسهولة.",
   "يا حقير، الكل يشوف إنك أنت الخاين مو أنا.",
   "زبالة بمعنى الكلمة، حتى تايوين يرفض يوظفك.",
   "زق كل هالاتهامات، ما فيها ولا كلمة صح.",
   "لو الغباء جريمة، كنت أول مُعدَم من الجولة الأولى يا خسيس.",
   "كل زق مو أنا، اسألوا اللي يستاهل الشك الحقيقي.",
   "يا خسيس، حتى سيرة العرش ما فيها خاين بهالمستوى.",
   "يا كلب، انبح على غيري مو عليّ.",
   "أنت أضعف من كلمة سر \"123456\" يا تافه.",
   "خل الزق يطلع منك وتعترف زي الرجّال.",
   "يا حقير، حتى الوحوش البيضاء أشرف منك.",
   "يا خسيس، خيانتك وصمة عار على المجلس كله.",
   "يا حقير، ليش ما تجاوب على السؤال زي الرجّال؟",
   "أنت أرخص من إنك تستاهل ردي عليك يا تافه.",
   "لست تافهًا لأدافع عن نفسي أمام دنيء مثلك.",
   "زق اتهامك، أنا ما لي خلق أرد عليك أصلًا.",
   "يا وقح، شكلك بريء بس عقلك يفضحك من بعيد."
 ], fusha: [
   "أيها الخسيس، رأيناك تحاول العبث بعقولنا.",
   "أيها الخسيس، رأيناك تلعب دور الضحية بذكاء ناقص.",
   "أيها الحقير، لماذا لا تجيب كالرجال؟",
   "أيها الحقير، حتى التقييمات تطلب حذفك من هذا المجلس.",
   "اعترف أيها الوقح، قبل أن نجعل منك حديث المجلس بأسره.",
   "أنت أطول محاضرة كذب حضرتها في حياتي أيها التافه.",
   "أيها الحقير، هذه الليلة نهايتك، وتستحقها تمامًا.",
   "أيها الخسيس، خيانتك عاجزة حتى الخوارزميات عن تفسيرها.",
   "اعترف أيها النذل، حتى خوارزميات الشهرة ترفض الترويج لك.",
   "أيها الحقير، الجميع يرى أنك الخائن لا أنا.",
   "انبح على غيري لا عليّ أيها الدنيء.",
   "أيها الخسيس، خيانتك أبطأ من الإنترنت في أوقات الذروة.",
   "أنت أبطأ اعترافًا من تحميل ملف دون اتصال بالشبكة أيها التافه.",
   "اسمك بات مقترنًا بالخيانة أيها الحقير.",
   "أيها الوقح، أتجرؤ على اتهامي وأنت الخائن الحقيقي؟",
   "كفى نفاقًا أيها الوقح، الجميع يرى حقيقتك.",
   "أيها الخسيس، خيانتك عتيقة الطراز وتحتاج تحديثًا عاجلًا.",
   "أيها الخسيس، لو كان للكذب تقييم، لحصلت على أعلى الأرقام.",
   "اعترف يا تافه قبل لا تصير أضحوكة المجلس كله.",
   "أنت أضعف من كلمة سر يخمنها طفل أيها التافه.",
   "زبالتك تحتاج إلى إعادة تدوير، ولا أحد يقبل بها أيها النذل.",
   "أيها الحقير، حتى الموتى البيض أشرف منك.",
   "أغلق فمك أيها الوقح، لا أحد يصدق أكاذيبك.",
   "لا يضحكني كلامك التافه أيها الخسيس.",
   "أيها الحقير، حتى طريق العودة أمامك بات مقطوعًا.",
   "أيها النذل، رأيناك تحاول خداع المجلس بأكمله.",
   "حجتك أوهى من انقطاع الإنترنت وقت الامتحان أيها التافه.",
   "اعترف أيها التافه، حتى محركات البحث عاجزة عن إيجاد براءتك.",
   "أعذارك يرد عليها حتى الروبوت بذكاء يفوقك أيها الدنيء.",
   "أيها الخسيس، حتى كذبتك تفتقر إلى الإبداع.",
   "أيها النذل، لماذا تحاول تلطيخ سمعتي بكلامك الفارغ؟",
   "أيها الدنيء، خيانتك واضحة وضوح الشمس.",
   "اعترف أيها التافه، فالجميع عرف حقيقتك منذ اللحظة الأولى.",
   "أيها الخسيس، حتى حكايات هذا العرش لم تشهد خائنًا بمستواك.",
   "أيها الخسيس، لو كانت الغباء عملة، لكنت من أثرى الأثرياء.",
   "لو كانت الوقاحة مهنة، لكنت مديرها التنفيذي أيها النذل.",
   "اسمع أيها التافه، لا أحد يصدقك منذ الجملة الأولى.",
   "زبالة رقمية بمعنى الكلمة أيها الوقح.",
   "أعذارك أيها النذل لا يكفيها وصف واحد من فرط سخفها.",
   "أنت أرخص من أن تستحق ردًا مني أيها التافه."
 ] },
};

const GOT_BOT_M = ['ريان','فارس','معاذ','زياد','وليد','باسل','أيمن','عمار','هيثم','سامي'];
const GOT_BOT_F = ['ليان','رزان','مها','بشرى','سلمى','رغد','وفاء','أروى','نجود','ملاك'];

// يختار جملة تناسب لهجة القائل وجنس المتهَم؛ المحايدة تصلح للاثنين
function gotPick(kind, dialect, targetGender) {
  let pool;
  if (kind === 'accuse') {
    const g = GOT_LINES.accuse[targetGender === 'f' ? 'f' : 'm'][dialect] || [];
    const any = GOT_LINES.accuse.any[dialect] || [];
    pool = g.concat(any);
  } else {
    pool = (GOT_LINES[kind] && GOT_LINES[kind][dialect]) || [];
  }
  if (!pool.length) pool = (GOT_LINES.idle[dialect] || GOT_LINES.idle.najdi);
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function gotLannisterCount(n){ return n>=10?3:n>=7?2:1; }
function gotDefaultConfig(n){
  return { varys:true, melisandre:n>=6, hound:n>=8, baelish:n>=5, lovers:false, craster:false, bronn:false, faceless:false };
}
function gotBuildRoles(n, cfg){
  const roles=[];
  const lc = gotLannisterCount(n);
  if(lc===3) roles.push('tywin','cersei','joffrey');
  else if(lc===2) roles.push('tywin','cersei');
  else roles.push('cersei');
  if(cfg.varys) roles.push('varys');
  if(cfg.melisandre) roles.push('melisandre');
  if(cfg.hound) roles.push('hound');
  if(cfg.baelish) roles.push('baelish');
  if(cfg.lovers) roles.push('robb','talisa');
  if(cfg.craster) roles.push('craster');
  if(cfg.bronn) roles.push('bronn');
  if(cfg.faceless) roles.push('faceless');
  while(roles.length<n) roles.push('stark');
  while(roles.length>n) roles.pop();
  return roles;
}


// ══════════════════════ لمن العرش؟ — رسائل الغراب (فاريس وبيليش) ══════════════════════
// جُمل جاهزة فقط، بلا كتابة حرة: تمنع الإساءة وتخلّي الرسالة بنكهة الدور.
// بيليش: عروض تحالف وإغراء. فاريس: همس من يعرف ولاءك — ولا يرسل إلا لمن كشفه فعلًا.
const GOT_RAVEN = {
  baelish: [
    "الفوضى سُلّم، ومن يخشى الصعود يبقى في القاع. ثِق بي أرفعك معي.",
    "أنا إلى جانبك منذ هذه الليلة؛ صوّت كما أصوّت، ولا تسألني عن السبب.",
    "أعرف ولاء كل من في هذا المجلس، واسمٌ واحد يكفيك — وثمنه صوتك.",
    "لا تدافع عني في الجلسة؛ من يدافع عني يُشنق مكاني.",
    "من سيتّهمك غدًا يعلم أنك بريء، وهذا وحده سبب اتهامه لك.",
    "امنحني ثقتك مرة واحدة، وسيعود إليك الغراب بالأسماء لا بالوعود.",
    "لا أنحاز إلا إلى الجانب الرابح، فاجعله جانبك.",
    "إن سقطتُ غدًا، فتذكّر أنني كنتُ الوحيد الذي بعث إليك.",
  ],
  varys: [
    "رأتك عصافيري في الظلام، فنمتُ بعدها مطمئنًا.",
    "أعرف حقيقتك، ولستُ ممن يقولون كل ما يعرفون؛ فتصرّف بحكمة غدًا.",
    "لا تسألني كيف عرفت، واكتفِ بأنني عرفتُ وما زلتُ صامتًا.",
    "أنا لا أخدم ملكًا، بل أخدم المملكة؛ فإن كنتَ معها فأنت في أمان مني.",
    "في الليلة التي كشفتك فيها لم أُخبر أحدًا، وقد أُخبرهم غدًا إن أجبرتني.",
    "ابقَ قريبًا مني في التصويت، ولا تلفت الأنظار إليّ.",
    "همسة واحدة تكفي لهدم بيت، فلا تدفعني إلى الهمس عنك.",
    "صوّت غدًا لمن أصوّت له، وسيصلك غرابٌ آخر.",
  ],
};


export class GotRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map();
    // من أعلن دعمه لواجهة الغراب — ما ننتظر إلا هؤلاء، وإلا تجمّدت الليلة على نسخة قديمة مخزّنة في المتصفح
    this.ravenClients = new Set();
    this.state.blockConcurrencyWhile(async () => {
      this.room = (await this.state.storage.get('room')) || {
        code: null, hostId: null, phase: 'lobby',
        players: [], // {id,name,gender,alive,role,partnerId,connected,usedRevive}
        config: { varys:true, melisandre:false, hound:false, baelish:false, lovers:false, craster:false, bronn:false, faceless:false },
        nightActions: {}, nightNum: 0, deathsTotal: 0,
        crasterTransformed: false, bronnArrowUsed: false, bronnContract: null, baelishSide: null,
        accuseVotes: {}, accusedId: null, finalVotes: {},
        lastDeaths: [],
        ravenUsed: {}, ravenPending: [], ravenLog: {}, varysKnown: [],
      };
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/ws')) return this.handleWebSocket(request);
    if (url.pathname.endsWith('/create')) return this.handleCreate(request);
    return new Response('غير موجود', { status: 404 });
  }

  async handleCreate(request) {
    let body;
    try { body = await request.json(); } catch { return new Response('bad-json', { status: 400 }); }
    const { name, gender, roomCode } = body || {};
    if (this.room.code && this.room.players.length && this.room.phase !== 'over') {
      return new Response('room-exists', { status: 409 });
    }
    this.room.code = roomCode;
    const hostId = crypto.randomUUID();
    const hostToken = newSeatToken();
    this.room.hostId = hostId;
    this.room.players = [{ id: hostId, name: cleanName(name), gender: gender || 'm', alive: true, role: null, partnerId: null, connected: false, usedRevive: false, seatToken: hostToken }];
    await this.persist();
    return Response.json({ roomCode: this.room.code, playerId: hostId, seatToken: hostToken });
  }

  async handleWebSocket(request) {
    const url = new URL(request.url);
    const playerId = url.searchParams.get('playerId');
    const name = url.searchParams.get('name');
    const gender = url.searchParams.get('gender') || 'm';
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('يتطلب WebSocket', { status: 426 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    // ── الهوية بالتوكن السري فقط (نفس علّة مافيا: المعرّف يُبَث للجميع) ──
    const token = url.searchParams.get('token');
    let player = this.seatByToken(token);

    if (player) {
      const oldId = player.id;
      const newId = (validPlayerId(playerId) && !this.room.players.some(p => p.id === playerId)) ? playerId : oldId;
      if (newId !== oldId && !this.room.players.some(p => p.id === newId)) {
        player.id = newId;
        if (this.room.hostId === oldId) this.room.hostId = newId;
        this.remapId(oldId, newId);
        const stale = this.sockets.get(oldId);
        if (stale) { try { stale.close(); } catch {} }
        this.sockets.delete(oldId);
      } else {
        const stale = this.sockets.get(oldId);
        if (stale && stale !== server) { try { stale.close(); } catch {} }
      }
    }

    // ع-١ · رمز لم تُنشأ له غرفة: لا نُنشئها من اتصال WebSocket.
    // بدون هذا يتجاوز المهاجم حدّ allowCreate بالكامل ويفرّخ غرفًا بلا سقف.
    if (!player && !this.room.code) {
      server.send(JSON.stringify({ type: 'error', message: 'ما فيه غرفة بهذا الرمز' }));
      server.close();
      return new Response(null, { status: 101, webSocket: client });
    }

    if (!player) {
      if (this.room.phase !== 'lobby') {
        server.send(JSON.stringify({ type: 'error', message: 'اللعبة بدأت، ما تقدر تنضم الحين' }));
        server.close();
        return new Response(null, { status: 101, webSocket: client });
      }
      if (this.room.players.length >= MAX_PLAYERS) {
        server.send(JSON.stringify({ type: 'error', message: 'الغرفة ممتلئة' }));
        server.close();
        return new Response(null, { status: 101, webSocket: client });
      }
      player = { id: crypto.randomUUID(), name: cleanName(name), gender, alive: true, role: null, partnerId: null, connected: true, usedRevive: false, seatToken: newSeatToken() };
      this.room.players.push(player);
    } else {
      player.connected = true;
    }
    if (!player.seatToken) player.seatToken = newSeatToken();

    this.sockets.set(player.id, server);
    server.addEventListener('message', evt => this.onMessage(player.id, evt));
    server.addEventListener('close', () => this.onClose(player.id));

    await this.persist();
    this.broadcastLobby();
    this.sendPrivate(player.id, {
      type: 'welcome', playerId: player.id, roomCode: this.room.code,
      seatToken: player.seatToken,
    });
    if (player.role) this.sendPrivate(player.id, this.roleMessageFor(player));
    if (this.room.phase !== 'lobby') this.sendRoundStateTo(player.id);

    return new Response(null, { status: 101, webSocket: client });
  }

  remapId(oldId, newId) {
    const na = this.room.nightActions || {};
    for (const k of Object.keys(na)) {
      if (na[k] === oldId) na[k] = newId;
      else if (na[k] && typeof na[k] === 'object') {
        if (oldId in na[k]) { na[k][newId] = na[k][oldId]; delete na[k][oldId]; }
        for (const j of Object.keys(na[k])) if (na[k][j] === oldId) na[k][j] = newId;
      }
    }
    for (const bag of ['accuseVotes', 'finalVotes']) {
      const b = this.room[bag];
      if (!b) continue;
      if (oldId in b) { b[newId] = b[oldId]; delete b[oldId]; }
      for (const k of Object.keys(b)) if (b[k] === oldId) b[k] = newId;
    }
    if (this.room.accusedId === oldId) this.room.accusedId = newId;
    if (this.room.bronnContract === oldId) this.room.bronnContract = newId;
    for (const p of this.room.players) if (p.partnerId === oldId) p.partnerId = newId;
  }

  async onMessage(playerId, evt) {
    if (!this.allowMsg(playerId)) return;
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'updateConfig' && playerId === this.room.hostId) {
      this.room.config = sanitizeGotConfig(msg.config);
      await this.persist(); this.broadcastLobby();
    }
    if (msg.type === 'kickPlayer' && playerId === this.room.hostId && this.room.phase === 'lobby') await this.kickPlayer(msg.targetId);
    if (msg.type === 'addBot' && playerId === this.room.hostId && this.room.phase === 'lobby') await this.addBot(msg.gender, msg.dialect);
    if (msg.type === 'removeBot' && playerId === this.room.hostId && this.room.phase === 'lobby') await this.removeBot(msg.targetId);
    if (msg.type === 'setAdultMode' && playerId === this.room.hostId) { this.room.adultMode = !!msg.on; await this.persist(); this.broadcastLobby(); }
    if (msg.type === 'startGame' && playerId === this.room.hostId) await this.startGame();
    if (msg.type === 'nightAction' && this.room.phase === 'night') await this.handleNightAction(playerId, msg);
    if (msg.type === 'baelishAlign') await this.handleBaelishAlign(playerId, msg.side);
    if (msg.type === 'ravenSend') await this.handleRavenSend(playerId, msg);
    if (msg.type === 'ravenSkip') await this.handleRavenSkip(playerId);
    if (msg.type === 'ravenReady') this.ravenClients.add(playerId);
    if (msg.type === 'startAccusation' && playerId === this.room.hostId && this.room.phase === 'day') await this.startAccusation();
    if (msg.type === 'accuseVote' && this.room.phase === 'accusing') await this.handleAccuseVote(playerId, msg.targetId);
    if (msg.type === 'startFinalVote' && playerId === this.room.hostId && this.room.phase === 'trial') await this.startFinalVote();
    if (msg.type === 'finalVote' && this.room.phase === 'finalVoting') await this.handleFinalVote(playerId, msg.guilty);
    if (msg.type === 'hostForceAdvance' && playerId === this.room.hostId) await this.forceAdvance();
  }

  async onClose(playerId) {
    const p = this.findPlayer(playerId);
    if (p) p.connected = false;
    this.sockets.delete(playerId);
    this.migrateHostIfNeeded();
    await this.persist();
    this.broadcastLobby();
    await this.maybeAdvanceOnDisconnect();
  }

  // نقل المضيف تلقائيًا لو انقطع — بدونها تتجمّد الغرفة نهائيًا
  migrateHostIfNeeded() {
    const host = this.room.players.find(p => p.id === this.room.hostId);
    if (host && host.connected) return false;
    const next = this.room.players.find(p => p.connected && !p.isBot && p.id !== this.room.hostId);
    if (!next) return false;
    this.room.hostId = next.id;
    this.broadcastPublic({ type: 'hostChanged', hostId: next.id, hostName: next.name });
    return true;
  }

  async kickPlayer(targetId) {
    if (targetId === this.room.hostId) return;
    const target = this.findPlayer(targetId);
    if (!target) return;
    this.sendPrivate(targetId, { type: 'kicked' });
    const ws = this.sockets.get(targetId);
    if (ws) { try { ws.close(); } catch {} this.sockets.delete(targetId); }
    this.room.players = this.room.players.filter(p => p.id !== targetId);
    await this.persist();
    this.broadcastLobby();
  }

  alivePlayers(){ return this.room.players.filter(p=>p.alive); }
  findPlayer(id){ return this.room.players.find(p=>p.id===id); }
  // المنقطع ما نُنتظره — وإلا تجمّدت الليلة أو التصويت
  isHere(p){ return !!p && (p.isBot || p.connected); }
  presentRole(role){ return this.alivePlayers().some(p=>p.role===role && this.isHere(p)); }
  votersExpected(){ return this.alivePlayers().filter(p=>this.isHere(p)).length; }
  finalVotersExpected(){ return this.alivePlayers().filter(p=>this.isHere(p) && p.id!==this.room.accusedId).length; }
  async maybeAdvanceOnDisconnect(){
    if (this.room.phase==='night' && this.allNightActionsIn()) await this.resolveNight();
    else if (this.room.phase==='accusing' && this.votersExpected()>0 && Object.keys(this.room.accuseVotes).length>=this.votersExpected()) await this.resolveAccusation();
    else if (this.room.phase==='finalVoting' && this.finalVotersExpected()>0 && Object.keys(this.room.finalVotes).length>=this.finalVotersExpected()) await this.resolveFinalVote();
  }
  // ═══════════ البوتات ═══════════
  async addBot(wanted, dialect){
    if (this.room.players.length >= MAX_PLAYERS) {
      this.sendPrivate(this.room.hostId, { type:'error', message:'الغرفة ممتلئة' });
      return;
    }
    const gender = (wanted === 'm' || wanted === 'f') ? wanted : (Math.random() < 0.5 ? 'm' : 'f');
    const used = new Set(this.room.players.map(p => p.name));
    const pool = gender === 'f' ? GOT_BOT_F : GOT_BOT_M;
    const name = pool.find(n => !used.has(n))
      || GOT_BOT_M.concat(GOT_BOT_F).find(n => !used.has(n))
      || ('بوت' + (this.room.players.length + 1));
    this.room.players.push({
      id: 'bot-' + crypto.randomUUID(), name, gender, alive: true, role: null,
      partnerId: null, connected: true, usedRevive: false, isBot: true,
      dialect: (dialect === 'fusha' || dialect === 'najdi') ? dialect : (Math.random() < 0.5 ? 'fusha' : 'najdi'),
    });
    await this.persist();
    this.broadcastLobby();
  }

  async removeBot(targetId){
    const t = this.findPlayer(targetId);
    if (!t || !t.isBot) return;
    this.room.players = this.room.players.filter(p => p.id !== targetId);
    await this.persist();
    this.broadcastLobby();
  }

  // البوت يتكلم: الجملة تُبنى بلهجته وتطابق جنس من يتهمه
  botSay(bot, kind, target){
    const harsh = this.room.adultMode && Math.random() < 0.35;
    let txt = gotPick(harsh ? 'harsh' : kind, bot.dialect || 'najdi', target ? target.gender : 'm');
    if (!txt) return;
    if (target) txt = txt.split('{t}').join(target.name);
    else txt = txt.split('{t}').join('أحدهم');
    this.broadcastPublic({ type:'botSpeak', id:bot.id, name:bot.name, gender:bot.gender, text:txt, phase:this.room.phase });
  }

  // أفعال الليل التلقائية — بدونها تعلّق الليلة على البوتات
  autoBotNight(){
    const na = this.room.nightActions;
    const alive = this.alivePlayers();
    const leader = this.leaderPlayer();
    for (const bot of alive.filter(p => p.isBot)) {
      const others = alive.filter(p => p.id !== bot.id);
      if (!others.length) continue;
      if (leader && bot.id === leader.id) {
        const prey = alive.filter(p => GOT_ROLES[p.role].team !== 'lannister');
        if (prey.length && na.kill === undefined) na.kill = pickRandom(prey).id;
        continue;
      }
      switch (bot.role) {
        case 'varys':
          if (na.inspectTarget === undefined) na.inspectTarget = pickRandom(others).id;
          break;
        case 'melisandre':
          if (na.protectTarget === undefined && na.reviveTarget === undefined) na.protectTarget = pickRandom(alive).id;
          break;
        case 'hound':
          if (na.guardTarget === undefined) na.guardTarget = pickRandom(others).id;
          break;
        case 'craster':
          if (this.room.crasterTransformed && na.crasterKill === undefined) na.crasterKill = pickRandom(others).id;
          break;
        case 'bronn':
          if (!this.room.bronnArrowUsed && !na.bronnResponded) {
            // نادرًا يصرف سهمه الوحيد
            na.bronnTarget = Math.random() < 0.2 ? pickRandom(others).id : null;
            na.bronnResponded = true;
          }
          break;
        case 'baelish':
          if (this.room.baelishSide === null && this.room.deathsTotal >= 2) {
            this.room.baelishSide = Math.random() < 0.5 ? 'lannister' : 'stark';
          }
          break;
      }
    }
  }

  // اتهام تلقائي + جملة اتهام مطابقة لجنس المتهَم
  autoBotAccuse(){
    const alive = this.alivePlayers();
    for (const bot of alive.filter(p => p.isBot)) {
      if (this.room.accuseVotes[bot.id] !== undefined) continue;
      const others = alive.filter(p => p.id !== bot.id);
      if (!others.length) continue;
      // البوت اللانستري ما يتهم رفيقه إن قدر
      const mine = GOT_ROLES[bot.role].team;
      let pool = others;
      if (mine === 'lannister') {
        const outs = others.filter(p => GOT_ROLES[p.role].team !== 'lannister');
        if (outs.length) pool = outs;
      }
      const target = Math.random() < 0.85 ? pickRandom(pool) : null;
      this.room.accuseVotes[bot.id] = target ? target.id : null;
      if (target) this.botSay(bot, 'accuse', target);
    }
  }

  // حكم نهائي: اللانستري يميل لإدانة الغريب، والمتهَم البوت يدافع عن نفسه
  autoBotFinalVote(){
    const accused = this.findPlayer(this.room.accusedId);
    if (accused && accused.isBot && accused.alive) this.botSay(accused, 'defend', null);
    for (const bot of this.alivePlayers().filter(p => p.isBot && p.id !== this.room.accusedId)) {
      if (this.room.finalVotes[bot.id] !== undefined) continue;
      let guilty = Math.random() < 0.55;
      if (accused && GOT_ROLES[bot.role].team === 'lannister') {
        guilty = GOT_ROLES[accused.role].team === 'lannister' ? Math.random() < 0.2 : Math.random() < 0.8;
      }
      this.room.finalVotes[bot.id] = guilty;
    }
  }

  leaderPlayer(){
    for (const r of ['tywin','cersei','joffrey']) {
      const p = this.alivePlayers().find(x=>x.role===r);
      if (p) return p;
    }
    return null;
  }

  async startGame() {
    // بدون هذا الشرط يقدر المضيف يعيد توزيع الأدوار في نص اللعبة
    if (this.room.phase !== 'lobby' && this.room.phase !== 'over') return;
    const n = this.room.players.length;
    if (n < 4) { this.sendPrivate(this.room.hostId, { type:'error', message:'أقل عدد للبدء ٤ لاعبين' }); return; }
    const roles = gotBuildRoles(n, this.room.config);
    for (let i=roles.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [roles[i],roles[j]]=[roles[j],roles[i]]; }
    // تصفير حالة الجولة السابقة — وإلا ورث «متعدد الوجوه» من لعبة سابقة أو بقيت كشوف فاريس القديمة
    this.room.firstDeathDone = false;
    this.room.ravenUsed = {}; this.room.ravenPending = []; this.room.ravenLog = {}; this.room.varysKnown = [];
    this.room.deathsTotal = 0; this.room.crasterTransformed = false;
    this.room.bronnArrowUsed = false; this.room.bronnContract = null; this.room.baelishSide = null;
    this.room.accuseVotes = {}; this.room.finalVotes = {}; this.room.accusedId = null; this.room.lastDeaths = [];

    this.room.players.forEach((p,i)=>{ p.role = roles[i]; p.alive = true; p.partnerId = null; p.usedRevive = false; });
    // الربط بعد التصفير — وإلا انمسح ارتباط العاشقين توًّا
    const robb = this.room.players.find(p=>p.role==='robb');
    const talisa = this.room.players.find(p=>p.role==='talisa');
    if (robb && talisa) { robb.partnerId = talisa.id; talisa.partnerId = robb.id; }

    this.room.phase = 'night'; this.room.nightNum = 1; this.room.nightActions = {};
    this.autoBotNight();
    await this.persist();
    for (const p of this.room.players) this.sendPrivate(p.id, this.roleMessageFor(p));
    this.broadcastPublic({ type:'phaseChanged', phase:'night', nightNum:1 });
    this.sendNightState();
    if (this.allNightActionsIn()) await this.resolveNight();
  }

  roleMessageFor(player){
    const r = GOT_ROLES[player.role];
    const payload = { type:'yourRole', role:player.role, roleName:r.name, icon:r.icon, team:r.team, desc:r.desc };
    if (player.partnerId) { const partner=this.findPlayer(player.partnerId); payload.partnerName = partner?partner.name:null; }
    return payload;
  }

  /* ═══════════ الليل ═══════════ */
  async handleNightAction(playerId, msg){
    const p = this.findPlayer(playerId);
    if (!p || !p.alive) return;
    // الهدف لازم يكون لاعبًا حقيقيًا — وإلا انفجر حسم الليل وتجمّدت الغرفة.
    // الإحياء وحده يستهدف ميتًا، فيُستثنى من شرط الحياة.
    if (msg.targetId != null) {
      const tgt = this.findPlayer(msg.targetId);
      const isRevive = (p.role === 'melisandre' && msg.action === 'revive');
      if (!tgt || (!tgt.alive && !isRevive)) msg = { ...msg, targetId: null };
    }
    const na = this.room.nightActions;
    const leader = this.leaderPlayer();

    if (leader && p.id===leader.id) na.kill = msg.targetId ?? null;
    else if (p.role==='varys') {
      // النتيجة تُؤجَّل لحسم الليل: لو مات فاريس هذي الليلة ما ياخذ المعلومة ولا يسرّبها
      na.inspectTarget = msg.targetId;
    }
    else if (p.role==='melisandre') {
      if (msg.action==='revive') {
        // لو الإحياء انتهى، ما نسقط بصمت على حماية ميت — نرجّع خطأ وننتظر اختيارًا صحيحًا
        if (p.usedRevive) {
          this.sendPrivate(p.id, { type:'error', message:'استخدمتِ الإحياء مرة واحدة — اختاري حماية بدلًا منه' });
          return;
        }
        na.reviveTarget = msg.targetId; p.usedRevive = true; na.protectTarget = null;
      } else { na.protectTarget = msg.targetId; na.reviveTarget = null; }
    }
    else if (p.role==='hound') na.guardTarget = msg.targetId;
    else if (p.role==='craster') {
      if (!this.room.crasterTransformed) {
        this.sendPrivate(p.id, { type:'error', message:'ما تحوّلت بعد — ما عندك قتل هذي الليلة' });
        return;
      }
      na.crasterKill = msg.targetId;
    }
    else if (p.role==='bronn') {
      // لازم ردّ صريح: يرمي سهمه أو يتخطّى — عشان ما يُحسم الليل من تحته
      if (this.room.bronnArrowUsed) {
        this.sendPrivate(p.id, { type:'error', message:'صرفت سهمك الوحيد — ما عندك فعل هذي الليلة' });
        return;
      }
      if (msg.action==='skip') na.bronnTarget = null;
      else na.bronnTarget = msg.targetId;
      na.bronnResponded = true;
    }

    const rvs = this.ravenStateFor(p);
    if (rvs) this.sendPrivate(p.id, rvs);
    await this.persist();
    if (this.allNightActionsIn()) await this.resolveNight();
  }

  // الليلة ما تُحسم قبل ما صاحب الغراب يرسل أو يتخطّى — نفس أسلوب برون
  ravenPendingFrom(){
    return this.alivePlayers().filter(p =>
      !p.isBot && p.connected && this.ravenClients.has(p.id) &&
      (p.role === 'varys' || p.role === 'baelish') &&
      !(this.room.ravenUsed || {})[p.id] &&
      !(((this.room.nightActions || {}).ravenDone || {})[p.id]) &&
      this.ravenTargetsFor(p).length > 0);
  }

  allNightActionsIn(){
    const na = this.room.nightActions;
    const leader = this.leaderPlayer();
    if (leader && this.isHere(leader) && na.kill===undefined) return false;
    if (this.presentRole('varys') && na.inspectTarget===undefined) return false;
    if (this.presentRole('melisandre') && na.protectTarget===undefined && na.reviveTarget===undefined) return false;
    if (this.presentRole('hound') && na.guardTarget===undefined) return false;
    if (this.room.crasterTransformed && this.presentRole('craster') && na.crasterKill===undefined) return false;
    // ننتظر ردًّا من برون ما دام سهمه موجود
    const bronn = this.alivePlayers().find(p=>p.role==='bronn' && this.isHere(p));
    if (bronn && !this.room.bronnArrowUsed && !na.bronnResponded) return false;
    if (this.ravenPendingFrom().length) return false;
    return true;
  }

  async resolveNight(){
    if (this.room.phase !== 'night') return;
    this.room.phase = 'resolvingNight';
    const na = this.room.nightActions;

    // نثبّت فاريس ونتيجته قبل أي وفاة أو تغيّر حالة (كراستر/برون) — كما في منطق المحقق بمافيا
    const varysActor = this.alivePlayers().find(p=>p.role==='varys');
    let varysResult = null;
    if (na.inspectTarget) {
      const t = this.findPlayer(na.inspectTarget);
      if (t) {
        let res;
        if (t.role==='tywin') res='stark';
        else if (t.role==='baelish') res = this.room.baelishSide || null;
        else if (t.role==='craster') res = this.room.crasterTransformed ? null : 'stark';
        else if (t.role==='bronn') res = this.room.bronnArrowUsed ? (this.room.bronnContract||null) : null;
        else res = GOT_ROLES[t.role].team==='lannister' ? 'lannister' : 'stark';
        varysResult = { targetId:t.id, targetName:t.name, team:res };
      }
    }

    const deaths = new Set();
    const attempts = [];
    if (na.kill!==null && na.kill!==undefined) attempts.push(na.kill);
    if (na.crasterKill!==null && na.crasterKill!==undefined) attempts.push(na.crasterKill);
    if (na.bronnTarget!==null && na.bronnTarget!==undefined) attempts.push(na.bronnTarget);

    let crasterSurvivedAttack = false;
    const seen = new Set(); const houndDied = [];
    for (const target of attempts) {
      if (seen.has(target)) continue; seen.add(target);
      const targetPlayer = this.findPlayer(target);
      if (!targetPlayer) continue;
      if (na.protectTarget===target) {
        if (targetPlayer.role==='craster') crasterSurvivedAttack = true;
      } else if (na.guardTarget===target) {
        const hound = this.alivePlayers().find(p=>p.role==='hound');
        if (hound && hound.id!==target) { deaths.add(hound.id); houndDied.push(hound.id); if(targetPlayer.role==='craster') crasterSurvivedAttack=true; }
        else deaths.add(target);
      } else deaths.add(target);
    }

    if (crasterSurvivedAttack && !this.room.crasterTransformed) this.room.crasterTransformed = true;
    if (na.bronnTarget!==null && na.bronnTarget!==undefined && !this.room.bronnArrowUsed) {
      this.room.bronnArrowUsed = true;
      const bt = this.findPlayer(na.bronnTarget);
      const targetTeam = bt ? GOT_ROLES[bt.role].team : null;
      this.room.bronnContract = targetTeam==='lannister' ? 'stark' : (targetTeam==='stark' ? 'lannister' : null);
    }

    // موت مرتبط: روب وتاليسا
    const deadNames = [];
    const applyDeath = (id) => {
      const p = this.findPlayer(id);
      if (p && p.alive) {
        p.alive = false; this.room.deathsTotal++;
        deadNames.push({ id:p.id, name:p.name });
        this.tryInherit(p);
        if (p.partnerId) { const partner=this.findPlayer(p.partnerId); if (partner && partner.alive) applyDeath(partner.id); }
      }
    };
    for (const id of deaths) applyDeath(id);

    if (na.reviveTarget!==null && na.reviveTarget!==undefined) {
      const p = this.findPlayer(na.reviveTarget);
      if (p && !p.alive) { p.alive = true; this.room.deathsTotal = Math.max(0,this.room.deathsTotal-1); }
    }

    // تُسلَّم لفاريس فقط لو نجا الليلة (والإحياء يُحتسب)
    if (varysResult && varysActor && varysActor.alive) {
      this.sendPrivate(varysActor.id, { type:'investigateResult', ...varysResult });
      this.room.varysKnown = this.room.varysKnown || [];
      if (!this.room.varysKnown.includes(varysResult.targetId)) this.room.varysKnown.push(varysResult.targetId);
    }

    this.room.nightNum++;
    if (!this.room.crasterTransformed) {
      const craster = this.room.players.find(p=>p.role==='craster');
      if (craster && this.room.nightNum>=4) this.room.crasterTransformed = true;
    }

    this.room.nightActions = {};
    this.room.phase = 'day';
    this.room.lastDeaths = deadNames;
    this.room.lastNightNum = this.room.nightNum - 1;
    this.deliverRavens();
    await this.persist();
    this.broadcastPublic({ type:'dawnResult', nightNum:this.room.lastNightNum, deaths:deadNames });
    this.broadcastLobby();
    this.maybePromptBaelish();

    const winner = this.checkWin();
    if (winner) await this.endGame(winner);
  }

  // يخبر كل لاعب بحالة الليل اللي تحدّد أهليته — بدونها تضيع أدوار كراستر وبرون وميليساندرا
  sendNightState(){
    for (const p of this.alivePlayers()) {
      this.sendPrivate(p.id, {
        type: 'nightState',
        crasterTransformed: this.room.crasterTransformed,
        bronnArrowUsed: this.room.bronnArrowUsed,
        usedRevive: !!p.usedRevive,
      });
      const rv = this.ravenStateFor(p);
      if (rv) this.sendPrivate(p.id, rv);
    }
  }

  maybePromptBaelish(){
    if (this.room.baelishSide===null && this.room.deathsTotal>=2) {
      const bae = this.alivePlayers().find(p=>p.role==='baelish');
      if (bae) this.sendPrivate(bae.id, { type:'baelishChoice' });
    }
  }
  async handleBaelishAlign(playerId, side){
    const p = this.findPlayer(playerId);
    if (!p || p.role!=='baelish' || this.room.baelishSide!==null) return;
    if (side!=='lannister' && side!=='stark') return;
    this.room.baelishSide = side;
    await this.persist();
  }

  /* ═══════════ النهار: اتهام سري ثم محاكمة ثم حكم نهائي ═══════════ */
  async startAccusation(){
    this.room.phase = 'accusing'; this.room.accuseVotes = {};
    this.autoBotAccuse();
    await this.persist();
    this.broadcastPublic({ type:'phaseChanged', phase:'accusing' });
    const expA0 = this.votersExpected();
    if (expA0 > 0 && Object.keys(this.room.accuseVotes).length >= expA0) await this.resolveAccusation();
  }
  async handleAccuseVote(playerId, targetId){
    const voter = this.findPlayer(playerId);
    if (!voter || !voter.alive) return;
    // لازم يكون الهدف لاعبًا حيًّا فعلًا — وإلا اتُّهم اسم وهمي وانهارت المحاكمة
    if (targetId) {
      const t = this.findPlayer(targetId);
      if (!t || !t.alive) return;
    }
    this.room.accuseVotes[playerId] = targetId || null;
    await this.persist();
    const expA = this.votersExpected();
    this.broadcastPublic({ type:'voteUpdate', votesIn:Object.keys(this.room.accuseVotes).length, totalAlive:expA });
    if (expA > 0 && Object.keys(this.room.accuseVotes).length >= expA) await this.resolveAccusation();
  }
  async resolveAccusation(){
    if (this.room.phase !== 'accusing') return;
    this.room.phase = 'resolvingAccusation';
    const tally = {};
    for (const t of Object.values(this.room.accuseVotes)) { if (t) tally[t]=(tally[t]||0)+1; }
    const entries = Object.entries(tally);
    let accusedId = null;
    if (entries.length) {
      const max = Math.max(...entries.map(e=>e[1]));
      const top = entries.filter(e=>e[1]===max);
      accusedId = top[Math.floor(Math.random()*top.length)][0];
    }
    this.room.accusedId = accusedId;
    await this.persist();
    if (accusedId) {
      const p = this.findPlayer(accusedId);
      this.room.phase = 'trial';
      await this.persist();
      this.broadcastPublic({ type:'trialStarted', accusedId, accusedName:p.name });
    } else {
      this.broadcastPublic({ type:'noAccusation' });
      await this.startNextNight();
    }
  }

  async startFinalVote(){
    this.room.phase = 'finalVoting'; this.room.finalVotes = {};
    this.autoBotFinalVote();
    await this.persist();
    this.broadcastPublic({ type:'phaseChanged', phase:'finalVoting' });
    const expF0 = this.finalVotersExpected();
    if (expF0 > 0 && Object.keys(this.room.finalVotes).length >= expF0) await this.resolveFinalVote();
  }
  async handleFinalVote(playerId, guilty){
    const voter = this.findPlayer(playerId);
    if (!voter || !voter.alive || voter.id===this.room.accusedId) return;
    this.room.finalVotes[playerId] = !!guilty;
    await this.persist();
    const eligible = this.finalVotersExpected();
    this.broadcastPublic({ type:'voteUpdate', votesIn:Object.keys(this.room.finalVotes).length, totalAlive:eligible });
    if (eligible > 0 && Object.keys(this.room.finalVotes).length >= eligible) await this.resolveFinalVote();
  }
  async resolveFinalVote(){
    if (this.room.phase !== 'finalVoting') return;
    this.room.phase = 'resolvingFinalVote';
    const votes = Object.values(this.room.finalVotes);
    const guiltyCount = votes.filter(v=>v).length;
    const executed = guiltyCount > votes.length/2;
    let name=null, roleName=null;
    const alsoDead = [];
    if (executed) {
      const p = this.findPlayer(this.room.accusedId);
      p.alive = false; this.room.deathsTotal++;
      name = p.name; roleName = GOT_ROLES[p.role].name;
      this.tryInherit(p);
      // الشريك يموت معه — ولازم يُعلن، وإلا بقي ظاهرًا حيًّا للجماعة وبنوا تصويتهم على معلومة غلط
      if (p.partnerId) {
        const partner = this.findPlayer(p.partnerId);
        if (partner && partner.alive) {
          partner.alive = false; this.room.deathsTotal++;
          alsoDead.push({ id: partner.id, name: partner.name, roleName: GOT_ROLES[partner.role].name });
        }
      }
    }
    await this.persist();
    this.broadcastPublic({ type:'verdictResult', executed, name, roleName, alsoDead });
    this.broadcastLobby();
    this.maybePromptBaelish();
    const winner = this.checkWin();
    if (winner) { await this.endGame(winner); return; }
    await this.startNextNight();
  }

  async startNextNight(){
    this.room.phase = 'night'; this.room.nightActions = {};
    this.autoBotNight();
    await this.persist();
    this.broadcastPublic({ type:'phaseChanged', phase:'night', nightNum:this.room.nightNum });
    this.sendNightState();
    if (this.allNightActionsIn()) await this.resolveNight();
  }

  checkWin(){
    const alive = this.alivePlayers();
    const lannAlive = alive.filter(p=>GOT_ROLES[p.role].team==='lannister').length;
    const total = alive.length;
    const craster = this.room.players.find(p=>p.role==='craster');
    const crasterThreat = craster && craster.alive && this.room.crasterTransformed;
    if (crasterThreat && total===1) return 'craster';
    if (crasterThreat) return null;
    if (lannAlive===0) return 'stark';
    const bae = alive.find(p=>p.role==='baelish');
    const baeLann = (bae && this.room.baelishSide==='lannister') ? 1 : 0;
    if (lannAlive+baeLann >= total-(lannAlive+baeLann)) return 'lannister';
    return null;
  }

  async endGame(winner){
    this.room.phase = 'over';
    await this.persist();
    this.broadcastPublic({
      type:'gameOver', winner,
      players: this.room.players.map(p=>({ id:p.id, name:p.name, role:p.role, roleName:GOT_ROLES[p.role].name, alive:p.alive })),
      baelishSide: this.room.baelishSide,
    });
  }

  /* ═══════════ بث ═══════════ */
  broadcastLobby(){
    const publicPlayers = this.room.players.map(p=>({ id:p.id, name:p.name, gender:p.gender, connected:p.connected, alive:p.alive, isBot:!!p.isBot }));
    this.broadcastPublic({ type:'lobbyUpdate', players:publicPlayers, hostId:this.room.hostId, config:this.room.config, adultMode:!!this.room.adultMode });
  }

  // إعادة إرسال حالة الجولة لمن أعاد الاتصال أثناء اللعب
  sendRoundStateTo(playerId){
    if (this.room.phase === 'night') {
      this.sendPrivate(playerId, { type:'phaseChanged', phase:'night', nightNum:this.room.nightNum });
      const me = this.findPlayer(playerId);
      if (me && me.alive) {
        this.sendPrivate(playerId, {
          type: 'nightState',
          crasterTransformed: this.room.crasterTransformed,
          bronnArrowUsed: this.room.bronnArrowUsed,
          usedRevive: !!me.usedRevive,
        });
        const rv = this.ravenStateFor(me);
        if (rv) this.sendPrivate(playerId, rv);
      }
    }
    const mine = (this.room.ravenLog || {})[playerId];
    if (mine && mine.length) this.sendPrivate(playerId, { type:'ravenHistory', items: mine });
    if (this.room.phase === 'day') {
      this.sendPrivate(playerId, { type:'dawnResult', nightNum:this.room.lastNightNum||this.room.nightNum, deaths:this.room.lastDeaths||[] });
    } else if (this.room.phase === 'accusing') {
      this.sendPrivate(playerId, { type:'phaseChanged', phase:'accusing' });
    } else if (this.room.phase === 'trial') {
      const p = this.findPlayer(this.room.accusedId);
      this.sendPrivate(playerId, { type:'trialStarted', accusedId:this.room.accusedId, accusedName:p?p.name:'' });
    } else if (this.room.phase === 'finalVoting') {
      this.sendPrivate(playerId, { type:'phaseChanged', phase:'finalVoting' });
    }
  }

  // صمام أمان: المضيف يقدر يفرض حسم المرحلة لو علقت
  async forceAdvance(){
    if (this.room.phase === 'night') await this.resolveNight();
    else if (this.room.phase === 'accusing') await this.resolveAccusation();
    else if (this.room.phase === 'finalVoting') await this.resolveFinalVote();
  }

  broadcastPublic(payload){
    const json = JSON.stringify(payload);
    for (const ws of this.sockets.values()) { try { ws.send(json); } catch {} }
  }
  sendPrivate(playerId, payload){
    const ws = this.sockets.get(playerId);
    if (ws) { try { ws.send(JSON.stringify(payload)); } catch {} }
  }
  /* ═══════════ متعدد الوجوه ═══════════ */
  // يرث دور وفريق أول من يموت في اللعبة — مرة واحدة فقط، أيًّا كان دوره
  tryInherit(deadPlayer){
    if (this.room.firstDeathDone) return;
    this.room.firstDeathDone = true;
    const fl = this.room.players.find(p => p.alive && p.role === 'faceless');
    if (!fl || fl.id === deadPlayer.id) return;
    fl.role = deadPlayer.role;
    fl.partnerId = null;   // ارتباط العاشقين يموت مع صاحبه
    fl.usedRevive = false; // يبدأ قدرات الدور من جديد
    const info = GOT_ROLES[fl.role];
    if (fl.isBot) return;
    this.sendPrivate(fl.id, {
      type: 'roleInherited', role: fl.role, roleName: info.name,
      icon: info.icon, team: info.team, desc: info.desc,
      note: 'سقط ' + deadPlayer.name + ' فلبستَ وجهه — صرتَ الآن: ' + info.name,
    });
  }

  /* ═══════════ رسائل الغراب ═══════════ */
  // من يملك غرابًا: فاريس (لمن كشفه فقط) وبيليش (لأي حي). غراب واحد لكل ليلة.
  ravenTargetsFor(p){
    if (!p || !p.alive) return [];
    if (p.role === 'baelish') return this.alivePlayers().filter(x => x.id !== p.id);
    if (p.role === 'varys') {
      const known = (this.room.varysKnown || []).slice();
      // أول ما ينكشف له اللاعب يقدر يبعث له — حتى في نفس الليلة
      const cur = (this.room.nightActions || {}).inspectTarget;
      if (cur && !known.includes(cur)) known.push(cur);
      return this.alivePlayers().filter(x => x.id !== p.id && known.includes(x.id));
    }
    return [];
  }

  ravenStateFor(p){
    if (!p || !p.alive || (p.role !== 'varys' && p.role !== 'baelish')) return null;
    const used = !!(this.room.ravenUsed || {})[p.id];
    const targets = this.ravenTargetsFor(p);
    return {
      type: 'ravenState',
      role: p.role,
      used,
      canSend: !used && targets.length > 0,
      targets: targets.map(x => ({ id: x.id, name: x.name })),
      lines: (GOT_RAVEN[p.role] || []).map((text, id) => ({ id, text })),
      note: p.role === 'varys'
        ? 'لا ترسل إلا لمن كشفت ولاءه من قبل'
        : 'ترسل إلى أي لاعب حيّ',
    };
  }

  async handleRavenSend(playerId, msg){
    if (this.room.phase !== 'night') return;
    const p = this.findPlayer(playerId);
    if (!p || !p.alive || (p.role !== 'varys' && p.role !== 'baelish')) return;
    if (!this.room.nightActions) this.room.nightActions = {};
    this.room.ravenUsed = this.room.ravenUsed || {};
    if (this.room.ravenUsed[p.id]) {
      this.sendPrivate(p.id, { type:'error', message:'غرابك طار هذه الليلة — غراب واحد لكل ليلة' });
      return;
    }
    const lines = GOT_RAVEN[p.role] || [];
    // جملة من عند اللاعب نفسه: تُنقّى وتُقصّ في السيرفر
    let text = null;
    if (msg.custom) {
      text = cleanText(msg.text, 160);
      if (text.length < 2) { this.sendPrivate(p.id, { type:'error', message:'اكتب رسالتك أولًا' }); return; }
    } else {
      const li = Number(msg.lineId);
      if (!Number.isInteger(li) || li < 0 || li >= lines.length) return;
      text = lines[li];
    }
    const t = this.findPlayer(msg.targetId);
    if (!t || !t.alive || t.id === p.id) return;
    if (!this.ravenTargetsFor(p).some(x => x.id === t.id)) {
      this.sendPrivate(p.id, { type:'error', message:'ما تقدر ترسل غرابك إلا لمن كشفته' });
      return;
    }
    this.room.ravenUsed[p.id] = true;
    this.room.nightActions.ravenDone = this.room.nightActions.ravenDone || {};
    this.room.nightActions.ravenDone[p.id] = true;
    this.room.ravenPending = this.room.ravenPending || [];
    // الهوية ما تُكشف للمستلم — الجملة وحدها هي التلميح
    this.room.ravenPending.push({ to: t.id, from: p.id, text });
    await this.persist();
    this.sendPrivate(p.id, { type:'ravenSent', targetName: t.name });
    const st = this.ravenStateFor(p); if (st) this.sendPrivate(p.id, st);
    if (this.allNightActionsIn()) await this.resolveNight();
  }

  async handleRavenSkip(playerId){
    if (this.room.phase !== 'night') return;
    const p = this.findPlayer(playerId);
    if (!p || !p.alive || (p.role !== 'varys' && p.role !== 'baelish')) return;
    if (!this.room.nightActions) this.room.nightActions = {};
    this.room.nightActions.ravenDone = this.room.nightActions.ravenDone || {};
    this.room.nightActions.ravenDone[p.id] = true;
    await this.persist();
    this.sendPrivate(p.id, { type:'ravenState', role:p.role, used:false, canSend:false, targets:[], lines:[], note:'' });
    if (this.allNightActionsIn()) await this.resolveNight();
  }

  // الغراب يطير مع الفجر: يصل حتى لو مات مُرسِله، ويسقط لو مات المستلم
  deliverRavens(){
    const pend = this.room.ravenPending || [];
    const n = this.room.lastNightNum || this.room.nightNum;
    this.room.ravenLog = this.room.ravenLog || {};
    for (const r of pend) {
      const t = this.findPlayer(r.to);
      if (!t || !t.alive) continue;
      const item = { nightNum: n, text: r.text };
      (this.room.ravenLog[t.id] = this.room.ravenLog[t.id] || []).push(item);
      this.sendPrivate(t.id, { type:'raven', ...item });
    }
    this.room.ravenPending = [];
    this.room.ravenUsed = {};
  }

  async persist(){ await this.touchRoom(); await this.state.storage.put('room', this.room); }
}


// ══════════════════════ موّه — بنك الأسئلة ══════════════════════
var BANK = [
["جغرافيا",[
["ما عاصمة أستراليا؟","كانبرا"],["ما أكبر جزيرة في العالم؟","جرينلاند"],
["ما أعلى قمة جبلية في أفريقيا؟","كليمنجارو"],["ما أصغر دولة في العالم مساحةً؟","الفاتيكان"],
["ما أكبر محيط في العالم؟","المحيط الهادئ"],["ما عاصمة كندا؟","أوتاوا"],
["ما أطول سلسلة جبال في العالم؟","الأنديز"],["ما البحر الذي تمنع ملوحته الغرق فيه؟","البحر الميت"],
["ما عاصمة المغرب؟","الرباط"],["ما الدولة المعروفة بالتوليب والطواحين؟","هولندا"],
["في أي دولة تقع مدينة إسطنبول؟","تركيا"],["ما عاصمة النرويج؟","أوسلو"]]],

["تاريخ",[
["من أول إنسان مشى على سطح القمر؟","نيل أرمسترونج"],["في أي عام سقط جدار برلين؟","١٩٨٩"],
["في أي عام بدأت الحرب العالمية الثانية؟","١٩٣٩"],["من قاد المسلمين في معركة حطين؟","صلاح الدين الأيوبي"],
["ما عاصمة الدولة الأموية؟","دمشق"],["ما عاصمة الدولة العباسية؟","بغداد"],
["ما اسم السفينة التي غرقت عام ١٩١٢؟","تايتانيك"],["أي حضارة بنت أهرامات الجيزة؟","المصرية القديمة"],
["في أي قارة قامت حضارة الإنكا؟","أمريكا الجنوبية"],["من فتح القسطنطينية؟","محمد الفاتح"],
["ضد أي دولة خاض المسلمون معركة القادسية؟","الفرس"]]],

["علوم",[
["ما الغاز الذي تمتصه النباتات من الهواء؟","ثاني أكسيد الكربون"],
["ما المعدن الوحيد السائل في درجة حرارة الغرفة؟","الزئبق"],
["ما الرمز الكيميائي للذهب؟","Au"],["عند كم درجة مئوية يغلي الماء؟","١٠٠"],
["ما اسم العملية التي تصنع بها النباتات غذاءها؟","البناء الضوئي"],
["ما أخف عنصر في الجدول الدوري؟","الهيدروجين"],["ما وحدة قياس القوة؟","نيوتن"],
["من صاحب نظرية النسبية؟","أينشتاين"],["ما أقسى مادة طبيعية معروفة؟","الألماس"],
["ما وحدة قياس شدة التيار الكهربائي؟","الأمبير"]]],

["أدب ولغة",[
["كم عدد حروف اللغة العربية؟","٢٨"],["من الملقّب بأمير الشعراء؟","أحمد شوقي"],
["من مؤلف رواية «مدن الملح»؟","عبدالرحمن منيف"],["من نقل «كليلة ودمنة» إلى العربية؟","ابن المقفع"],
["من صاحب معلقة «قفا نبكِ»؟","امرؤ القيس"],["من أول من وضع علم النحو؟","أبو الأسود الدؤلي"],
["من صاحب «المقدمة» في علم العمران؟","ابن خلدون"],["ما الاسم الحقيقي للمتنبي؟","أحمد بن الحسين"],
["من الملقّب بشاعر النيل؟","حافظ إبراهيم"],["من كتب رواية «الشيخ والبحر»؟","إرنست همنغواي"]]],

["إسلاميات",[
["كم عدد سور القرآن الكريم؟","١١٤"],["ما أطول سورة في القرآن؟","البقرة"],
["من أول الخلفاء الراشدين؟","أبو بكر الصديق"],["كم عدد أركان الإسلام؟","خمسة"],
["في أي شهر وقعت غزوة بدر؟","رمضان"],["كم ركعة في صلاة المغرب؟","ثلاث"],
["ما أول ما نزل من القرآن؟","اقرأ"],["ما القبلة الأولى للمسلمين؟","بيت المقدس"],
["كم سنة دعا نوح عليه السلام قومه؟","٩٥٠"],["ما اسم أول مسجد بُني في الإسلام؟","مسجد قباء"]]],

["رياضة",[
["كم لاعباً لكل فريق داخل ملعب كرة القدم؟","١١"],["كل كم سنة تقام بطولة كأس العالم؟","أربع"],
["كم لاعباً لكل فريق في كرة السلة؟","خمسة"],["ما الدولة الأكثر تتويجاً بكأس العالم؟","البرازيل"],
["في أي مدينة أقيمت أولمبياد ٢٠٢٠؟","طوكيو"],["كم عدد حلقات شعار الأولمبياد؟","خمس"],
["في أي رياضة يُقال «لوف» للصفر؟","التنس"],["كم دقيقة في شوط كرة القدم الواحد؟","٤٥"],
["في أي دولة نشأت رياضة الجودو؟","اليابان"],["كم عدد الأشواط في مباراة البولينغ؟","عشرة"]]],

["حيوانات",[
["ما أسرع حيوان بري؟","الفهد"],["ما أكبر حيوان على وجه الأرض؟","الحوت الأزرق"],
["ما أطول حيوان في العالم؟","الزرافة"],["ما الحيوان الذي يغيّر لونه؟","الحرباء"],
["كم قلباً للأخطبوط؟","ثلاثة"],["ما الطائر الذي لا يطير ويعدو بسرعة كبيرة؟","النعامة"],
["كم رِجلاً للعنكبوت؟","ثمان"],["ما الحيوان الملقّب بسفينة الصحراء؟","الجمل"],
["ما الحيوان الذي ينام واقفاً؟","الحصان"],["ماذا تنتج النحلة غير العسل؟","الشمع"]]],

["جسم الإنسان",[
["كم عدد عظام جسم الإنسان البالغ؟","٢٠٦"],["ما أكبر عضو في جسم الإنسان؟","الجلد"],
["كم عدد أسنان الإنسان البالغ؟","٣٢"],["كم عدد حجرات القلب؟","أربع"],
["ما أطول عظمة في الجسم؟","عظمة الفخذ"],["ما العضو الذي يفرز الإنسولين؟","البنكرياس"],
["ما أصغر عظمة في جسم الإنسان؟","الرِّكاب"],["ما العضو المسؤول عن حفظ التوازن؟","الأذن الداخلية"],
["كم لتراً من الدم في جسم البالغ تقريباً؟","خمسة"],["ما العضو الذي ينقّي الدم من السموم؟","الكبد"]]],

["فضاء وفلك",[
["ما أقرب كوكب إلى الشمس؟","عطارد"],["أي كوكب يُعرف بالكوكب الأحمر؟","المريخ"],
["ما أكبر كواكب المجموعة الشمسية؟","المشتري"],["أي كوكب يشتهر بحلقاته؟","زحل"],
["ما اسم مجرّتنا؟","درب التبانة"],["كم قمراً طبيعياً للأرض؟","واحد"],
["ما اسم أول قمر صناعي أُطلق للفضاء؟","سبوتنك"],["من أول إنسان صعد إلى الفضاء؟","يوري غاغارين"],
["كم دقيقة يستغرق ضوء الشمس ليصل الأرض؟","ثمان"],["ما اسم أقرب نجم إلى الأرض؟","الشمس"]]],

["طعام ومطبخ",[
["من أي نبات يُستخرج السكر غالباً؟","قصب السكر"],["ما أغلى بهار في العالم؟","الزعفران"],
["من أي دولة أصل البيتزا؟","إيطاليا"],["من أي حبوب يُصنع الخبز عادةً؟","القمح"],
["ما اسم الطبق الياباني بالأرز والسمك النيء؟","سوشي"],["من أي ثمرة تُصنع الشوكولاتة؟","الكاكاو"],
["ما الفاكهة المعروفة برائحتها النفاذة في آسيا؟","الدوريان"],["من أي دولة أصل الكبسة؟","السعودية"],
["ما المكوّن الأساسي في الجواكامولي؟","الأفوكادو"],["ما اسم المشروب المستخرج من حبوب محمّصة داكنة؟","القهوة"]]],

["تقنية",[
["من شارك في تأسيس مايكروسوفت؟","بيل غيتس"],["أي شركة تقف خلف نظام أندرويد؟","جوجل"],
["كم بت في البايت الواحد؟","ثمانية"],["من مؤسس فيسبوك؟","مارك زوكربيرغ"],
["ما لغة البرمجة المسمّاة على اسم ثعبان؟","بايثون"],["ما الجزء الذي يُعد عقل الحاسوب؟","المعالج"],
["ما اسم متصفح جوجل؟","كروم"],["من الرئيس التنفيذي لتسلا؟","إيلون ماسك"],
["ما اسم أشهر منصة لاستضافة الشفرات البرمجية؟","جيت هَب"],["ما اسم أشهر موسوعة حرة على الإنترنت؟","ويكيبيديا"]]],

["سينما وكرتون",[
["ما لون شخصية شريك؟","أخضر"],["في أي دولة تقع صناعة بوليوود؟","الهند"],
["ما اسم أشهر جائزة سينمائية أمريكية؟","الأوسكار"],["ما اسم الأسد الصغير في «الأسد الملك»؟","سيمبا"],
["ما الخضار الذي يأكله باباي ليقوى؟","السبانخ"],["ما مهنة سبونج بوب؟","طبّاخ"],
["في أي مدينة خيالية يعيش باتمان؟","جوثام"],["في أي دولة يقام مهرجان كان السينمائي؟","فرنسا"],
["ما اسم فأر ديزني الشهير؟","ميكي ماوس"],["ما اسم الروبوت الصغير في فيلم بيكسار الصامت؟","وول-إي"]]],

["اختراعات",[
["من طوّر المصباح الكهربائي؟","توماس إديسون"],["من ينسب إليه اختراع الهاتف؟","غراهام بيل"],
["من اخترع آلة الطباعة بالحروف المتحركة؟","غوتنبرغ"],["من صنع أول طائرة ناجحة؟","الأخوان رايت"],
["من اكتشف البنسلين؟","ألكسندر فليمنغ"],["من اخترع الديناميت؟","ألفريد نوبل"],
["من طوّر أول لقاح ضد الجدري؟","إدوارد جينر"],["من يُعد مؤسس علم الجبر؟","الخوارزمي"],
["من صاحب أول دراسة علمية للبصريات والكاميرا المظلمة؟","ابن الهيثم"],
["من طوّر المحرك البخاري؟","جيمس واط"]]],

["الجزيرة العربية",[
["كم دولة عضو في مجلس التعاون الخليجي؟","ست"],["ما عاصمة سلطنة عُمان؟","مسقط"],
["من مؤسس المملكة العربية السعودية؟","الملك عبدالعزيز"],["ما عملة الكويت؟","الدينار"],
["في أي مدينة يقع برج خليفة؟","دبي"],["ما أكبر صحراء رملية متصلة في العالم؟","الربع الخالي"],
["ما عاصمة قطر؟","الدوحة"],["في أي مدينة يقع المسجد النبوي؟","المدينة المنورة"],
["ما البحر الواقع غرب السعودية؟","البحر الأحمر"],["ما عاصمة البحرين؟","المنامة"]]],

["طبيعة وبيئة",[
["كم لوناً في قوس قزح؟","سبعة"],["ما أطول نهر في أفريقيا؟","النيل"],
["ما الذي يسبب ظاهرة المد والجزر؟","جاذبية القمر"],["ما أكبر غابة مطيرة في العالم؟","الأمازون"],
["ما الغاز الأكثر وجوداً في الغلاف الجوي؟","النيتروجين"],
["ما اسم الطبقة التي تحمي الأرض من الأشعة فوق البنفسجية؟","الأوزون"],
["ما أعمق نقطة في المحيطات؟","خندق ماريانا"],["ما أطول شجرة في العالم؟","السيكويا"],
["كم نسبة الماء من سطح الأرض تقريباً؟","٧١٪"],["ما اسم الرياح الموسمية في جنوب آسيا؟","المونسون"]]],

["مواصلات وطيران",[
["ما اسم الصندوق الذي يسجّل بيانات الطائرة؟","الصندوق الأسود"],
["ما اسم القناة التي تربط البحر الأحمر بالبحر المتوسط؟","قناة السويس"],
["من يقود السفينة؟","القبطان"],
["ما اسم الطريق المخصص لهبوط الطائرات؟","المدرج"],
["ما الوثيقة التي تحتاجها لدخول دولة أجنبية؟","التأشيرة"],
["ما اسم القطار الياباني فائق السرعة؟","شينكانسن"],
["كم إطاراً للسيارة عادةً؟","أربعة"],
["أي شركة سيارات أول من استخدم خط التجميع المتحرك؟","فورد"],
["ما اسم المكان الذي تتوقف فيه القطارات؟","المحطة"],
["ما اسم الجزء الذي يرفع الطائرة في الهواء؟","الجناح"]]],

["نبات وزراعة",[
["ما الجزء الذي يمتص الماء في النبات؟","الجذور"],
["ما الشجرة التي ترمز للسلام؟","الزيتون"],
["ما الصبغة التي تعطي النبات لونه الأخضر؟","الكلوروفيل"],
["ما أسرع نبات نمواً في العالم؟","الخيزران"],
["من أي فاكهة يُصنع الزبيب؟","العنب"],
["ما الخضار الذي يُدمع عين من يقطعه؟","البصل"],
["ما النبات الصحراوي الذي يخزّن الماء في سُوقه؟","الصبار"],
["في أي فصل تتساقط أوراق الأشجار؟","الخريف"],
["ما الشجرة التي تُعطي التمر؟","النخلة"],
["ما اسم أكبر زهرة في العالم؟","الرافليسيا"]]],

["أرقام وقياسات",[
["كم دقيقة في الساعة؟","٦٠"],
["كم يوماً في السنة الميلادية العادية؟","٣٦٥"],
["كم صفراً في المليون؟","ستة"],
["ما مجموع زوايا المثلث بالدرجات؟","١٨٠"],
["كم سنتيمتراً في المتر؟","١٠٠"],
["كم عدد أضلاع المسدس؟","ستة"],
["كم جراماً في الكيلوجرام؟","١٠٠٠"],
["كم مربعاً في رقعة الشطرنج؟","٦٤"],
["كم شهراً في السنة الهجرية؟","١٢"],
["ما العدد الذي لا تجوز القسمة عليه؟","صفر"]]],

["مهن وأدوات",[
["من يدافع عنك في المحكمة؟","المحامي"],
["ما الأداة التي يدق بها النجار المسمار؟","المطرقة"],
["من يطفئ الحرائق؟","رجل الإطفاء"],
["ما الجهاز الذي يقيس درجة الحرارة؟","الترمومتر"],
["ما الأداة التي يضع بها الرسّام اللون؟","الفرشاة"],
["من يبني الجدران بالطوب؟","البنّاء"],
["ما الأداة التي تُخاط بها الملابس يدوياً؟","الإبرة"],
["ما الآلة التي ترفع الأثقال في ورش البناء؟","الرافعة"],
["من يصمم المباني قبل تنفيذها؟","المهندس المعماري"],
["من يقص الشعر؟","الحلّاق"]]],

["عمارة ومعالم",[
["في أي دولة يقع تاج محل؟","الهند"],
["في أي مدينة يقع الكولوسيوم؟","روما"],
["ما اسم البرج المائل الشهير في إيطاليا؟","برج بيزا"],
["ما اسم المسجد ذو القبة الذهبية في القدس؟","قبة الصخرة"],
["في أي مدينة يقع تمثال الحرية؟","نيويورك"],
["ما اسم مدينة الأنباط المنحوتة في الصخر بالأردن؟","البتراء"],
["في أي دولة تقع مدينة العلا الأثرية؟","السعودية"],
["ما اسم دار الأوبرا الشهيرة بشكل الأصداف؟","دار أوبرا سيدني"],
["ما اسم البرج الحديدي الشهير في باريس؟","برج إيفل"],
["في أي دولة يقع معبد أنغكور وات؟","كمبوديا"]]],

["ألعاب وتسالي",[
["كم قطعة لكل لاعب في بداية الشطرنج؟","١٦"],
["ما اسم المكعب الملوّن الذي يُحل بالتدوير؟","مكعب روبيك"],
["كم قطعة في طقم الدومينو الكامل؟","٢٨"],
["ما اسم الحركة التي تنهي مباراة الشطرنج؟","كش ملك"],
["ما اسم لعبة البناء بالمكعبات البلاستيكية الملونة؟","ليغو"],
["ما اسم شخصية السبّاك في ألعاب نينتندو؟","ماريو"],
["كم ورقة في الشدة الكاملة بدون الجوكر؟","٥٢"],
["ما اسم لعبة العقارات التي تُلعب بنقود ورقية؟","مونوبولي"],
["في أي دولة انتشرت لعبة السودوكو الحديثة؟","اليابان"],
["كم لاعباً في الفريق الواحد بالبلوت؟","اثنان"]]],

["تراث وعادات",[
["ما اسم ما يُلبس فوق الغترة على الرأس؟","العقال"],
["ما اسم الخيمة التقليدية في الصحراء؟","بيت الشعر"],
["ما الطائر المستخدم في الصيد التقليدي بالخليج؟","الصقر"],
["ما اسم البخور الأشهر في الخليج؟","العود"],
["ما اسم المكان الذي يستقبل فيه أهل البيت ضيوفهم؟","المجلس"],
["ما اسم الحلوى الشعبية المحشوة بالتمر في نجد؟","الكليجا"],
["ما البهار الذي يُضاف للقهوة العربية عادةً؟","الهيل"],
["ما اسم الرقصة الشعبية السعودية بالسيوف والصفوف؟","العرضة"],
["ما العيد الذي يأتي بعد شهر رمضان؟","عيد الفطر"],
["ما الحيوان الذي تُقام له المزاينة والسباقات في السعودية؟","الإبل"]]],

["أرقام قياسية",[
["ما أكبر دولة في العالم مساحةً؟","روسيا"],
["ما أكبر بحيرة في العالم؟","بحر قزوين"],
["ما أعلى شلال في العالم؟","شلالات أنجل"],
["ما أبرد قارة في العالم؟","أنتاركتيكا"],
["ما أصغر طائر في العالم؟","الطنان"],
["ما أسرع طائر في العالم؟","الشاهين"],
["ما أكبر صحراء حارة في العالم؟","الصحراء الكبرى"],
["ما أكبر حيوان مفترس بري؟","الدب القطبي"],
["ما أقدم جامعة ما زالت تعمل في العالم؟","جامعة القرويين"],
["ما أثقل حيوان بري؟","الفيل"]]],

["ملابس وأزياء",[
["ما القماش الذي يُصنع منه الجينز؟","الدنيم"],
["ما اسم القطعة المعدنية التي تُغلق بها الجاكيت؟","السحّاب"],
["ما اسم الحيوان الذي يُجزّ صوفه للملابس؟","الخروف"],
["ما اسم الحشرة التي يُستخرج منها خيط الحرير؟","دودة القز"],
["ما اسم ما يُلبس في القدم قبل الحذاء؟","الجراب"],
["في أي مدينة تُقام أشهر أسابيع الأزياء العالمية؟","باريس"],
["ما اسم الغطاء الذي يُلبس على الرأس في الشتاء؟","الطاقية"],
["ما اسم الرباط الذي يُلبس مع القميص الرسمي؟","ربطة العنق"],
["ما اسم الملابس التي يلبسها اللاعب في الملعب؟","الزي الرياضي"],
["ما اسم الحذاء المخصص للسباحة والشاطئ؟","الشبشب"]]],

["مدن وعواصم",[
["ما عاصمة اليابان؟","طوكيو"],
["ما عاصمة إسبانيا؟","مدريد"],
["ما عاصمة البرازيل؟","برازيليا"],
["ما عاصمة مصر؟","القاهرة"],
["ما عاصمة الأردن؟","عمّان"],
["ما عاصمة إندونيسيا؟","جاكرتا"],
["ما عاصمة السنغال؟","داكار"],
["ما عاصمة النمسا؟","فيينا"],
["ما عاصمة ماليزيا؟","كوالالمبور"],
["ما عاصمة البرتغال؟","لشبونة"]]]
];
// ══════════════════════ موّه — الغرفة ══════════════════════
const MAWWIH_TEAMS = ['الذهبي', 'الأزرق', 'الأخضر', 'البنفسجي'];

// ألقاب النهاية — لقب واحد لكل لاعب بالأولوية، بصيغة تناسب ولد/بنت
const MAWWIH_TITLES = [
  { m: 'أبو الحيَل', f: 'أم الحيَل',
    dm: 'خدع كل اللاعبين بإجابة مزيّفة في جولة وحدة.', df: 'خدعت كل اللاعبين بإجابة مزيّفة في جولة وحدة.',
    pick: (p, st) => p.sweeps > 0 },
  { m: 'الثعلب', f: 'الثعلبة',
    dm: 'أكثر واحد صدّقوا إجاباته المزيّفة.', df: 'أكثر وحدة صدّقوا إجاباتها المزيّفة.',
    pick: (p, st) => p.fool > 0 && p.fool === st.maxFool },
  { m: 'جوجل القبيلة', f: 'جوجل القبيلة',
    dm: 'أكثر واحد عرف الإجابة الصحيحة.', df: 'أكثر وحدة عرفت الإجابة الصحيحة.',
    pick: (p, st) => p.right > 0 && p.right === st.maxRight },
  { m: 'أسطورة الجولة', f: 'أسطورة الجولة',
    dm: 'طلع بثلاث نقاط أو أكثر في جولة وحدة.', df: 'طلعت بثلاث نقاط أو أكثر في جولة وحدة.',
    pick: (p, st) => p.best >= 3 },
  { m: 'ما يفوته شي', f: 'ما يفوتها شي',
    dm: 'أصاب الصح في كل جولة، بدون ما يفوته شي.', df: 'أصابت الصح في كل جولة، بدون ما يفوتها شي.',
    pick: (p, st) => st.played >= 3 && p.right === st.played },
  { m: 'الثابت', f: 'الثابتة',
    dm: 'ما مرّت عليه ولا جولة بصفر نقاط.', df: 'ما مرّت عليها ولا جولة بصفر نقاط.',
    pick: (p, st) => st.played >= 3 && p.zeros === 0 },
  { m: 'ذيبان ما يمشي عليه', f: 'أميرة ما ينساق عليها',
    dm: 'ما صدّق ولا إجابة مزيّفة طول اللعبة.', df: 'ما صدّقت ولا إجابة مزيّفة طول اللعبة.',
    pick: (p, st) => st.played >= 3 && p.fell === 0 },
  { m: 'الساذج', f: 'الساذجة',
    dm: 'أكثر واحد وقع في الإجابات المزيّفة.', df: 'أكثر وحدة وقعت في الإجابات المزيّفة.',
    pick: (p, st) => p.fell > 0 && p.fell === st.maxFell },
  { m: 'بريء بزيادة', f: 'بريئة بزيادة',
    dm: 'يعرف الصح، بس ما خدع ولا واحد.', df: 'تعرف الصح، بس ما خدعت ولا واحد.',
    pick: (p, st) => p.fool === 0 && p.right > 0 },
  { m: 'كتاب مفتوح', f: 'كتاب مفتوح',
    dm: 'ولا أحد صدّق إجاباته المزيّفة.', df: 'ولا أحد صدّق إجاباتها المزيّفة.',
    pick: (p, st) => p.fool === 0 },
];

export class MawwihRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map();
    this.state.blockConcurrencyWhile(async () => {
      this.room = (await this.state.storage.get('room')) || {
        code: null, hostId: null, phase: 'lobby',
        players: [], // {id,name,gender,connected,score,av}
        cats: null, rounds: 8, teams: 0,
        round: 0, chooserId: null, used: [],
        q: null, subs: {}, options: null, votes: {},
      };
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/ws')) return this.handleWebSocket(request);
    if (url.pathname.endsWith('/create')) return this.handleCreate(request);
    return new Response('غير موجود', { status: 404 });
  }

  async handleCreate(request) {
    let body;
    try { body = await request.json(); } catch { return new Response('bad-json', { status: 400 }); }
    const { name, gender, roomCode } = body || {};
    if (this.room.code && this.room.players.length && this.room.phase !== 'over') {
      return new Response('room-exists', { status: 409 });
    }
    this.room.code = roomCode;
    const hostId = crypto.randomUUID();
    const hostToken = newSeatToken();
    this.room.hostId = hostId;
    this.room.players = [{ id: hostId, name: cleanName(name), gender: gender || 'm', connected: false, score: 0, av: null, team: null, seatToken: hostToken }];
    await this.persist();
    // كان التوكن يُولَّد ولا يُرسل — فالمضيف ما كان يقدر يستعيد مقعده
    return Response.json({ roomCode: this.room.code, playerId: hostId, seatToken: hostToken });
  }

  async handleWebSocket(request) {
    const url = new URL(request.url);
    const playerId = url.searchParams.get('playerId');
    const name = url.searchParams.get('name');
    const gender = url.searchParams.get('gender') || 'm';
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('يتطلب WebSocket', { status: 426 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const token = url.searchParams.get('token');

    // ── التوكن أولاً، والمعرّف لا يمنح دخولاً أبدًا ──
    // كان البحث بـ playerId يسبق فحص التوكن، فالمعرّف المُذاع في اللوبي
    // كان يكفي لدخول مقعد أي لاعب.
    let player = this.seatByToken(token);
    if (player) {
      const seat = player;
      {
        const oldId = seat.id;
        const newId = (validPlayerId(playerId) && !this.room.players.some(p => p.id === playerId)) ? playerId : oldId;
        seat.id = newId;
        // ننقل كل ما هو مرتبط بالمعرّف القديم
        if (this.room.subs && oldId in this.room.subs) { this.room.subs[newId] = this.room.subs[oldId]; delete this.room.subs[oldId]; }
        if (this.room.votes && oldId in this.room.votes) { this.room.votes[newId] = this.room.votes[oldId]; delete this.room.votes[oldId]; }
        if (this.room.options) this.room.options.forEach(o => { o.by = o.by.map(b => b === oldId ? newId : b); });
        if (this.room.hostId === oldId) this.room.hostId = newId;
        const stale = this.sockets.get(oldId);
        if (stale && stale !== server) { try { stale.close(); } catch {} }
        this.sockets.delete(oldId);
        player = seat;
      }
    }

    // ع-١ · رمز لم تُنشأ له غرفة: لا نُنشئها من اتصال WebSocket.
    // بدون هذا يتجاوز المهاجم حدّ allowCreate بالكامل ويفرّخ غرفًا بلا سقف.
    if (!player && !this.room.code) {
      server.send(JSON.stringify({ type: 'error', message: 'ما فيه غرفة بهذا الرمز' }));
      server.close();
      return new Response(null, { status: 101, webSocket: client });
    }

    if (!player) {
      if (this.room.phase !== 'lobby') {
        server.send(JSON.stringify({ type: 'error', message: 'اللعبة بدأت — ما تقدر تنضم الحين' }));
        server.close();
        return new Response(null, { status: 101, webSocket: client });
      }
      if (this.room.players.length >= MAX_PLAYERS) {
        server.send(JSON.stringify({ type: 'error', message: 'الغرفة ممتلئة' }));
        server.close();
        return new Response(null, { status: 101, webSocket: client });
      }
      player = { id: crypto.randomUUID(), name: cleanName(name), gender, connected: true, score: 0, av: null, team: null, seatToken: newSeatToken() };
      this.room.players.push(player);
    } else {
      player.connected = true;
    }

    this.sockets.set(player.id, server);
    server.addEventListener('message', evt => this.onMessage(player.id, evt));
    server.addEventListener('close', () => this.onClose(player.id));

    await this.persist();
    this.broadcastLobby();
    if (!player.seatToken) player.seatToken = newSeatToken();
    this.sendPrivate(player.id, { type: 'welcome', playerId: player.id, roomCode: this.room.code, seatToken: player.seatToken });
    if (this.room.phase !== 'lobby') this.sendRoundStateTo(player.id);

    return new Response(null, { status: 101, webSocket: client });
  }

  async onMessage(playerId, evt) {
    if (!this.allowMsg(playerId)) return;
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'setAvatar') { const p = this.findPlayer(playerId); if (p) { p.av = cleanText(msg.av, 24); await this.persist(); this.broadcastLobby(); } }

    if (msg.type === 'updateProfile' && this.room.phase === 'lobby') {
      const p = this.findPlayer(playerId);
      if (p) {
        if (typeof msg.name === 'string' && msg.name.trim()) p.name = cleanName(msg.name);
        if (typeof msg.av === 'string' && msg.av) p.av = cleanText(msg.av, 24);
        if (msg.gender === 'm' || msg.gender === 'f') p.gender = msg.gender;
        await this.persist();
        this.broadcastLobby();
      }
    }
    if (msg.type === 'updateSettings' && playerId === this.room.hostId) {
      // حدود صريحة — كانت أي مصفوفة/رقم يُقبل ويُخزَّن للأبد
      if (Array.isArray(msg.cats)) {
        // أرقام فئات فقط، داخل مدى البنك — قبل كذا كانت تُخزَّن نصوصاً بدون تحقق فتوقف الغرفة
        const picked = msg.cats.map(c => parseInt(c, 10))
          .filter(c => Number.isInteger(c) && c >= 0 && c < BANK.length);
        this.room.cats = [...new Set(picked)].slice(0, BANK.length);
        if (!this.room.cats.length) this.room.cats = BANK.map((_, i) => i);
      }
      if (Number.isInteger(msg.rounds)) this.room.rounds = Math.min(Math.max(msg.rounds, 1), 20);
      if ([0, 2, 3, 4].includes(msg.teams)) {
        this.room.teams = msg.teams;
        // أي فريق صار خارج النطاق يُلغى ليعاد اختياره
        this.room.players.forEach(p => { if (p.team === null || p.team >= this.room.teams) p.team = null; });
      }
      await this.persist(); this.broadcastLobby();
    }
    if (msg.type === 'setTeam' && this.room.phase === 'lobby') {
      const p = this.findPlayer(playerId);
      if (p && this.room.teams > 0 && Number.isInteger(msg.team) && msg.team >= 0 && msg.team < this.room.teams) {
        p.team = msg.team;
        await this.persist(); this.broadcastLobby();
      }
    }
    if (msg.type === 'kickPlayer' && playerId === this.room.hostId && this.room.phase === 'lobby') await this.kickPlayer(msg.targetId);
    if (msg.type === 'startGame' && playerId === this.room.hostId) await this.startGame();
    if (msg.type === 'pickCategory' && this.room.phase === 'picking' && playerId === this.chooser().id) await this.pickCategory(msg.catIndex);
    if (msg.type === 'submitAnswer' && this.room.phase === 'writing') await this.submitAnswer(playerId, msg.text);
    if (msg.type === 'submitVote' && this.room.phase === 'voting') await this.submitVote(playerId, msg.key);
    if (msg.type === 'nextRound' && playerId === this.room.hostId && this.room.phase === 'reveal') await this.nextRound();
    if (msg.type === 'hostForceAdvance' && playerId === this.room.hostId) await this.forceAdvance();
  }

  async onClose(playerId) {
    const p = this.findPlayer(playerId);
    if (p) p.connected = false;
    this.sockets.delete(playerId);
    this.migrateHostIfNeeded();
    await this.persist();
    this.broadcastLobby();
    await this.maybeAdvanceOnDisconnect();
  }

  // نقل المضيف تلقائيًا لو انقطع — بدونها تتجمّد الغرفة نهائيًا
  migrateHostIfNeeded() {
    const host = this.room.players.find(p => p.id === this.room.hostId);
    if (host && host.connected) return false;
    const next = this.room.players.find(p => p.connected && p.id !== this.room.hostId);
    if (!next) return false;
    this.room.hostId = next.id;
    this.broadcastPublic({ type: 'hostChanged', hostId: next.id, hostName: next.name });
    return true;
  }

  async kickPlayer(targetId) {
    if (targetId === this.room.hostId) return;
    const target = this.findPlayer(targetId);
    if (!target) return;
    this.sendPrivate(targetId, { type: 'kicked' });
    const ws = this.sockets.get(targetId);
    if (ws) { try { ws.close(); } catch {} this.sockets.delete(targetId); }
    this.room.players = this.room.players.filter(p => p.id !== targetId);
    await this.persist();
    this.broadcastLobby();
  }

  findPlayer(id) { return this.room.players.find(p => p.id === id); }
  // المنقطع ما يوقف الجولة — بدون هذا تعلّق اللعبة على أول انقطاع
  activePlayers() { return this.room.players.filter(p => p.connected); }
  expected() { return this.activePlayers().length; }
  async maybeAdvanceOnDisconnect() {
    const exp = this.expected();
    if (exp <= 0) return;
    if (this.room.phase === 'writing' && Object.keys(this.room.subs).length >= exp) await this.startVoting();
    else if (this.room.phase === 'voting' && Object.keys(this.room.votes).length >= exp) await this.reveal();
  }
  chooser() {
    // الدور مربوط بهوية اللاعب لا بموضعه — خروج أي لاعب كان يزحزح الدور عشوائيًا
    const byId = this.room.players.find(p => p.id === this.room.chooserId);
    if (byId) return byId;
    return this.activePlayers()[0] || this.room.players[0];
  }
  advanceChooser() {
    const list = this.room.players;
    if (!list.length) return;
    const start = Math.max(0, list.findIndex(p => p.id === this.room.chooserId));
    for (let i = 1; i <= list.length; i++) {
      const cand = list[(start + i) % list.length];
      if (cand.connected) { this.room.chooserId = cand.id; return; }
    }
    this.room.chooserId = list[(start + 1) % list.length].id;
  }
  teamsOn() { return this.room.teams > 0; }
  teamList() { return Array.from({ length: this.room.teams }, (_, i) => i); }
  membersOf(t) { return this.room.players.filter(p => p.team === t); }
  sameTeam(a, b) { return this.teamsOn() && a && b && a.team !== null && a.team === b.team; }
  /** خيارات الفريق المحجوبة عن لاعب: إجابته وإجابات زملائه */
  blockedFor(playerId, opt) {
    const me = this.findPlayer(playerId);
    return opt.by.some(b => b === playerId || this.sameTeam(this.findPlayer(b), me));
  }
  titlesFor() {
    const mx = k => this.room.players.reduce((a, p) => Math.max(a, p[k] || 0), 0);
    const st = { played: this.room.round, maxFool: mx('fool'), maxRight: mx('right'), maxFell: mx('fell') };
    const out = {};
    for (const p of this.room.players) {
      const t = MAWWIH_TITLES.find(x => x.pick({ fool: p.fool || 0, fell: p.fell || 0, right: p.right || 0, best: p.best || 0, zeros: p.zeros || 0, sweeps: p.sweeps || 0 }, st));
      if (t) out[p.id] = { label: p.gender === 'f' ? t.f : t.m, desc: p.gender === 'f' ? t.df : t.dm };
    }
    return out;
  }
  teamTotals() {
    return this.teamList().map(t => ({
      team: t, name: MAWWIH_TEAMS[t],
      score: this.membersOf(t).reduce((a, p) => a + p.score, 0),
      gain: this.membersOf(t).reduce((a, p) => a + (p.gain || 0), 0),
      members: this.membersOf(t).map(p => ({ id: p.id, name: p.name, av: p.av, score: p.score })),
    })).sort((a, b) => b.score - a.score);
  }
  catOptions() {
    return (this.room.choices || []).map(ci => ({
      index: ci, name: BANK[ci][0],
      left: BANK[ci][1].filter((_, qi) => !this.room.used.includes(ci + ':' + qi)).length,
    }));
  }

  async startGame() {
    // بدونها يقدر المضيف يعيد اللعبة من الصفر في نص جولة جارية
    if (this.room.phase !== 'lobby' && this.room.phase !== 'over') return;
    if (this.room.players.length < 3) { this.sendPrivate(this.room.hostId, { type: 'error', message: 'تحتاجون ٣ لاعبين على الأقل' }); return; }
    if (this.room.teams > 0) {
      if (this.room.players.length < this.room.teams) { this.sendPrivate(this.room.hostId, { type: 'error', message: 'اللاعبون أقل من عدد الفرق' }); return; }
      const missing = this.room.players.filter(p => p.team === null || p.team >= this.room.teams);
      if (missing.length) { this.broadcastPublic({ type: 'error', message: 'باقي يختار فريقه: ' + missing.map(p => p.name).join('، ') }); return; }
      const empty = this.teamList().find(t => this.membersOf(t).length === 0);
      if (empty !== undefined) { this.broadcastPublic({ type: 'error', message: 'فريق ' + MAWWIH_TEAMS[empty] + ' فاضي — وزّعوا اللاعبين' }); return; }
    }
    this.room.round = 0; this.room.used = [];
    this.room.players.forEach(p => {
      p.score = 0; p.gain = 0; p.fool = 0; p.fell = 0; p.right = 0; p.best = 0; p.zeros = 0; p.sweeps = 0;
    });
    if (!this.room.cats || !this.room.cats.length) this.room.cats = BANK.map((_, i) => i);
    await this.nextRound();
  }

  async nextRound() {
    this.room.round++;
    this.room.subs = {}; this.room.votes = {}; this.room.options = null; this.room.q = null;
    if (this.room.round <= 1 || !this.room.chooserId) {
      this.room.chooserId = (this.activePlayers()[0] || this.room.players[0]).id;
    } else {
      this.advanceChooser();
    }
    const avail = this.room.cats.filter(ci => BANK[ci][1].some((_, qi) => !this.room.used.includes(ci + ':' + qi)));
    const pool = avail.length >= 5 ? avail : (this.room.used = [], this.room.cats.slice());
    const choices = shuffleArr(pool.slice()).slice(0, Math.min(5, pool.length));
    this.room.choices = choices;
    this.room.phase = 'picking';
    await this.persist();
    const catOptions = this.catOptions();
    // الفئات تُبث للكل (مثل الأصل) — اللاعبون يشوفون الخيارات وينتظرون اختيار من عليه الدور
    this.broadcastPublic({ type: 'phaseChanged', phase: 'picking', round: this.room.round, rounds: this.room.rounds, chooserId: this.chooser().id, chooserName: this.chooser().name, choices: catOptions });
    this.sendPrivate(this.chooser().id, { type: 'catChoices', options: catOptions });
  }

  async pickCategory(catIndex) {
    // حارس الحسم المزدوج — نفس نمط بقية دوال الانتقال
    if (this.room.phase !== 'picking') return;
    this.room.phase = 'writing';
    // الكل يشوف الفئة المختارة قبل الانتقال للكتابة
    this.broadcastPublic({ type: 'catPicked', index: catIndex, name: BANK[catIndex][0], chooserName: this.chooser().name });
    const pool = [];
    BANK[catIndex][1].forEach((q, qi) => { const key = catIndex + ':' + qi; if (!this.room.used.includes(key)) pool.push({ key, cat: BANK[catIndex][0], text: q[0], ans: q[1] }); });
    const q = pool[Math.floor(Math.random() * pool.length)];
    this.room.used.push(q.key);
    this.room.q = q;
    await this.persist();
    this.broadcastPublic({ type: 'phaseChanged', phase: 'writing', cat: q.cat, text: q.text, chooserName: this.chooser().name });
  }

  async submitAnswer(playerId, text) {
    // كان بلا أي حدّ: نص ضخم يُخزَّن ويُبَث للغرفة، وقد يتجاوز سقف التخزين
    const t = cleanText(text, 60);
    if (!t) { this.sendPrivate(playerId, { type: 'answerRejected', message: 'اكتب إجابة أولًا' }); return; }
    if (norm(t) === norm(this.room.q.ans)) {
      this.sendPrivate(playerId, { type: 'answerRejected', message: 'هذي هي الإجابة الصحيحة — موّه بغيرها 😉' });
      return;
    }
    // منع تكرار نفس إجابة لاعب آخر حرفيًا (تلخبط الكشف)
    for (const [otherId, otherText] of Object.entries(this.room.subs)) {
      if (otherId !== playerId && norm(otherText) === norm(t)) {
        this.sendPrivate(playerId, { type: 'answerRejected', message: 'لاعب ثاني كتب نفس الإجابة — غيّرها' });
        return;
      }
    }
    this.room.subs[playerId] = t;
    this.sendPrivate(playerId, { type: 'answerAccepted' });
    await this.persist();
    const expW = this.expected();
    this.broadcastPublic({ type: 'writeProgress', submitted: Object.keys(this.room.subs).length, total: expW });
    if (expW > 0 && Object.keys(this.room.subs).length >= expW) await this.startVoting();
  }

  async startVoting() {
    if (this.room.phase !== 'writing') return;
    const nT = norm(this.room.q.ans);
    const opts = [{ k: 'T', text: this.room.q.ans, by: [] }];
    const seen = { [nT]: 'T' };
    for (const p of this.room.players) {
      const t = this.room.subs[p.id]; const n = norm(t);
      if (!n || n === nT) continue;
      if (seen[n]) { const o = opts.find(x => x.k === seen[n]); if (o) o.by.push(p.id); continue; }
      const k = 'F' + p.id; seen[n] = k;
      opts.push({ k, text: t, by: [p.id] });
    }
    this.room.options = shuffleArr(opts);
    /* المفتاح الحقيقي كان يفضح كل شيء: 'T' = الإجابة الصحيحة (يصوّت لها ويكسب دائمًا)،
       و'F'+معرّف = صاحب الكذبة. الاثنان يوصلان العميل. نرسل بدلاً منهما اسمًا
       مستعارًا عشوائيًا يُولَّد كل جولة، ونترجمه عند استلام الصوت. */
    this.room.alias = {};
    for (const o of this.room.options) this.room.alias[crypto.randomUUID().slice(0, 8)] = o.k;
    this.room.phase = 'voting';
    await this.persist();
    // كل لاعب يستلم قائمة خاصة فيه، بدون إجابته هو — يمنع تصويت غلط لا يُحتسب بصمت
    for (const p of this.room.players) {
      const myOptions = this.optionsFor(p.id);
      this.sendPrivate(p.id, { type: 'phaseChanged', phase: 'voting', cat: this.room.q.cat, text: this.room.q.text, options: myOptions, teams: this.room.teams });
    }
  }

  /* قائمة الخيارات كما يراها لاعب واحد: بلا إجابته وإجابات فريقه، وبأسماء مستعارة */
  optionsFor(playerId) {
    const rev = {};
    for (const [a, k] of Object.entries(this.room.alias || {})) rev[k] = a;
    return this.room.options
      .filter(o => !this.blockedFor(playerId, o))
      .map(o => ({ key: rev[o.k] || o.k, text: o.text }));
  }

  async submitVote(playerId, aliasKey) {
    const key = (this.room.alias && this.room.alias[aliasKey]) || null;
    const opt = key ? this.room.options.find(o => o.k === key) : null;
    if (!opt || this.blockedFor(playerId, opt)) {
      this.sendPrivate(playerId, {
        type: 'error',
        message: opt && !opt.by.includes(playerId) ? 'هذي إجابة زميلك في الفريق — اختر غيرها' : 'ما تقدر تصوّت لإجابتك — اختر غيرها',
      });
      return;
    }
    this.room.votes[playerId] = key;
    await this.persist();
    const expV = this.expected();
    this.broadcastPublic({ type: 'voteProgress', submitted: Object.keys(this.room.votes).length, total: expV });
    if (expV > 0 && Object.keys(this.room.votes).length >= expV) await this.reveal();
  }

  async reveal() {
    if (this.room.phase !== 'voting') return;
    const gain = {};
    const add = (id, n) => { gain[id] = (gain[id] || 0) + n; };
    const voters = {}; this.room.options.forEach(o => { voters[o.k] = []; });
    for (const [pid, k] of Object.entries(this.room.votes)) {
      if (!voters[k]) continue;
      voters[k].push(pid);
      if (k === 'T') add(pid, 2);
      else { const o = this.room.options.find(x => x.k === k); if (o) o.by.forEach(b => add(b, 1)); }
    }
    // إحصاءات الألقاب: عرف الصح / خدع غيره / انخدع / أفضل جولة / جولات بلا نقاط / لبّس الجميع
    for (const [k, list] of Object.entries(voters)) {
      const opt = this.room.options.find(x => x.k === k);
      if (!opt) continue;
      if (k === 'T') { list.forEach(id => { const p = this.findPlayer(id); if (p) p.right = (p.right || 0) + 1; }); continue; }
      opt.by.forEach(b => { const p = this.findPlayer(b); if (p) p.fool = (p.fool || 0) + list.length; });
      list.forEach(id => { const p = this.findPlayer(id); if (p) p.fell = (p.fell || 0) + 1; });
      const me = opt.by.map(b => this.findPlayer(b));
      const eligible = this.room.players.filter(x => !opt.by.includes(x.id) && !me.some(a => this.sameTeam(a, x))).length;
      if (eligible > 1 && list.length === eligible) opt.by.forEach(b => { const p = this.findPlayer(b); if (p) p.sweeps = (p.sweeps || 0) + 1; });
    }
    this.room.players.forEach(p => {
      p.gain = gain[p.id] || 0; p.score += p.gain;
      if (p.gain > (p.best || 0)) p.best = p.gain;
      if (p.gain === 0) p.zeros = (p.zeros || 0) + 1;
    });
    this.room.phase = 'reveal';
    await this.persist();

    const cards = this.room.options.map(o => ({
      key: o.k, text: o.text, isTruth: o.k === 'T',
      byNames: o.by.map(id => this.findPlayer(id)?.name).filter(Boolean),
      voterNames: (voters[o.k] || []).map(id => this.findPlayer(id)?.name).filter(Boolean),
    }));
    const isLast = this.room.round >= this.room.rounds;
    this.broadcastPublic({
      type: 'revealResult', cat: this.room.q.cat, text: this.room.q.text, cards,
      gains: this.room.players.map(p => ({ id: p.id, name: p.name, gain: p.gain, score: p.score })),
      teams: this.teamsOn() ? this.teamTotals() : null,
      isLast,
    });
    if (isLast) await this.endGame();
  }

  async endGame() {
    this.room.phase = 'over';
    await this.persist();
    const titles = this.titlesFor();
    const teams = this.teamsOn() ? this.teamTotals() : null;
    if (teams) teams.forEach(t => { t.members.forEach(m => { const ti = titles[m.id]; m.title = ti ? ti.label : null; m.titleDesc = ti ? ti.desc : null; }); });
    this.broadcastPublic({
      type: 'gameOver',
      players: [...this.room.players].sort((a, b) => b.score - a.score)
        .map(p => { const ti = titles[p.id]; return { id: p.id, name: p.name, score: p.score, title: ti ? ti.label : null, titleDesc: ti ? ti.desc : null }; }),
      teams,
    });
  }

  sendRoundStateTo(playerId) {
    // إعادة اتصال أثناء اللعب — نرسل الحالة العامة الحالية بدل ما يعلق باللوبي
    if (this.room.phase === 'picking') this.sendPrivate(playerId, { type: 'phaseChanged', phase: 'picking', round: this.room.round, rounds: this.room.rounds, chooserId: this.chooser().id, chooserName: this.chooser().name, choices: this.catOptions() });
    else if (this.room.phase === 'writing') this.sendPrivate(playerId, { type: 'phaseChanged', phase: 'writing', cat: this.room.q.cat, text: this.room.q.text, chooserName: this.chooser().name });
    else if (this.room.phase === 'voting') {
      const myOptions = this.optionsFor(playerId);
      this.sendPrivate(playerId, { type: 'phaseChanged', phase: 'voting', cat: this.room.q.cat, text: this.room.q.text, options: myOptions, teams: this.room.teams });
    }
  }

  // صمام أمان: المضيف يقدر يفرض حسم المرحلة لو علقت (مثلًا لاعب انقطع وما رجع)
  async forceAdvance() {
    if (this.room.phase === 'picking') {
      if (this.room.choices && this.room.choices.length) await this.pickCategory(this.room.choices[0]);
    } else if (this.room.phase === 'writing') {
      await this.startVoting();
    } else if (this.room.phase === 'voting') {
      await this.reveal();
    }
  }

  broadcastLobby() {
    const publicPlayers = this.room.players.map(p => ({ id: p.id, name: p.name, gender: p.gender, connected: p.connected, av: p.av, team: p.team }));
    this.broadcastPublic({ type: 'lobbyUpdate', players: publicPlayers, hostId: this.room.hostId, cats: this.room.cats, rounds: this.room.rounds, teams: this.room.teams });
  }
  broadcastPublic(payload) {
    const json = JSON.stringify(payload);
    for (const ws of this.sockets.values()) { try { ws.send(json); } catch {} }
  }
  sendPrivate(playerId, payload) {
    const ws = this.sockets.get(playerId);
    if (ws) { try { ws.send(JSON.stringify(payload)); } catch {} }
  }
  async persist() { await this.touchRoom(); await this.state.storage.put('room', this.room); }
}

function shuffleArr(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }
function norm(s) {
  return (s || '')
    .trim()
    .replace(/[\u064B-\u0652\u0640]/g, '')        // تشكيل وتطويل
    .replace(/[إأآٱا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ىی]/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/^(ال|أل)/, '')                       // أداة التعريف بالبداية
    .replace(/[^\p{L}\p{N}]+/gu, '')               // مسافات وترقيم ورموز
    .toLowerCase();
}


/* ===================== فَطِن ===================== */
const FATIN_BANK = {
 'تاريخ':[
  ['متى أُلغيت الخلافة العثمانية رسميًا؟','١٩٢٤م',['١٩١٨م','١٩٢٢م','١٩٣٠م']],
  ['من القائد المسلم الذي فتح الأندلس؟','طارق بن زياد',['موسى بن نصير','عقبة بن نافع','قتيبة بن مسلم']],
  ['في أي معركة أوقف المسلمون زحف المغول؟','عين جالوت',['حطين','اليرموك','الزلاقة']],
  ['كم سنة استمرت الحرب العالمية الأولى؟','أربع سنوات',['ست سنوات','سنتان','ثماني سنوات']],
  ['من أول خليفة في الدولة الأموية؟','معاوية بن أبي سفيان',['عبدالملك بن مروان','يزيد بن معاوية','مروان بن الحكم']],
  ['على يد من سقطت بغداد سنة ٦٥٦هـ؟','المغول',['الصليبيين','البيزنطيين','الفرس']],
  ['من قاد المسلمين في معركة حطين؟','صلاح الدين الأيوبي',['نور الدين زنكي','قطز','بيبرس']],
  ['أي حضارة نحتت مدينة البتراء؟','الأنباط',['الفراعنة','الآشوريون','الفينيقيون']],
  ['في أي عام بدأت الحرب العالمية الثانية؟','١٩٣٩م',['١٩٤١م','١٩٣٦م','١٩٤٥م']],
  ['من وضع التقويم الهجري؟','عمر بن الخطاب',['أبو بكر الصديق','عثمان بن عفان','علي بن أبي طالب']],
  ['في أي عام هبط الإنسان على القمر أول مرة؟','١٩٦٩م',['١٩٦١م','١٩٧٢م','١٩٥٧م']],
  ['ما عاصمة الدولة العباسية في عصرها الذهبي؟','بغداد',['دمشق','القاهرة','قرطبة']]
 ],
 'جغرافيا':[
  ['ما أكبر محيطات العالم؟','المحيط الهادئ',['الأطلسي','الهندي','المتجمد الشمالي']],
  ['ما أكبر قارة من حيث المساحة؟','آسيا',['أفريقيا','أمريكا الشمالية','أوروبا']],
  ['ما أعلى قمة جبلية في العالم؟','إيفرست',['كِلمنجارو','مونت بلانك','K2']],
  ['ما أكبر صحراء رملية متصلة في العالم؟','الربع الخالي',['النفود','الصحراء الكبرى','كالاهاري']],
  ['في أي قارة تقع الأرجنتين؟','أمريكا الجنوبية',['أمريكا الشمالية','أفريقيا','أوروبا']],
  ['ما عاصمة النرويج؟','أوسلو',['ستوكهولم','كوبنهاغن','هلسنكي']],
  ['أي بحر يفصل بين السعودية ومصر؟','البحر الأحمر',['البحر المتوسط','بحر العرب','الخليج العربي']],
  ['ما أصغر دولة في العالم مساحةً؟','الفاتيكان',['موناكو','مالطا','سان مارينو']],
  ['كم عدد قارات العالم؟','سبع',['خمس','ست','ثمان']],
  ['ما البحيرة الشديدة الملوحة التي لا تعيش فيها الأسماك؟','البحر الميت',['بحر قزوين','بحيرة فكتوريا','البحيرة الحمراء']],
  ['ما أكبر جزيرة في العالم؟','جرينلاند',['مدغشقر','بورنيو','سومطرة']],
  ['ما أكبر دولة عربية مساحةً؟','الجزائر',['السعودية','السودان','ليبيا']]
 ],
 'علوم':[
  ['ما الغاز الذي تمتصه النباتات في البناء الضوئي؟','ثاني أكسيد الكربون',['الأكسجين','النيتروجين','الهيدروجين']],
  ['كم عدد عظام جسم الإنسان البالغ؟','٢٠٦',['١٨٠','٢٥٠','٣٠٦']],
  ['ما أقرب الكواكب إلى الشمس؟','عطارد',['الزهرة','الأرض','المريخ']],
  ['ما الرمز الكيميائي للذهب؟','Au',['Ag','Gd','Go']],
  ['ما العضو المسؤول عن ضخ الدم في الجسم؟','القلب',['الكبد','الرئة','الكلى']],
  ['ما أكبر كواكب المجموعة الشمسية؟','المشتري',['زحل','نبتون','أورانوس']],
  ['كم عدد الكروموسومات في خلية الإنسان الطبيعية؟','٤٦',['٢٣','٤٨','٤٤']],
  ['ما الوحدة التي تُقاس بها القوة؟','نيوتن',['جول','واط','باسكال']],
  ['ما المعدن السائل في درجة حرارة الغرفة؟','الزئبق',['الرصاص','الصوديوم','القصدير']],
  ['أي فيتامين تنتجه البشرة عند التعرض للشمس؟','فيتامين د',['فيتامين ج','فيتامين أ','فيتامين ب١٢']],
  ['كم تبلغ سرعة الضوء تقريبًا في الفراغ؟','٣٠٠ ألف كم/ث',['٣٠٠ كم/ث','٣ ملايين كم/ث','٣٠ ألف كم/ث']],
  ['ما أصلب مادة طبيعية معروفة؟','الألماس',['الكوارتز','الحديد','الجرافيت']]
 ],
 'الجزيرة العربية':[
  ['ما عاصمة المملكة العربية السعودية؟','الرياض',['جدة','الدمام','مكة المكرمة']],
  ['في أي عام توحّدت المملكة العربية السعودية بمسماها الحالي؟','١٩٣٢م',['١٩٢٦م','١٩٤٥م','١٩٥٣م']],
  ['ما أكبر واحة نخيل في العالم؟','الأحساء',['القطيف','بريدة','تبوك']],
  ['ما أعلى قمة في السعودية؟','جبل السودة',['جبل طويق','جبل أُحد','جبل شدا']],
  ['أي مدينة سعودية تُلقّب بعروس البحر الأحمر؟','جدة',['ينبع','جازان','ضباء']],
  ['ما اسم الرؤية التنموية السعودية؟','رؤية ٢٠٣٠',['رؤية ٢٠٢٠','خطة الغد','مشروع النهضة']],
  ['ما عاصمة سلطنة عُمان؟','مسقط',['صلالة','نزوى','صحار']],
  ['أي دولة خليجية عاصمتها المنامة؟','البحرين',['قطر','الكويت','الإمارات']],
  ['ما اسم الموقع الأثري النبطي في العُلا؟','الحِجر',['البتراء','قرية الفاو','دومة الجندل']],
  ['ما أكبر مدن السعودية سكانًا؟','الرياض',['جدة','مكة المكرمة','المدينة المنورة']],
  ['ما العملة الرسمية للكويت؟','الدينار',['الريال','الدرهم','الدينار البحريني']],
  ['في أي عام تدفّق النفط تجاريًا في السعودية؟','١٩٣٨م',['١٩٥١م','١٩٢٩م','١٩٤٦م']]
 ],
 'لغة وأدب':[
  ['كم عدد حروف اللغة العربية؟','٢٨',['٢٦','٢٩','٣٠']],
  ['من الشاعر الملقّب بأمير الشعراء؟','أحمد شوقي',['حافظ إبراهيم','المتنبي','البحتري']],
  ['من مؤلف كتاب "الأيام"؟','طه حسين',['العقاد','المنفلوطي','توفيق الحكيم']],
  ['من أول أديب عربي نال جائزة نوبل للآداب؟','نجيب محفوظ',['جبران خليل جبران','أدونيس','الطيب صالح']],
  ['من مؤلف معجم "لسان العرب"؟','ابن منظور',['الفيروزآبادي','الخليل بن أحمد','الجوهري']],
  ['ما نوع كلمة "كَتَبَ" من حيث الزمن؟','فعل ماضٍ',['فعل مضارع','فعل أمر','اسم']],
  ['من صاحب المعلقة التي تبدأ بـ"قِفا نبكِ"؟','امرؤ القيس',['عنترة','زهير بن أبي سلمى','طرفة بن العبد']],
  ['من يُنسب إليه وضع علم النحو؟','أبو الأسود الدؤلي',['سيبويه','الكسائي','ابن جني']],
  ['ما مرادف كلمة "الوَجَل"؟','الخوف',['الفرح','التعب','الشوق']],
  ['من نقل "كليلة ودمنة" إلى العربية؟','ابن المقفع',['الجاحظ','ابن خلدون','الأصمعي']],
  ['من واضع علم العَروض (بحور الشعر)؟','الخليل بن أحمد',['سيبويه','ابن جني','الفراهيدي الصغير']],
  ['ما جمع كلمة "قَلَم"؟','أقلام',['قلمون','قوالم','قلائم']]
 ],
 'رياضة':[
  ['كم عدد لاعبي فريق كرة القدم داخل الملعب؟','١١',['١٠','١٢','٩']],
  ['كل كم سنة تقام كأس العالم لكرة القدم؟','أربع سنوات',['سنتان','ثلاث سنوات','خمس سنوات']],
  ['ما أكثر منتخب تتويجًا بكأس العالم؟','البرازيل',['ألمانيا','إيطاليا','الأرجنتين']],
  ['في أي رياضة يُستخدم مصطلح "سلام دانك"؟','كرة السلة',['كرة اليد','الكرة الطائرة','التنس']],
  ['كم لاعبًا لفريق كرة السلة داخل الملعب؟','٥',['٦','٧','٤']],
  ['ما أبرز بطولة أندية في أوروبا؟','دوري أبطال أوروبا',['الدوري الأوروبي','كأس السوبر','دوري الأمم']],
  ['في أي مدينة أقيمت أولمبياد ٢٠٢٠؟','طوكيو',['باريس','ريو','لندن']],
  ['كم تبلغ مسافة سباق الماراثون تقريبًا؟','٤٢ كم',['٢١ كم','٥٠ كم','٣٠ كم']],
  ['أي نادٍ سعودي يُلقّب بالزعيم؟','الهلال',['النصر','الاتحاد','الأهلي']],
  ['كم شوطًا في مباراة كرة القدم الأساسية؟','شوطان',['ثلاثة','أربعة','شوط واحد']],
  ['ما الرياضة التي تُلعب على طاولة بمضرب صغير؟','تنس الطاولة',['الاسكواش','البادل','الريشة الطائرة']],
  ['كم دقيقة يستمر الشوط الواحد في كرة القدم؟','٤٥ دقيقة',['٣٠ دقيقة','٤٠ دقيقة','٦٠ دقيقة']]
 ],
 'تقنية':[
  ['ما الشركة المطوِّرة لنظام أندرويد؟','قوقل',['آبل','سامسونج','مايكروسوفت']],
  ['ما اللغة المستخدمة لبناء هيكل صفحات الويب؟','HTML',['CSS','Python','SQL']],
  ['من المؤسس المشارك لشركة مايكروسوفت؟','بيل قيتس',['ستيف جوبز','لاري بيج','مارك زوكربيرغ']],
  ['أيهما أكبر سعةً؟','تيرابايت',['جيجابايت','ميجابايت','كيلوبايت']],
  ['ماذا يعني اختصار AI؟','الذكاء الاصطناعي',['الشبكة الآلية','التحليل الآني','الأمن المعلوماتي']],
  ['ما نظام تشغيل أجهزة آيفون؟','iOS',['أندرويد','ويندوز فون','هارموني']],
  ['أي شركة تصنع معالجات Ryzen؟','AMD',['إنتل','إنفيديا','كوالكوم']],
  ['ما البروتوكول الآمن لتصفح الويب؟','HTTPS',['HTTP','FTP','SMTP']],
  ['كم بِت في البايت الواحد؟','٨',['٤','١٦','٣٢']],
  ['ما اللغة البرمجية التي تعمل داخل المتصفح؟','جافاسكربت',['جافا','سي شارب','روبي']],
  ['ما الشركة المالكة لتطبيق واتساب؟','ميتا',['قوقل','تويتر','تيليجرام']],
  ['ماذا تعني كلمة "خادم" (Server) في الشبكات؟','جهاز يقدّم البيانات للأجهزة الأخرى',['برنامج تصفح','كابل الشبكة','نوع من الطابعات']]
 ],
 'منوعات':[
  ['ما المشروب المستخرج من حبوب البُنّ؟','القهوة',['الشاي','الكاكاو','المتّة']],
  ['ما أغلى بهار في العالم؟','الزعفران',['الهيل','الفانيلا','الكمّون']],
  ['ما الطبق السعودي الشهير المكوّن من رز ولحم؟','الكبسة',['المندي اليمني','المقلوبة','الفريكة']],
  ['كم لونًا في قوس قزح؟','٧',['٥','٦','٨']],
  ['ما أكبر حيوان على وجه الأرض؟','الحوت الأزرق',['الفيل الأفريقي','الزرافة','القرش الأبيض']],
  ['أي حيوان يُلقّب بسفينة الصحراء؟','الجمل',['الحصان','الحمار الوحشي','المها']],
  ['كم يومًا في السنة الكبيسة؟','٣٦٦',['٣٦٥','٣٦٤','٣٦٧']],
  ['كم عدد أيام شهر رمضان في أكثر حالاته؟','٣٠',['٢٨','٢٩','٣١']],
  ['ما اللون الناتج عن خلط الأزرق والأصفر؟','الأخضر',['البرتقالي','البنفسجي','البني']],
  ['كم قطعة شطرنج لكل لاعب في بداية اللعبة؟','١٦',['١٢','٨','٢٠']],
  ['ما الحشرة التي تنتج العسل؟','النحل',['النمل','الفراشة','الزنبور']],
  ['كم عدد أوتار العود العربي التقليدي؟','خمسة أزواج',['ستة أفراد','ثلاثة أزواج','أربعة أفراد']]
 ]
};
const FATIN_CATS = Object.keys(FATIN_BANK);
function fatinShuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function fatinPickCats(n){return fatinShuffle(FATIN_CATS.slice()).slice(0,n)}

const FATIN_TOP = 24, FATIN_ROUNDS = 7;
const FATIN_HILAS = ['ice', 'ink', 'lock', 'spin', 'fog'];
const FATIN_COLORS = ['#E3A93C', '#2E9E93', '#C1403A', '#7C6BD8', '#4C9BE8', '#D46FA8'];
const FATIN_MAXP = 6;
const FATIN_SDP_MAX = 9000;

export class FatinRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map();
    this.screens = new Map();   // معرّف الشاشة -> socket (مشاهدون، خارج المقاعد)
    this.timer = null;
    this.state.blockConcurrencyWhile(async () => {
      this.room = (await this.state.storage.get('room')) || {
        code: null, hostId: null, phase: 'lobby',
        players: [],            // {id,name,color,connected,steps,pts,ammo,special,seatToken}
        round: 0, cat: '', catOptions: [],
        votes: {}, specials: {}, specialBy: null, tally: {},
        hilas: {}, effects: {},
        q: null, opts: [], correct: -1, answers: {}, gains: {},
        qStart: 0, endsAt: 0, used: {},
      };
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/ws')) return this.handleWebSocket(request);
    if (url.pathname.endsWith('/create')) return this.handleCreate(request);
    return new Response('غير موجود', { status: 404 });
  }

  async handleCreate(request) {
    let body;
    try { body = await request.json(); } catch { return new Response('bad-json', { status: 400 }); }
    const { name, roomCode, screen } = body || {};
    if (this.room.code && this.room.players.length && this.room.phase !== 'over') {
      return new Response('room-exists', { status: 409 });
    }
    this.room.code = roomCode;
    // إنشاء من التلفزيون: الغرفة تُفتح بلا مقاعد، وأول لاعب ينضم يصير المضيف
    if (screen) {
      this.room.hostId = null;
      this.room.players = [];
      // توكن الشاشة: بدونه كان أي أحد يعرف الرمز يقدر يفتح ?screen=1 ويبدأ اللعبة
      this.room.screenToken = newSeatToken();
      await this.persist();
      return Response.json({ roomCode: this.room.code, playerId: null, screenToken: this.room.screenToken });
    }
    const hostId = crypto.randomUUID();
    const hostToken = newSeatToken();
    this.room.hostId = hostId;
    this.room.players = [{
      id: hostId, name: cleanName(name), color: FATIN_COLORS[0], connected: false,
      steps: 0, pts: 0, ammo: 2, special: true, seatToken: hostToken,
    }];
    await this.persist();
    return Response.json({ roomCode: this.room.code, playerId: hostId, seatToken: hostToken });
  }

  async handleWebSocket(request) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('يتطلب WebSocket', { status: 426 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    // ── عميل الشاشة: مشاهد فقط، خارج المقاعد، ما يوقف عليه أحد ──
    if (url.searchParams.get('screen') === '1') {
      // شاشة موثّقة فقط تقدر ترسل أوامر؛ غيرها مشاهدة صامتة
      const trusted = !!this.room.screenToken &&
        tokenEquals(url.searchParams.get('stoken'), this.room.screenToken);
      const sid = 'screen:' + crypto.randomUUID();
      this.screens.set(sid, server);
      server.addEventListener('message', evt => { if (trusted) this.onScreenMessage(evt); });
      server.addEventListener('close', () => this.screens.delete(sid));
      server.addEventListener('error', () => this.screens.delete(sid));
      this.sendState(server, null, true);
      return new Response(null, { status: 101, webSocket: client });
    }

    const playerId = url.searchParams.get('playerId');
    const name = url.searchParams.get('name');
    const token = url.searchParams.get('token');

    // ── التوكن أولاً، والمعرّف لا يمنح دخولاً أبدًا ──
    let player = this.seatByToken(token);
    if (player) {
      const seat = player;
      {
        const oldId = seat.id;
        const newId = (validPlayerId(playerId) && !this.room.players.some(p => p.id === playerId)) ? playerId : oldId;
        seat.id = newId;
        for (const bag of ['votes', 'specials', 'hilas', 'effects', 'answers', 'gains']) {
          if (this.room[bag] && oldId in this.room[bag]) {
            this.room[bag][newId] = this.room[bag][oldId];
            delete this.room[bag][oldId];
          }
        }
        // أي حِيلة كانت مصوّبة على المعرّف القديم
        for (const k of Object.keys(this.room.hilas || {})) {
          if (this.room.hilas[k] && this.room.hilas[k].target === oldId) this.room.hilas[k].target = newId;
        }
        if (this.room.hostId === oldId) this.room.hostId = newId;
        const stale = this.sockets.get(oldId);
        if (stale && stale !== server) { try { stale.close(); } catch {} }
        this.sockets.delete(oldId);
        player = seat;
      }
    }

    if (!player) {
      // رمز ما أُنشئت له غرفة أصلًا
      if (!this.room.code) {
        server.send(JSON.stringify({ type: 'error', message: 'ما فيه غرفة بهذا الرمز' }));
        server.close();
        return new Response(null, { status: 101, webSocket: client });
      }
      if (this.room.phase !== 'lobby') {
        server.send(JSON.stringify({ type: 'error', message: 'اللعبة بدأت — ما تقدر تنضم الحين' }));
        server.close();
        return new Response(null, { status: 101, webSocket: client });
      }
      if (this.room.players.length >= Math.min(FATIN_MAXP, MAX_PLAYERS)) {
        server.send(JSON.stringify({ type: 'error', message: 'الغرفة ممتلئة (٦ لاعبين)' }));
        server.close();
        return new Response(null, { status: 101, webSocket: client });
      }
      player = {
        id: crypto.randomUUID(), name: cleanName(name),
        color: FATIN_COLORS[this.room.players.length % FATIN_COLORS.length],
        connected: true, steps: 0, pts: 0, ammo: 2, special: true, seatToken: newSeatToken(),
      };
      this.room.players.push(player);
    } else {
      player.connected = true;
    }
    // غرفة أنشأها التلفزيون: أول لاعب يدخل يصير المضيف
    if (!this.room.hostId || !this.findPlayer(this.room.hostId)) this.room.hostId = player.id;

    this.sockets.set(player.id, server);
    server.addEventListener('message', evt => this.onMessage(player.id, evt));
    server.addEventListener('close', () => this.onClose(player.id));

    await this.persist();
    if (!player.seatToken) player.seatToken = newSeatToken();
    this.sendPrivate(player.id, {
      type: 'welcome', playerId: player.id, roomCode: this.room.code, seatToken: player.seatToken,
    });
    this.broadcastState();   // يشمل إعادة إرسال حالة المرحلة الجارية للعائد

    return new Response(null, { status: 101, webSocket: client });
  }

  onScreenMessage(evt) {
    // الشاشة تستقبل فقط، ما عدا زر البدء على التلفزيون
    let msg; try { msg = JSON.parse(evt.data); } catch { return; }
    if (msg && msg.type === 'startGame' && this.room.phase === 'lobby' && this.activePlayers().length >= 2) {
      this.startVote();
    }
  }

  async onMessage(playerId, evt) {
    if (!this.allowMsg(playerId)) return;
    let msg; try { msg = JSON.parse(evt.data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const r = this.room;
    const p = this.findPlayer(playerId);
    if (!p) return;

    if (msg.type === 'startGame' && playerId === r.hostId && r.phase === 'lobby') {
      if (this.activePlayers().length < 2) return;
      r.round = 0;
      await this.startVote();
    }
    else if (msg.type === 'vote' && r.phase === 'vote') {
      if (!r.catOptions.includes(msg.cat)) return;
      r.votes[playerId] = msg.cat;
      await this.persist(); this.broadcastState();
      if (this.allVotedIn()) await this.endVote();
    }
    else if (msg.type === 'special' && r.phase === 'vote') {
      if (!p.special || !r.catOptions.includes(msg.cat)) return;
      p.special = false;
      r.specials[playerId] = msg.cat;
      delete r.votes[playerId];
      await this.persist(); this.broadcastState();
      if (this.allVotedIn()) await this.endVote();
    }
    else if (msg.type === 'hila' && r.phase === 'hila') {
      if (r.hilas[playerId]) return;
      if (msg.skip) { r.hilas[playerId] = { skip: true }; }
      else {
        if (!FATIN_HILAS.includes(msg.hila)) return;
        const tgt = this.findPlayer(msg.target);
        if (!tgt || msg.target === playerId) return;
        if (p.ammo <= 0) return;
        p.ammo--;
        r.hilas[playerId] = { hila: msg.hila, target: msg.target };
        r.effects[msg.target] = msg.hila;
      }
      await this.persist(); this.broadcastState();
      if (this.allHilasIn()) await this.endHila();
    }
    else if (msg.type === 'answer' && r.phase === 'question') {
      if (r.answers[playerId]) return;
      r.answers[playerId] = {
        idx: (typeof msg.idx === 'number' ? msg.idx : -1),
        ms: Date.now() - r.qStart,
      };
      await this.persist(); this.broadcastState();
      if (this.allAnswersIn()) await this.endQuestion();
    }
    else if (msg.type === 'sig') {
      // ناقل إشارات WebRTC: أنواع معروفة + حقول بيضاء + سقف حجم.
      // الصور نفسها تمشي ند-لند وما تمر من هنا إطلاقًا.
      if (typeof msg.to !== 'string' || msg.to === playerId) return;
      const target = this.sockets.get(msg.to);
      if (!target || !this.findPlayer(msg.to)) return;
      const d = msg.data;
      if (!d || typeof d !== 'object') return;
      let out = null;
      if (d.type === 'offer' || d.type === 'answer') {
        if (typeof d.sdp !== 'string' || d.sdp.length > FATIN_SDP_MAX) return;
        out = { type: d.type, sdp: d.sdp };
      } else if (d.type === 'candidate') {
        const c = d.candidate;
        if (!c || typeof c !== 'object') return;
        if (typeof c.candidate !== 'string' || c.candidate.length > 400) return;
        out = { type: 'candidate', candidate: {
          candidate: c.candidate,
          sdpMid: (typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, 32) : null),
          sdpMLineIndex: (typeof c.sdpMLineIndex === 'number' ? c.sdpMLineIndex : null),
          usernameFragment: (typeof c.usernameFragment === 'string' ? c.usernameFragment.slice(0, 64) : undefined),
        } };
      } else return;
      try { target.send(JSON.stringify({ type: 'sig', from: playerId, data: out })); } catch {}
      // لا شيء يُحفظ — تُنقل وتُنسى
    }
    else if (msg.type === 'kickPlayer' && playerId === r.hostId && r.phase === 'lobby') {
      await this.kickPlayer(msg.targetId);
    }
    else if (msg.type === 'hostForceAdvance' && playerId === r.hostId) {
      await this.forceAdvance();
    }
    else if (msg.type === 'nextRound' && playerId === r.hostId && r.phase === 'result') {
      this.clearPhaseTimer();
      if (r.round >= FATIN_ROUNDS) await this.finish(); else await this.startVote();
    }
    else if (msg.type === 'playAgain' && playerId === r.hostId && r.phase === 'over') {
      for (const q of r.players) { q.steps = 0; q.pts = 0; q.ammo = 2; q.special = true; }
      r.used = {}; r.round = 0;
      await this.startVote();
    }
  }

  async onClose(playerId) {
    const p = this.findPlayer(playerId);
    if (p) p.connected = false;
    this.sockets.delete(playerId);
    this.migrateHostIfNeeded();
    await this.persist();
    this.broadcastState();
    await this.maybeAdvanceOnDisconnect();
  }

  migrateHostIfNeeded() {
    const host = this.room.players.find(p => p.id === this.room.hostId);
    if (host && host.connected) return false;
    const next = this.room.players.find(p => p.connected && p.id !== this.room.hostId);
    if (!next) return false;
    this.room.hostId = next.id;
    this.broadcastPublic({ type: 'hostChanged', hostId: next.id, hostName: next.name });
    return true;
  }

  async kickPlayer(targetId) {
    if (targetId === this.room.hostId) return;
    const target = this.findPlayer(targetId);
    if (!target) return;
    this.sendPrivate(targetId, { type: 'kicked' });
    const ws = this.sockets.get(targetId);
    if (ws) { try { ws.close(); } catch {} this.sockets.delete(targetId); }
    this.room.players = this.room.players.filter(p => p.id !== targetId);
    await this.persist();
    this.broadcastState();
  }

  // المنقطع ما يعلّق الجولة
  async maybeAdvanceOnDisconnect() {
    const r = this.room;
    if (r.phase === 'vote' && this.allVotedIn()) await this.endVote();
    else if (r.phase === 'hila' && this.allHilasIn()) await this.endHila();
    else if (r.phase === 'question' && this.allAnswersIn()) await this.endQuestion();
  }

  findPlayer(id) { return this.room.players.find(p => p.id === id); }
  activePlayers() { return this.room.players.filter(p => p.connected); }

  /* مؤقّت المرحلة — بدونه شريط الوقت يخلص وما يصير شي.
     الـ DO يبقى حيًّا ما دامت هناك اتصالات مفتوحة، فـ setTimeout كافٍ. */
  setPhaseTimer(ms, fn) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = null;
      try { await fn(); } catch (e) {}
    }, ms);
  }
  clearPhaseTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  allVotedIn() { const a = this.activePlayers(); return a.length > 0 && a.every(p => this.room.votes[p.id] || this.room.specials[p.id]); }
  allHilasIn() { const a = this.activePlayers(); return a.length > 0 && a.every(p => this.room.hilas[p.id]); }
  allAnswersIn() { const a = this.activePlayers(); return a.length > 0 && a.every(p => this.room.answers[p.id]); }

  /* ---------- المراحل (كل واحدة بحارس حسم مزدوج) ---------- */
  async startVote() {
    const r = this.room;
    r.round++;
    if (r.round > FATIN_ROUNDS) return this.finish();
    r.phase = 'vote';
    r.votes = {}; r.specials = {}; r.specialBy = null; r.tally = {};
    r.hilas = {}; r.effects = {}; r.answers = {}; r.gains = {};
    r.q = null; r.opts = []; r.correct = -1;
    r.catOptions = fatinPickCats(3);
    r.endsAt = Date.now() + 15000;
    await this.persist();
    this.broadcastState();
    this.setPhaseTimer(15000, () => this.endVote());
  }

  async endVote() {
    const r = this.room;
    if (r.phase !== 'vote') return;
    this.clearPhaseTimer();
    r.phase = 'resolvingVote';
    const specialIds = Object.keys(r.specials);
    const tally = {};
    r.catOptions.forEach(c => tally[c] = 0);
    for (const id in r.votes) if (tally[r.votes[id]] !== undefined) tally[r.votes[id]]++;
    r.tally = tally;

    if (specialIds.length) {
      // أكثر من اختيار خاص: واحد بالقرعة، والباقي يسترجعون حقّهم
      const winner = specialIds[Math.floor(Math.random() * specialIds.length)];
      for (const id of specialIds) if (id !== winner) { const q = this.findPlayer(id); if (q) q.special = true; }
      r.cat = r.specials[winner];
      const w = this.findPlayer(winner);
      r.specialBy = w ? w.name : null;
    } else {
      let best = -1, pool = [];
      for (const c of r.catOptions) {
        if (tally[c] > best) { best = tally[c]; pool = [c]; }
        else if (tally[c] === best) pool.push(c);
      }
      r.cat = pool[Math.floor(Math.random() * pool.length)];
      r.specialBy = null;
    }
    await this.startHila();
  }

  async startHila() {
    const r = this.room;
    r.phase = 'hila';
    r.hilas = {}; r.effects = {};
    r.endsAt = Date.now() + 12000;
    await this.persist();
    this.broadcastState();
    this.setPhaseTimer(12000, () => this.endHila());
  }

  async endHila() {
    const r = this.room;
    if (r.phase !== 'hila') return;
    this.clearPhaseTimer();
    r.phase = 'question';
    const list = FATIN_BANK[r.cat];
    if (!r.used[r.cat]) r.used[r.cat] = [];
    if (r.used[r.cat].length >= list.length) r.used[r.cat] = [];
    const avail = list.map((_, i) => i).filter(i => !r.used[r.cat].includes(i));
    const pick = avail[Math.floor(Math.random() * avail.length)];
    r.used[r.cat].push(pick);
    const row = list[pick];
    const opts = fatinShuffle([row[1]].concat(row[2]));
    r.q = row[0];
    r.opts = opts;
    r.correct = opts.indexOf(row[1]);
    r.answers = {};
    r.qStart = Date.now();
    r.endsAt = r.qStart + 15000;
    await this.persist();
    this.broadcastState();
    this.setPhaseTimer(15700, () => this.endQuestion());
  }

  async endQuestion() {
    const r = this.room;
    if (r.phase !== 'question') return;
    this.clearPhaseTimer();
    r.phase = 'result';
    r.gains = {};
    for (const p of r.players) {
      const a = r.answers[p.id];
      let gain = 0;
      if (a && a.idx === r.correct) {
        const s = a.ms / 1000;
        gain = s < 5 ? 3 : (s < 10 ? 2 : 1);
        if (r.round === FATIN_ROUNDS) gain *= 2;
        p.steps = Math.min(FATIN_TOP, p.steps + gain);
        p.pts += gain * 10 + Math.max(0, Math.round(15 - s));
        p.ammo = Math.min(4, p.ammo + 1);
      }
      r.gains[p.id] = gain;
    }
    r.endsAt = Date.now() + 7000;
    await this.persist();
    this.broadcastState();
    this.setPhaseTimer(7000, async () => {
      if (r.round >= FATIN_ROUNDS) await this.finish(); else await this.startVote();
    });
  }

  async finish() {
    this.clearPhaseTimer();
    this.room.phase = 'over';
    this.room.endsAt = 0;
    await this.persist();
    this.broadcastState();
  }

  async forceAdvance() {
    const r = this.room;
    if (r.phase === 'vote') await this.endVote();
    else if (r.phase === 'hila') await this.endHila();
    else if (r.phase === 'question') await this.endQuestion();
    else if (r.phase === 'result') { if (r.round >= FATIN_ROUNDS) await this.finish(); else await this.startVote(); }
  }

  /* ---------- الإرسال ---------- */
  publicPlayers() {
    const r = this.room;
    return r.players.map(p => ({
      id: p.id, name: p.name, color: p.color, steps: p.steps, pts: p.pts,
      connected: p.connected, host: p.id === r.hostId, special: p.special,
      voted: !!(r.votes[p.id] || r.specials[p.id]),
      ready: !!r.hilas[p.id],
      answered: !!r.answers[p.id],
      gain: r.gains[p.id] || 0,
    }));
  }

  stateFor(playerId, isScreen) {
    const r = this.room;
    const me = this.findPlayer(playerId) || {};
    const showQ = (r.phase === 'question' || r.phase === 'result');
    return {
      type: 'state', screen: !!isScreen,
      code: r.code, phase: r.phase, round: r.round, rounds: FATIN_ROUNDS, top: FATIN_TOP,
      hostId: r.hostId,
      cat: r.cat, catOptions: r.catOptions,
      tally: (r.phase === 'vote' ? null : r.tally),
      specialBy: (r.phase === 'vote' ? null : r.specialBy),
      q: showQ ? r.q : null,
      opts: showQ ? r.opts : [],
      correct: (r.phase === 'result' ? r.correct : -1),   // ما ينكشف أثناء السؤال
      endsAt: r.endsAt, now: Date.now(),
      players: this.publicPlayers(),
      you: {
        id: playerId, ammo: me.ammo || 0, special: !!me.special,
        host: playerId === r.hostId,
        effect: (r.phase === 'question') ? (r.effects[playerId] || null) : null,
        myAnswer: r.answers[playerId] ? r.answers[playerId].idx : null,
        myVote: r.votes[playerId] || r.specials[playerId] || null,
        myHila: r.hilas[playerId] || null,
      },
    };
  }

  sendState(ws, playerId, isScreen) {
    try { ws.send(JSON.stringify(this.stateFor(playerId, isScreen))); } catch {}
  }

  broadcastState() {
    for (const [pid, ws] of this.sockets) this.sendState(ws, pid, false);
    for (const [, ws] of this.screens) this.sendState(ws, null, true);
  }

  broadcastPublic(payload) {
    const s = JSON.stringify(payload);
    for (const [, ws] of this.sockets) { try { ws.send(s); } catch {} }
    for (const [, ws] of this.screens) { try { ws.send(s); } catch {} }
  }

  sendPrivate(playerId, payload) {
    const ws = this.sockets.get(playerId);
    if (ws) { try { ws.send(JSON.stringify(payload)); } catch {} }
  }

  async persist() { await this.touchRoom(); await this.state.storage.put('room', this.room); }
}


/* ══════════════════════ وَليمة — أونلاين ══════════════════════
   كل ضيف على جواله. الأدوار تُوزَّع في السيرفر ولا تُبَث للجميع،
   ونداء «المحقق» (الذكاء) يتم من السيرفر — العميل ما يعرف دور غيره أصلًا. */
const WL_SCENES = [
  {
    "occ": "عشاءُ جمعِ شملِ العائلة",
    "crime": "اختفى عِقدُ الجدّة الذهبيّ من الدُّرجِ المُقفَل.",
    "detail": "وقعتِ السرقةُ بين المغربِ والعشاء، حين انشغل الجميعُ بتجهيزِ المائدة. الدُّرجُ فُتح بمفتاحه لا بالكسر — أي أنّ الفاعلَ يعرف مكانَ المفتاح.",
    "confession": "أنتَ من أخذ العِقد. تسلّلتَ إلى الغرفةِ وقتَ صلاةِ المغرب، أخرجتَ المفتاحَ من تحتِ المزهريّة — تعرف مكانَه منذ سنين — وأخذتَ العِقدَ ودسستَه في جيبِك. أعِدِ المفتاحَ مكانَه، ولا أحدَ رآك… على حدِّ علمك."
  },
  {
    "occ": "مأدبةُ خطوبة",
    "crime": "وصلت رسالةٌ تكشف أنّ أحدَ الحاضرين متزوّجٌ في الخفاء.",
    "detail": "الرسالةُ وصلت لهاتفِ العريسِ من رقمٍ مجهول، في تمامِ التاسعة، أثناءَ تقديمِ القهوة. من أرسلها يعرف تفاصيلَ دقيقةً لا يعرفها غريب.",
    "confession": "أنتَ من أرسل الرسالة. تعرفُ سرَّ الزواجِ الخفيّ منذ شهور، وجهّزتَ شريحةً جديدةً لهذا الغرض. أرسلتَها من دورةِ المياهِ في التاسعةِ تماماً، ثم عدتَ إلى مقعدِك وكأنّ شيئاً لم يكن."
  },
  {
    "occ": "عزاءُ الوالد",
    "crime": "اكتُشف أنّ الوصيّةَ زُوِّرت قبل ساعاتٍ من الدفن.",
    "detail": "الوصيّةُ الأصليّةُ كانت في مكتبِ المرحوم. النسخةُ المزوّرةُ كُتبت بقلمٍ مختلفٍ وأُعيدت للملفِّ نفسِه — والمكتبُ لم يدخله إلا القليل صباحَ ذلك اليوم.",
    "confession": "أنتَ من زوّر الوصيّة. دخلتَ المكتبَ فجراً بحجّةِ ترتيبِ أوراقِ العزاء، بدّلتَ الصفحةَ الأخيرةَ بأخرى كتبتَها بخطٍّ مقلَّد، وأعدتَ الملفَّ مكانَه. القلمُ الذي استعملتَه ما زال في جيبِك."
  },
  {
    "occ": "وليمةُ مصالحةٍ بين فرعين متخاصمين",
    "crime": "دُسَّ شيءٌ في طعامِ أحدِ الجالسين فاعتلَّ على المائدة.",
    "detail": "الصحنُ المقصودُ مرَّ من المطبخِ إلى المائدةِ على أيدٍ ثلاث. المادّةُ المدسوسةُ لا تُميتُ لكن تفضح — أثرُها يظهر خلالَ دقائق، وقد ظهر.",
    "confession": "أنتَ من دسَّ المادّة. أخذتَها من صيدليّةِ البيت، ورششتَها على الصحنِ حين تطوّعتَ لحملِه من المطبخ. اخترتَ الضحيّةَ عمداً — لحسابٍ قديمٍ بينكما لا يعرفه أحدٌ هنا."
  },
  {
    "occ": "غداءُ العائلةِ الأسبوعيّ",
    "crime": "تبيّن أنّ مبلغاً كبيراً سُرق من حسابِ الشركةِ العائليّة.",
    "detail": "التحويلُ تمَّ قبلَ الغداءِ بيومين، من جهازٍ داخلَ البيتِ نفسِه، إلى حسابٍ وسيطٍ أُغلق بعدها. من فعلها يعرف كلمةَ المرورِ — وهي لا يعرفها إلا المقرّبون.",
    "confession": "أنتَ من حوّل المبلغ. تعرفُ كلمةَ المرورِ لأنّك رأيتَها تُكتب أمامك قبل شهور ولم تنسَها. استعملتَ حاسوبَ البيتِ ليلاً، وحوّلتَ المبلغَ لحسابٍ وسيطٍ جهّزتَه من قبل. الدَّينُ الذي عليك كان سيفضحُك لولا هذا المال."
  },
  {
    "occ": "حفلُ عودةِ الابنِ المغترب",
    "crime": "عُثر على تهديدٍ مكتوبٍ تحت طبقِ أحدِهم.",
    "detail": "الورقةُ كُتبت بخطٍّ مُتعمَّدِ التغيير، وطُويت بعنايةٍ ووُضعت تحتَ الطبقِ قبل الجلوسِ بقليل — أي أثناءَ ترتيبِ المائدةِ تحديداً.",
    "confession": "أنتَ من كتب التهديد. كتبتَه بيدِك اليسرى ليتغيّرَ خطُّك، وطويتَه ودسستَه تحت الطبقِ حين تطوّعتَ بترتيبِ المائدة. تقصدُ صاحبَ الطبقِ تحديداً — رسالةٌ يفهمها هو وحدَه، وقد فهمها."
  }
];

const WL_CLUES = [
  "يُقال إنّ أحدَهم غادر المائدة دقائقَ قبل أن يُكتشف الأمر.",
  "بقيت أثارٌ غريبةٌ على ما لا ينبغي لمسُه.",
  "سمِع أحدُ الخدمِ همساً متوتّراً في الممرّ.",
  "كان أحدُهم يرتجف حين طُرح الأمرُ أوّلَ مرّة.",
  "اختفى شيءٌ صغيرٌ من مكانه، لم ينتبه له إلا القليل.",
  "تناقَضَ ما قيل عن توقيتِ الحادثةِ مرّتين.",
  "رائحةٌ لا تخصّ المكان عَلِقت بالهواء."
];

const WL_ALIBIS = [
  "كنتَ في المطبخِ تساعد في تجهيزِ الصحون.",
  "كنتَ في الحوشِ تردُّ على مكالمةٍ طالت.",
  "كنتَ جالساً قربَ كبيرِ العائلةِ تسمع قصصَه.",
  "كنتَ تلاعبُ الأطفالَ في الغرفةِ المجاورة.",
  "كنتَ خارجَ البيتِ تُوقفُ سيارتَك من جديد.",
  "كنتَ في دورةِ المياهِ وقتَها — ولا شاهدَ لك.",
  "كنتَ تُصوّرُ المائدةَ والضيوفَ بهاتفِك.",
  "كنتَ نائماً في الغرفةِ الجانبيّةِ من التعب.",
  "كنتَ تبحثُ عن شاحنٍ لهاتفِك في أرجاءِ البيت.",
  "كنتَ واقفاً عندَ البابِ تستقبلُ ضيفاً متأخّراً."
];

const WL_ROLES = [
  {
    "key": "culprit",
    "t": "الجاني",
    "evil": true,
    "winType": "escape",
    "secret": "أنتَ من فعلها. لا أحدَ يعلم بعد.",
    "goal": "حوّل الشكَّ إلى غيرك، واخرُج من الوليمة دون أن يتّهمك المضيف.",
    "desc": "أنتَ صاحبُ الجريمة. حوّلِ الشكَّ إلى غيرك واخرُج دون أن يتّهمك المضيف. يفوز إن لم يُتّهم."
  },
  {
    "key": "innocent",
    "t": "ضيفٌ بريء",
    "winType": "escape",
    "secret": "لا شيءَ يُثقل صدرَك، ولا سرَّ تخفيه.",
    "goal": "تصرّف بطبيعتك، ولا تدَع الشكَّ يقعَ عليك.",
    "desc": "ضيفٌ عاديّ، لا سرَّ له ولا هدفَ خاصّاً. يفوز إن لم يُتّهم."
  },
  {
    "key": "framed",
    "t": "البريء المُدان",
    "winType": "escape",
    "secret": "كلُّ القرائنِ تشير إليك، وأنتَ بريءٌ تماماً.",
    "goal": "أقنِع المضيفَ ببراءتك حتى لا يتّهمك.",
    "desc": "القرائنُ كلُّها تشير إليك وأنتَ بريء. أقنِعِ المضيفَ ببراءتك. يفوز إن لم يُتّهم."
  },
  {
    "key": "protector",
    "t": "الحامي",
    "winType": "protect",
    "needs": "protect",
    "secret": "تحبّ أحدَ الجالسين وستحميه مهما بدا مذنباً.",
    "goal": "احرِص ألّا يقعَ الاتّهامُ على {target}.",
    "desc": "تحمي أحدَ الجالسين سرّاً. يفوز إن لم يقعِ الاتّهامُ على محميِّه."
  },
  {
    "key": "avenger",
    "t": "المنتقم",
    "winType": "avenge",
    "needs": "enemy",
    "secret": "جئتَ لهذه المائدةِ لحسابٍ قديم.",
    "goal": "اجعلِ المضيفَ يتّهم {target} مهما كلّفك.",
    "desc": "جئتَ لحسابٍ قديم مع أحدِهم. يفوز إن اتّهم المضيفُ خصمَك."
  },
  {
    "key": "scapegoat",
    "t": "كبشُ الفداء",
    "winType": "scapegoat",
    "secret": "قرّرتَ أن تحملَ الذنبَ على عاتقك — لسببٍ تعرفه أنت وحدك.",
    "goal": "اجعلِ المضيفَ يتّهمك أنتَ، دون أن يبدوَ تورّطُك مفتعلاً.",
    "desc": "تريد أن يقعَ الاتّهامُ عليك أنتَ (تحمي الجاني أو لحسابٍ خاص). تفوز إن اتّهمك المضيف."
  },
  {
    "key": "accomplice",
    "t": "المتواطئ",
    "winType": "complicit",
    "secret": "مصلحتُك مع الجاني لا مع المائدة؛ أنتَ في صفّه سرّاً.",
    "goal": "اِزرعِ الشكَّ ووجِّهِ المضيفَ نحو بريء، حتى يفلتَ الجاني.",
    "desc": "أنتَ في صفِّ الجاني سرّاً. اِزرعِ الشكَّ ووجّهِ المضيفَ نحو بريء. تفوز إن لم يُمسكِ المضيفُ الجاني."
  }
];

const WL_DISPOSITIONS = [
  {
    "key": "merciful",
    "text": "أنت رحيمٌ تكره إدانةَ بريء؛ تبحث عن اعترافٍ صادقٍ لا عن كبشِ فداء، وتتمهّل قبل أن تتّهم."
  },
  {
    "key": "ruthless",
    "text": "أنت صارمٌ تريد جانياً قبل أن تنفضَّ المائدة؛ تضغط بقوّةٍ ولا ترحم المتلعثم."
  },
  {
    "key": "cynical",
    "text": "لا تثق بأحدٍ على هذه المائدة؛ ترى الكذبَ في كلِّ وجهٍ وتفترض أنّ الجميع يُخفون شيئاً."
  },
  {
    "key": "biased",
    "target": true,
    "text": "في قلبك ميلٌ قديمٌ ضدّ {target}؛ تميل لتصديقِ أنّه الفاعل ما لم يُفحِمك الآخرون بعكس ذلك."
  },
  {
    "key": "soft",
    "target": true,
    "text": "تحبّ {target} في قرارةِ نفسك وتميل لحمايته؛ يصعُب عليك توجيهُ الاتّهامِ إليه."
  }
];

const WL_ROUNDS = 2;
const WL_AI_ENDPOINT = 'https://ya7-ai-proxy.alfyfyy100.workers.dev/walima/chat';
const WL_AI_MODEL = 'deepseek/deepseek-v4-flash';
const WL_MAX_STATEMENT = 400;

function wlPick(a){ return a[Math.floor(Math.random()*a.length)]; }
function wlShuffle(a){ const c=a.slice(); for(let i=c.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [c[i],c[j]]=[c[j],c[i]]; } return c; }
function wlGrab(text, tag){
  const m = String(text||'').match(new RegExp('<'+tag+'>([\\s\\S]*?)</'+tag+'>'));
  return m ? m[1].trim() : '';
}
function wlSafeJSON(t){
  if (!t) return null;
  try { return JSON.parse(t); } catch {}
  const m = String(t).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

export class WalimaRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map();
    this.state.blockConcurrencyWhile(async () => {
      this.room = (await this.state.storage.get('room')) || {
        code: null, hostId: null, phase: 'lobby',
        players: [], // {id,name,connected,seatToken,role,alibi,target,enemy,sus,statement,submitted}
        scene: null, clues: [], disposition: null,
        round: 1, rounds: WL_ROUNDS, transcript: [],
        hostSays: '', lastSus: {}, verdict: null, thinking: false,
      };
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/ws')) return this.handleWebSocket(request);
    if (url.pathname.endsWith('/create')) return this.handleCreate(request);
    return new Response('غير موجود', { status: 404 });
  }

  async handleCreate(request) {
    let body;
    try { body = await request.json(); } catch { return new Response('bad-json', { status: 400 }); }
    const { name, roomCode } = body || {};
    if (this.room.code && this.room.players.length && this.room.phase !== 'over') {
      return new Response('room-exists', { status: 409 });
    }
    this.room.code = roomCode;
    const hostId = crypto.randomUUID();
    const hostToken = newSeatToken();
    this.room.hostId = hostId;
    this.room.players = [{ id: hostId, name: cleanName(name), connected: false, seatToken: hostToken, role: null, sus: 0 }];
    await this.persist();
    return Response.json({ roomCode: this.room.code, playerId: hostId, seatToken: hostToken });
  }

  async handleWebSocket(request) {
    const url = new URL(request.url);
    const playerId = url.searchParams.get('playerId');
    const name = url.searchParams.get('name');
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('يتطلب WebSocket', { status: 426 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const token = url.searchParams.get('token');
    let player = this.seatByToken(token);
    if (player) {
      const oldId = player.id;
      const newId = (validPlayerId(playerId) && !this.room.players.some(p => p.id === playerId)) ? playerId : oldId;
      if (newId !== oldId && !this.room.players.some(p => p.id === newId)) {
        player.id = newId;
        if (this.room.hostId === oldId) this.room.hostId = newId;
        const stale = this.sockets.get(oldId);
        if (stale) { try { stale.close(); } catch {} }
        this.sockets.delete(oldId);
      } else {
        const stale = this.sockets.get(oldId);
        if (stale && stale !== server) { try { stale.close(); } catch {} }
      }
    }

    // ع-١ · رمز لم تُنشأ له غرفة: لا نُنشئها من اتصال WebSocket.
    // بدون هذا يتجاوز المهاجم حدّ allowCreate بالكامل ويفرّخ غرفًا بلا سقف.
    if (!player && !this.room.code) {
      server.send(JSON.stringify({ type: 'error', message: 'ما فيه غرفة بهذا الرمز' }));
      server.close();
      return new Response(null, { status: 101, webSocket: client });
    }

    if (!player) {
      if (this.room.phase !== 'lobby') {
        server.send(JSON.stringify({ type: 'error', message: 'الوليمة بدأت، ما تقدر تنضم الآن' }));
        server.close();
        return new Response(null, { status: 101, webSocket: client });
      }
      if (this.room.players.length >= 10) {
        server.send(JSON.stringify({ type: 'error', message: 'المائدة ممتلئة' }));
        server.close();
        return new Response(null, { status: 101, webSocket: client });
      }
      player = { id: crypto.randomUUID(), name: cleanName(name), connected: true, seatToken: newSeatToken(), role: null, sus: 0 };
      this.room.players.push(player);
    } else {
      player.connected = true;
    }
    if (!player.seatToken) player.seatToken = newSeatToken();

    this.sockets.set(player.id, server);
    server.addEventListener('message', evt => this.onMessage(player.id, evt));
    server.addEventListener('close', () => this.onClose(player.id));

    await this.persist();
    this.sendPrivate(player.id, { type: 'welcome', playerId: player.id, roomCode: this.room.code, seatToken: player.seatToken });
    this.broadcastState();
    if (player.role) this.sendPrivate(player.id, this.roleMessageFor(player));
    return new Response(null, { status: 101, webSocket: client });
  }

  seatByToken(token){
    if (!token) return null;
    return this.room.players.find(p => p.seatToken === token) || null;
  }
  findPlayer(id){ return this.room.players.find(p => p.id === id) || null; }
  async persist(){ await this.state.storage.put('room', this.room); }
  sendPrivate(id, payload){
    const ws = this.sockets.get(id);
    if (ws) { try { ws.send(JSON.stringify(payload)); } catch {} }
  }
  broadcastPublic(payload){
    for (const ws of this.sockets.values()) { try { ws.send(JSON.stringify(payload)); } catch {} }
  }

  // الحالة العامة: بلا أدوار ولا نصوص سرّية — الأدوار تُرسل خاصة فقط
  broadcastState(){
    const pub = {
      type: 'state', phase: this.room.phase, code: this.room.code, hostId: this.room.hostId,
      round: this.room.round, rounds: this.room.rounds,
      scene: this.room.phase === 'lobby' ? null : this.room.scene && {
        occ: this.room.scene.occ, crime: this.room.scene.crime, detail: this.room.scene.detail,
      },
      clues: this.room.phase === 'lobby' ? [] : this.room.clues,
      players: this.room.players.map(p => ({ id: p.id, name: p.name, connected: p.connected, sus: p.sus || 0, submitted: !!p.submitted })),
      transcript: this.room.transcript,
      hostSays: this.room.hostSays, lastSus: this.room.lastSus, thinking: !!this.room.thinking,
      verdict: this.room.verdict,
    };
    this.broadcastPublic(pub);
  }

  roleMessageFor(p){
    const r = p.role ? WL_ROLES.find(x => x.key === p.role) : null;
    if (!r) return { type: 'yourRole', role: null };
    let goal = r.goal;
    if (p.target) goal = goal.replace('{target}', p.target);
    if (p.enemy) goal = goal.replace('{target}', p.enemy);
    return {
      type: 'yourRole', role: r.key, roleName: r.t, secret: r.secret, goal,
      alibi: p.alibi, evil: !!r.evil,
      confession: r.key === 'culprit' && this.room.scene ? this.room.scene.confession : null,
    };
  }

  async onMessage(playerId, evt){
    if (!this.allowMsg(playerId)) return;
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'startGame' && playerId === this.room.hostId) await this.startGame();
    if (msg.type === 'statement' && this.room.phase === 'writing') await this.handleStatement(playerId, msg.text);
    if (msg.type === 'nextRound' && playerId === this.room.hostId && this.room.phase === 'beat') await this.nextRound();
    if (msg.type === 'hostForce' && playerId === this.room.hostId && this.room.phase === 'writing') await this.forceRound();
  }

  async onClose(playerId){
    const p = this.findPlayer(playerId);
    if (p) p.connected = false;
    this.sockets.delete(playerId);
    if (this.room.hostId === playerId) {
      const next = this.room.players.find(x => x.connected);
      if (next) this.room.hostId = next.id;
    }
    await this.persist();
    this.broadcastState();
    // ما ننتظر منقطعًا: لو الباقون سلّموا، امضِ
    if (this.room.phase === 'writing' && this.allIn()) await this.runHost(false);
  }

  async startGame(){
    if (this.room.phase !== 'lobby' && this.room.phase !== 'over') return;
    const seated = this.room.players.filter(p => p.connected);
    if (seated.length < 3) {
      this.sendPrivate(this.room.hostId, { type: 'error', message: 'محتاج ٣ ضيوف على الأقل' });
      return;
    }
    this.room.players = seated;
    const n = seated.length;

    const culprit = WL_ROLES.find(r => r.key === 'culprit');
    const innocent = WL_ROLES.find(r => r.key === 'innocent');
    const pool = WL_ROLES.filter(r => r.key !== 'culprit' && r.key !== 'innocent');
    const rest = wlShuffle(pool).slice(0, Math.max(0, Math.min(n - 1, pool.length)));
    while (rest.length < n - 1) rest.push(innocent);
    const dealt = wlShuffle([culprit, ...rest]);

    const alibis = wlShuffle(WL_ALIBIS);
    this.room.players.forEach((p, i) => {
      p.role = dealt[i].key;
      p.sus = 0; p.statement = ''; p.submitted = false;
      p.target = null; p.enemy = null;
      p.alibi = alibis[i % alibis.length];
    });
    // أهداف الحامي والمنتقم — تُختار بعد التوزيع
    this.room.players.forEach(p => {
      const r = WL_ROLES.find(x => x.key === p.role);
      if (!r || !r.needs) return;
      const others = this.room.players.filter(x => x.id !== p.id);
      const pick = wlPick(others);
      if (r.needs === 'protect') p.target = pick.name;
      if (r.needs === 'enemy') p.enemy = pick.name;
    });

    this.room.scene = wlPick(WL_SCENES);
    this.room.clues = wlShuffle(WL_CLUES).slice(0, 2);
    const disp = { ...wlPick(WL_DISPOSITIONS) };
    if (disp.target) disp._target = wlPick(this.room.players).name;
    this.room.disposition = disp;

    this.room.round = 1; this.room.rounds = WL_ROUNDS;
    this.room.transcript = []; this.room.hostSays = ''; this.room.lastSus = {};
    this.room.verdict = null; this.room.thinking = false;
    this.room.phase = 'writing';
    await this.persist();

    for (const p of this.room.players) this.sendPrivate(p.id, this.roleMessageFor(p));
    this.broadcastState();
  }

  allIn(){
    const live = this.room.players.filter(p => p.connected);
    return live.length > 0 && live.every(p => p.submitted);
  }

  async handleStatement(playerId, text){
    const p = this.findPlayer(playerId);
    if (!p || p.submitted) return;
    const clean = cleanText(text, WL_MAX_STATEMENT);
    if (clean.length < 2) { this.sendPrivate(p.id, { type:'error', message:'اكتب شيئًا أولًا' }); return; }
    p.statement = clean; p.submitted = true;
    this.room.transcript.push({ round: this.room.round, name: p.name, text: clean });
    await this.persist();
    this.broadcastState();
    if (this.allIn()) await this.runHost(this.room.round >= this.room.rounds);
  }

  // من لم يتكلّم يُسجَّل صمته — أفضل من تجميد المائدة
  async forceRound(){
    for (const p of this.room.players) {
      if (p.connected && !p.submitted) {
        p.submitted = true; p.statement = '';
        this.room.transcript.push({ round: this.room.round, name: p.name, text: 'صمَت ولم يُجب.' });
      }
    }
    await this.persist();
    await this.runHost(this.room.round >= this.room.rounds);
  }

  buildPrompt(final){
    const names = this.room.players.map(p => p.name).join('، ');
    const dispText = (this.room.disposition.text || '').replace('{target}', this.room.disposition._target || '');
    const said = this.room.transcript.map(t => '[جولة ' + t.round + '] ' + t.name + ': «' + t.text + '»').join('\n') || '— لم يتكلّموا بعد —';
    const head = 'أنت «المحقق»، حاضرٌ في «' + this.room.scene.occ + '». أثناءها وقعت مصيبة: ' + this.room.scene.crime + '\n'
      + (this.room.scene.detail ? 'تفاصيل الحادثة كما وصلتك: ' + this.room.scene.detail : '')
      + '\nأنت تشكّ أنّ أحدَ الجالسين هو الفاعل، وتحقّق بنفسك على المائدة.'
      + '\nطبعك في هذا التحقيق: ' + dispText
      + '\nخيوطٌ همست بها الجلسة:\n- ' + this.room.clues[0] + '\n- ' + this.room.clues[1]
      + '\nالجالسون: ' + names + '.'
      + '\nما صرّح به كلُّ ضيفٍ عن مكانه وقتَ الحادثة (قد يكون بعضُها كذباً):\n'
      + this.room.players.map(p => '- ' + p.name + ': ' + (p.alibi || 'لم يُصرِّح بمكانه')).join('\n')
      + '\nأنت لا تعرف يقيناً من الفاعل؛ تستنتج من كلامهم وتناقضاتهم وارتباكهم. تتكلّم بالعربية الفصحى بإيجازٍ مهيب.'
      + '\n\nما قيل حتى الآن:\n' + said;
    const tail = !final
      ? 'ردَّ على المائدة برسالةٍ واحدةٍ موجزة (لا تتجاوز 55 كلمة): علّق على ما لفتك، اضغط على من بدا متلعثماً أو متناقضاً، واطرح في آخرها سؤالاً أو تحدّياً جديداً للجولة القادمة.\n'
        + 'ثم أعطِ تقديرَ شكّك السرّيّ: لكلِّ ضيفٍ رقمٌ من -3 إلى +3 (الموجبُ يعني ازدادت ريبتُك فيه).\n'
        + 'أعد ردّك بهذا الشكل حصراً:\n<مضيف>كلامك هنا</مضيف>\n<شك>{'
        + this.room.players.map(p => '"' + p.name + '":0').join(',') + '}</شك>'
      : 'انتهى التحقيق. حان وقتُ الحكم. تكلّم كلمةً أخيرةً موجزةً بليغة (لا تتجاوز 55 كلمة) تبني فيها قرارك، ثم اتّهم ضيفاً واحداً بأنّه الفاعل (اسمٌ واحدٌ من القائمة فقط)، وسبباً مختصراً.\n'
        + 'أعد ردّك بهذا الشكل حصراً:\n<مضيف>كلمتك الأخيرة هنا</مضيف>\n<تهمة>اسم المتّهم</تهمة>\n<تعليل>سببك في جملة</تعليل>';
    return head + '\n\n' + tail;
  }

  matchName(raw){
    const s = String(raw || '').trim();
    if (!s) return null;
    const exact = this.room.players.find(p => p.name === s);
    if (exact) return exact.name;
    const part = this.room.players.find(p => s.includes(p.name) || p.name.includes(s));
    return part ? part.name : null;
  }

  async askAI(prompt){
    const resp = await fetch(WL_AI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: WL_AI_MODEL, max_tokens: 1000, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!resp.ok) throw new Error('ai-' + resp.status);
    const data = await resp.json();
    const viaOR = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (viaOR) return viaOR;
    return (data.content || []).filter(b => b.text).map(b => b.text).join('\n');
  }

  // مضيف احتياطي بلا ذكاء: يمنع تعليق الوليمة لو تعطّل المزوّد
  fallbackHost(final){
    const sus = {};
    for (const p of this.room.players) {
      const last = [...this.room.transcript].reverse().find(t => t.name === p.name && t.round === this.room.round);
      const txt = last ? last.text : '';
      let v = 0;
      if (txt.length < 14) v += 1;
      if (txt.length > 80) v -= 1;
      if (Math.random() < 0.4) v += Math.random() < 0.5 ? 1 : -1;
      sus[p.name] = Math.max(-3, Math.min(3, v));
    }
    if (!final) return { says: 'صمتُ بعضِكم أبلغُ من كلامِ بعضِكم… أكمِلوا، فالمائدةُ طويلة.', sus };
    const top = [...this.room.players].sort((a, b) => (b.sus || 0) - (a.sus || 0))[0];
    return { says: 'قد سمعتُ ما يكفي.', accused: top.name, reason: 'أثقلُكم ريبةً في كلامه.' };
  }

  async runHost(final){
    if (this.room.thinking) return;
    this.room.thinking = true;
    this.room.phase = 'thinking';
    await this.persist();
    this.broadcastState();

    let out;
    try {
      const raw = await this.askAI(this.buildPrompt(final));
      const says = wlGrab(raw, 'مضيف') || String(raw).replace(/<[^>]+>/g, '').trim().slice(0, 400);
      if (!final) {
        out = { says, sus: wlSafeJSON(wlGrab(raw, 'شك')) || {} };
      } else {
        out = {
          says,
          accused: this.matchName(wlGrab(raw, 'تهمة')) || wlPick(this.room.players).name,
          reason: wlGrab(raw, 'تعليل') || 'حدسُ المحقّق.',
        };
      }
    } catch (e) {
      out = this.fallbackHost(final);
    }

    this.room.thinking = false;
    if (!final) {
      const deltas = {};
      for (const p of this.room.players) {
        const d = Number(out.sus && out.sus[p.name]) || 0;
        const capped = Math.max(-3, Math.min(3, d));
        p.sus = (p.sus || 0) + capped;
        deltas[p.name] = capped;
      }
      this.room.hostSays = out.says;
      this.room.lastSus = deltas;
      this.room.phase = 'beat';
      await this.persist();
      this.broadcastState();
    } else {
      const accused = out.accused;
      const culprit = this.room.players.find(p => p.role === 'culprit');
      const results = this.room.players.map(p => ({
        id: p.id, name: p.name, role: p.role,
        roleName: (WL_ROLES.find(r => r.key === p.role) || {}).t || '',
        target: p.target, enemy: p.enemy,
        won: this.didWin(p, accused, culprit ? culprit.name : null),
      }));
      this.room.verdict = { accused, reason: out.reason, says: out.says, culprit: culprit ? culprit.name : null, results };
      this.room.phase = 'over';
      await this.persist();
      this.broadcastState();
    }
  }

  didWin(p, accused, culpritName){
    const r = WL_ROLES.find(x => x.key === p.role) || {};
    switch (r.winType) {
      case 'complicit': return accused !== culpritName;
      case 'protect':   return accused !== p.target;
      case 'avenge':    return accused === p.enemy;
      case 'scapegoat': return accused === p.name;
      default:          return accused !== p.name;
    }
  }

  async nextRound(){
    this.room.round++;
    this.room.hostSays = ''; this.room.lastSus = {};
    this.room.players.forEach(p => { p.submitted = false; p.statement = ''; });
    this.room.phase = 'writing';
    await this.persist();
    this.broadcastState();
  }
}

// تفعيل الخنق والتنظيف واستعادة المقعد على كل الغرف
applyRoomCommon(MafiaRoom);
applyRoomCommon(GotRoom);
applyRoomCommon(MawwihRoom);
applyRoomCommon(FatinRoom);
applyRoomCommon(WalimaRoom);

// حدّ إنشاء الغرف لكل IP — يمنع تفريخ غرف بلا نهاية
const CREATE_LIMIT = 8;              // غرف في الساعة لكل IP
const CREATE_WINDOW_MS = 60 * 60 * 1000;
const createHits = new Map();        // ip -> {n, t}

// العميل على IPv6 يملك /64 كاملة (٢^٦٤ عنوانًا)، فالحدّ على العنوان
// الكامل بلا معنى — يبدّل العنوان ويكمل. نحدّ على البادئة بدلها.
function ipKey(ip) {
  if (!ip) return '';
  if (!ip.includes(':')) return ip;
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = (tail === undefined || tail === '') ? [] : tail.split(':');
  const fill = new Array(Math.max(0, 8 - h.length - t.length)).fill('0');
  return [...h, ...fill, ...t]
    .map(x => (x || '0').padStart(4, '0'))
    .slice(0, 4).join(':') + '::/64';
}

// فتح الاتصالات: مع حارس وجود الغرفة صار الرمز الغلط يُرفض، لكن كل
// محاولة تُوقظ Durable Object. نخنق المحاولات نفسها حتى ما يصير مسح
// الرموز بالتخمين رخيصًا.
const WS_LIMIT = 60;                 // اتصال في الدقيقة لكل بادئة
const WS_WINDOW_MS = 60 * 1000;
const wsHits = new Map();

function allowSocket(ip) {
  const key = ipKey(ip);
  if (!key) return true;
  const now = Date.now();
  const r = wsHits.get(key) || { n: 0, t: now };
  if (now - r.t > WS_WINDOW_MS) { r.n = 0; r.t = now; }
  r.n++;
  wsHits.set(key, r);
  if (wsHits.size > 5000) {
    for (const [k, v] of wsHits) if (now - v.t > WS_WINDOW_MS) wsHits.delete(k);
    while (wsHits.size > 5000) wsHits.delete(wsHits.keys().next().value);
  }
  return r.n <= WS_LIMIT;
}


function allowCreate(ip) {
  if (!ip) return true;
  const now = Date.now();
  const r = createHits.get(ip) || { n: 0, t: now };
  if (now - r.t > CREATE_WINDOW_MS) { r.n = 0; r.t = now; }
  r.n++;
  createHits.set(ip, r);
  if (createHits.size > 5000) createHits.clear();   // سقف ذاكرة
  return r.n <= CREATE_LIMIT;
}

// ══════════════════════ داقش أونلاين ══════════════════════
/* لعبة ورق خليجية: مزاد جولة واحدة، ثم الموزّع يعرض تقسيم القدر،
   والباقون يصوّتون. رضوا كلهم = التقسيم ماشي بلا كشف. رفض واحد = كشف
   وأقوى يد تاخذ.

   كل شيء حسّاس في الخادم: الخلط، التوزيع، تقييم اليد، صحة كل قرار.
   العميل ما يستلم إلا كروته هو. */

const DQ_RANKS = [1, 2, 3, 4, 5, 6, 7]; // ٧ ٨ ٩ ولد بنت شايب اكة
const DQ_CATS = { 5: 'رباعي', 4: 'ثلاثي', 3: 'مزدوجين', 2: 'مزدوج', 1: 'مكسّر' };
const DQ_MIN_PLAYERS = 3;
const DQ_MAX_PLAYERS = 6;

// مهلة كل قرار (ثانية) — قابلة للضبط من المضيف
const DQ_TURN_MS_DEFAULT = 25000;
const DQ_REVEAL_MS = 30000;
// كم دور متتالٍ ينتهي وقته قبل ما يُقعد اللاعب على الاحتياط
const DQ_MAX_AUTO = 3;
// أهداف الفوز المسموحة (صفر = بدون هدف)
const DQ_TARGETS = [0, 100000, 250000, 500000, 1000000];

// ── عشوائية آمنة: crypto لا Math.random ──
// Math.random في V8 قابل للتنبؤ من مخرجات سابقة، وهنا يعني توقّع الكروت.
function dqRandInt(n) {
  const limit = Math.floor(0xFFFFFFFF / n) * n;
  const buf = new Uint32Array(1);
  let x;
  do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
  return x % n;
}

function dqShuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = dqRandInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function dqNewDeck() {
  const d = [];
  for (const v of DQ_RANKS) for (let s = 0; s < 4; s++) d.push({ v, s });
  return dqShuffle(d);
}

// تقييم اليد: نفس منطق النسخة المحلية بالضبط
function dqEvaluate(cards) {
  const m = {};
  cards.forEach(c => { m[c.v] = (m[c.v] || 0) + 1; });
  const g = Object.entries(m)
    .map(([v, n]) => ({ v: +v, n }))
    .sort((a, b) => b.n - a.n || b.v - a.v);
  const sh = g.map(x => x.n).join('');
  const cat = sh === '4' ? 5 : sh === '31' ? 4 : sh === '22' ? 3 : sh === '211' ? 2 : 1;
  return { cat, name: DQ_CATS[cat], key: [cat, ...g.map(x => x.v)] };
}

function dqCmp(a, b) {
  for (let i = 0; i < 5; i++) {
    const x = a.key[i] || 0, y = b.key[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

const sanitizeDaqashConfig = (raw) => {
  const r = raw || {};
  const start = Number(r.start);
  const min = Number(r.min);
  const turn = Number(r.turnSec);
  return {
    start: Number.isInteger(start) ? Math.min(Math.max(start, 10000), 1000000) : 50000,
    min: Number.isInteger(min) ? Math.min(Math.max(min, 1000), 50000) : 5000,
    fold: r.fold === undefined ? true : !!r.fold,
    guar: !!r.guar,
    keepAll: r.keepAll === undefined ? true : !!r.keepAll,
    // القدور الجانبية: تمنع استغلال «قلّل رصيدك واكسب القدر كامل»
    sidepot: r.sidepot === undefined ? true : !!r.sidepot,
    turnSec: Number.isInteger(turn) ? Math.min(Math.max(turn, 15), 60) : 25,
    // الفوز عند رصيد معيّن — صفر يعني اللعب مستمر حتى ما يبقى إلا واحد
    target: DQ_TARGETS.includes(Number(r.target)) ? Number(r.target) : 0,
    // كشف أوراق من بقي في اليد عند نهايتها — حتى لو رضوا كلهم بالتوزيع
    openCards: r.openCards === undefined ? true : !!r.openCards,
  };
};

export class DaqashRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map();
    this.timer = null;
    this.state.blockConcurrencyWhile(async () => {
      this.room = (await this.state.storage.get('room')) || {
        code: null, hostId: null, phase: 'lobby',
        cfg: sanitizeDaqashConfig({}),
        players: [],
        dealerIdx: 0,
        handNo: 0,
        hand: null,
        lastSeen: Date.now(),
      };
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/ws')) return this.handleWebSocket(request);
    if (url.pathname.endsWith('/create')) return this.handleCreate(request);
    return new Response('غير موجود', { status: 404 });
  }

  async persist() {
    await this.touchRoom();
    await this.state.storage.put('room', this.room);
  }

  findPlayer(id) { return this.room.players.find(p => p.id === id) || null; }
  idxOf(id) { return this.room.players.findIndex(p => p.id === id); }

  async handleCreate(request) {
    let body;
    try { body = await request.json(); } catch { return new Response('bad-json', { status: 400 }); }
    const { name, roomCode } = body || {};
    if (this.room.code && this.room.players.length && this.room.phase !== 'over') {
      return new Response('room-exists', { status: 409 });
    }
    this.room.code = roomCode;
    this.room.phase = 'lobby';
    this.room.cfg = sanitizeDaqashConfig(body && body.cfg);
    const hostId = crypto.randomUUID();
    const hostToken = newSeatToken();
    this.room.hostId = hostId;
    this.room.players = [this.newSeat(hostId, name, hostToken)];
    this.room.dealerIdx = 0;
    this.room.handNo = 0;
    this.room.hand = null;
    await this.persist();
    return Response.json({ roomCode: this.room.code, playerId: hostId, seatToken: hostToken });
  }

  // اسم مكرر يجعل التصويت والتوزيع غامضين: من «سعد» تقصد؟
  uniqueName(raw, exceptId) {
    const base = cleanName(raw) || 'لاعب';
    const taken = new Set(this.room.players
      .filter(p => p.id !== exceptId)
      .map(p => p.name));
    if (!taken.has(base)) return base;
    const AR = n => String(n).replace(/[0-9]/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
    for (let n = 2; n <= 20; n++) {
      // نقصّ الأصل عند الحاجة كي لا يتجاوز الاسم حدّه
      const suffix = ' ' + AR(n);
      const cand = (base.slice(0, 14 - suffix.length) + suffix).trim();
      if (!taken.has(cand)) return cand;
    }
    return base.slice(0, 10) + ' ' + Math.floor(Math.random() * 900 + 100);
  }

  newSeat(id, name, token) {
    return {
      id,
      name: this.uniqueName(name),
      seatToken: token || newSeatToken(),
      connected: false,
      chips: this.room.cfg.start,
      out: false,       // خسر كل رصيده
      sitting: false,   // مقعد احتياط (انقطع أو نام)
      autoMiss: 0,
      kicked: false,
      av: null,
    };
  }

  // ═══════════ الاتصال ═══════════
  async handleWebSocket(request) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('يتطلب WebSocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const token = url.searchParams.get('token');
    const name = url.searchParams.get('name');

    // التوكن السري وحده يفتح مقعدًا قائمًا. المعرّف مُذاع للجميع فلا يثبت شيئًا.
    let player = this.seatByToken(token);
    if (player && player.kicked) player = null;     // مقعد مطرود لا يُفتح

    if (player) {
      const stale = this.sockets.get(player.id);
      if (stale && stale !== server) { try { stale.close(); } catch {} }
      this.sockets.delete(player.id);
      player.connected = true;
      /* رجع من انقطاع: يرجع لنفس اليد بنفس كروته. أما من لم يُوزَّع له
         هذي اليد فيبقى احتياطًا — وإلا ظهر جالسًا على الطاولة بلا كروت،
         وهذا سبب «الأوراق اختفت». يدخل تلقائيًا في اليد الجاية. */
      const _h = this.room.hand;
      if (!_h || _h.seats.includes(this.idxOf(player.id))) player.sitting = false;
      player.autoMiss = 0;
    } else {
      // ع-١ · رمز لم تُنشأ له غرفة: لا نُنشئها من اتصال WebSocket
      if (!this.room.code) {
        server.send(JSON.stringify({ type: 'error', message: 'ما فيه غرفة بهذا الرمز' }));
        server.close();
        return new Response(null, { status: 101, webSocket: client });
      }
      if (this.room.phase !== 'lobby' && this.room.phase !== 'over') {
        server.send(JSON.stringify({ type: 'error', message: 'اللعبة بدأت — انتظر الجولة الجاية' }));
        server.close();
        return new Response(null, { status: 101, webSocket: client });
      }
      if (this.room.players.length >= DQ_MAX_PLAYERS) {
        server.send(JSON.stringify({ type: 'error', message: 'الغرفة ممتلئة' }));
        server.close();
        return new Response(null, { status: 101, webSocket: client });
      }
      player = this.newSeat(crypto.randomUUID(), name, newSeatToken());
      player.connected = true;
      this.room.players.push(player);
    }

    this.sockets.set(player.id, server);
    server.addEventListener('message', evt => this.onMessage(player.id, evt));
    server.addEventListener('close', () => this.onClose(player.id));

    await this.persist();
    this.sendPrivate(player.id, {
      type: 'welcome',
      playerId: player.id,
      roomCode: this.room.code,
      seatToken: player.seatToken,
    });
    this.broadcastState();
    return new Response(null, { status: 101, webSocket: client });
  }

  async onClose(playerId) {
    const p = this.findPlayer(playerId);
    if (p) p.connected = false;
    this.sockets.delete(playerId);
    this.migrateHostIfNeeded();
    await this.persist();
    this.broadcastState();
  }

  // بدون هذا تتجمّد الغرفة: لا أحد يقدر يبدأ أو يطرد
  migrateHostIfNeeded() {
    const host = this.findPlayer(this.room.hostId);
    if (host && host.connected && !host.kicked) return false;
    // أول لاعب متصل بترتيب الجلوس — أقدمهم في الغرفة
    const next = this.room.players.find(p => p.connected && !p.kicked);
    if (!next || next.id === this.room.hostId) return false;
    this.room.hostId = next.id;
    this.log(next.name + ' صار المضيف');
    return true;
  }

  send(playerId, obj) {
    const ws = this.sockets.get(playerId);
    if (!ws) return;
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
  sendPrivate(playerId, obj) { this.send(playerId, obj); }

  broadcastState() {
    for (const id of this.sockets.keys()) this.send(id, this.stateFor(id));
  }

  // ═══════════ الحالة المنقّاة ═══════════
  /* هذي الدالة هي جدار الأمان الأساسي: العميل ما يشوف إلا كروته،
     وأصوات الباقين تُخفى حتى يصوّت الجميع. */
  stateFor(viewerId) {
    const r = this.room;
    const h = r.hand;
    const vIdx = this.idxOf(viewerId);
    const revealAll = !!(h && h.revealed);

    const players = r.players.map((p, i) => {
      const base = {
        id: p.id, name: p.name, chips: p.chips, out: p.out,
        sitting: p.sitting, connected: p.connected, av: p.av,
        isHost: p.id === r.hostId,
      };
      if (!h) return base;
      const inHand = h.seats.includes(i);
      base.inHand = inHand;
      base.folded = !!h.folded[i];
      base.bet = h.bets[i] || 0;
      base.isDealer = i === h.dealerIdx;
      base.nCards = inHand && !h.folded[i] ? 4 : 0;
      // العرض يُذاع للجميع بمجرد ما يقدّمه الموزّع — هذي طبيعة اللعبة
      base.offer = (h.phase === 'vote' || h.phase === 'reveal') ? (h.offer[i] || 0) : 0;
      // الأصوات مخفية حتى يكتمل التصويت: لو ظهرت تباعًا صار آخر مصوّت
      // يقرأ قرار الباقين قبل قراره
      base.voted = h.votes[i] !== null && h.votes[i] !== undefined;
      base.vote = h.votesOpen ? (h.votes[i] ?? null) : null;
      base.safe = (h.safe || []).includes(i);
      base.rebel = (h.rebels || []).includes(i);
      base.ready = (h.ready || []).includes(i);
      base.won = (h.winners || []).includes(i);
      /* الربح صافيًا: كان يُعرض إجماليًا فيرى اللاعب «+٥٠٠٠» ورصيده
         ما تحرّك — لأن الخمسة آلاف هي رهانه نفسه راجعًا من القدر */
      base.gain = h.gains ? ((h.gains[i] || 0) - (h.bets[i] || 0)) : 0;
      /* المبلغ اللي وصله فعلًا من القدر — الصافي وحده كان يخفي التوزيع:
         من أخذ ٥٠٠٠ وكان رهانه ٥٠٠٠ يشوف صفر وكأن ما أحد عطاه شي */
      base.took = h.gains ? (h.gains[i] || 0) : 0;

      const showCards = i === vIdx || (revealAll && (h.shown || []).includes(i));
      base.cards = showCards && inHand ? h.cards[i] : null;
      base.hand = (showCards && inHand && !h.folded[i]) ? h.evals[i].name : null;
      return base;
    })
      /* المطرود يبقى في المصفوفة الداخلية حتى اليد الجاية (الفهارس)،
         لكنه ما يُعرض — وإلا شاف المضيف الطرد وكأنه ما صار */
      .filter((_, i) => !r.players[i].kicked);

    const out = {
      type: 'state',
      phase: r.phase,
      code: r.code,
      cfg: r.cfg,
      hostId: r.hostId,
      you: viewerId,
      players,
      now: Date.now(),
    };

    if (h) {
      out.hand = {
        no: h.no,
        seq: h.seq,
        phase: h.phase,
        pot: h.pot,
        last: h.last,
        dealerId: r.players[h.dealerIdx] ? r.players[h.dealerIdx].id : null,
        turnId: h.phase === 'bet' && h.order[h.turn] !== undefined
          ? r.players[h.order[h.turn]].id : null,
        endsAt: h.endsAt,
        prize: h.prize || 0,
        log: h.log.slice(-6),
        title: h.title || '',
        votesOpen: !!h.votesOpen,
        agreed: !!h.agreed,
        rebels: (h.rebels || []).map(i => r.players[i] && r.players[i].name).filter(Boolean),
        nextDealerId: h.phase === 'reveal' && r.players[this.nextDealerIdx()]
          ? r.players[this.nextDealerIdx()].id : null,
        readyCount: (h.ready || []).length,
        readyNeeded: r.players.filter(p => p.connected && !p.out && !p.sitting).length,
        pendingVotes: h.phase === 'vote'
          ? this.others(h).filter(i => h.votes[i] === null).length : 0,
      };
      // ما يُرسل أبدًا: h.deck، وكروت الآخرين
    }
    return out;
  }

  // ═══════════ اللوبي ═══════════
  async onMessage(playerId, evt) {
    if (!this.allowMsg(playerId)) return;
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const p = this.findPlayer(playerId);
    if (!p) return;

    switch (msg.type) {
      case 'updateProfile':
        if (this.room.phase === 'lobby') {
          if (typeof msg.name === 'string' && msg.name.trim()) p.name = this.uniqueName(msg.name, p.id);
          if (typeof msg.av === 'string') p.av = cleanText(msg.av, 24);
          await this.persist(); this.broadcastState();
        }
        break;
      case 'updateSettings':
        if (playerId === this.room.hostId && this.room.phase === 'lobby') {
          this.room.cfg = sanitizeDaqashConfig(msg.cfg);
          this.room.players.forEach(x => { x.chips = this.room.cfg.start; });
          await this.persist(); this.broadcastState();
        }
        break;
      case 'kick':
        if (playerId === this.room.hostId) await this.kickPlayer(msg.targetId);
        break;
      case 'start':
        // 'over' كذلك: بدونها تبقى الغرفة ميتة بعد نهاية اللعبة
        if (playerId === this.room.hostId
          && (this.room.phase === 'lobby' || this.room.phase === 'over')) await this.startGame();
        break;
      case 'bet':      await this.actBet(playerId, msg); break;
      case 'fold':     await this.actFold(playerId, msg); break;
      case 'offer':    await this.actOffer(playerId, msg); break;
      case 'vote':     await this.actVote(playerId, msg); break;
      case 'nextHand':
        if (playerId === this.room.hostId) await this.nextHand();
        break;
      case 'ready': {
        if (p.kicked) break;
        // كان المضيف وحده يملك الانتقال؛ الآن تتقدّم اليد حين يجهز الجميع
        const h = this.room.hand;
        if (!h || h.phase !== 'reveal') break;
        const i = this.idxOf(playerId);
        if (i < 0 || h.ready.includes(i)) break;
        h.ready.push(i);
        const waiting = this.room.players
          .filter((p, k) => p.connected && !p.out && !p.sitting && !h.ready.includes(k));
        if (waiting.length === 0) await this.nextHand();
        else { await this.persist(); this.broadcastState(); }
        break;
      }
      case 'ping':
        this.send(playerId, this.stateFor(playerId));
        break;
    }
  }

  /* الطرد أثناء اللعب لا يمكن أن يحذف اللاعب فورًا: مصفوفات اليد
     (order/seats/cards/bets) كلها بالفهارس، وأي حذف يزيح الفهارس ويفسد
     اليد الجارية. لذا نُخرجه من اليد الآن، ونحذفه فعليًا عند اليد التالية. */
  async kickPlayer(targetId) {
    const i = this.idxOf(targetId);
    if (i < 0) return;
    const p = this.room.players[i];
    if (p.id === this.room.hostId) return;          // المضيف لا يطرد نفسه

    const ws = this.sockets.get(targetId);
    /* الإقفال فور الإرسال قد يبتلع الرسالة، فتظهر للمطرود «انقطع الاتصال»
       ويحاول العودة بدل شاشة الطرد. نمهله لحظة ثم نقفل. */
    if (ws) {
      try { ws.send(JSON.stringify({ type: 'kicked' })); } catch {}
      setTimeout(() => { try { ws.close(4003, 'kicked'); } catch {} }, 250);
    }
    this.sockets.delete(targetId);

    if (this.room.phase === 'lobby') {
      this.room.players.splice(i, 1);
      await this.persist();
      this.broadcastState();
      return;
    }

    // التوكن يُبطَل كي لا يعود بإعادة الاتصال
    p.kicked = true;
    p.connected = false;
    p.sitting = true;
    p.out = true;
    p.seatToken = 'kicked-' + newSeatToken();
    this.log(p.name + ' طُرد');

    const h = this.room.hand;
    if (h && h.seats.includes(i) && h.phase !== 'reveal') {
      if (!h.folded[i]) h.folded[i] = true;         // رهانه يبقى في القدر
      if (h.phase === 'bet' && h.order[h.turn] === i) {
        // كان الدور عليه: نتقدّم وإلا تجمّدت اليد
        h.turn++;
        this.bump();
        await this.advanceBetting();
      } else if (h.phase === 'offer' && h.dealerIdx === i) {
        // الموزّع طُرد: يوزَّع بالتساوي بدل انتظار من لن يعود
        const L = this.live(h);
        if (L.length) {
          h.dealerIdx = L[L.length - 1];
          const o = this.others(h), step = this.room.cfg.min;
          const each = o.length ? Math.floor(h.pot / o.length / step) * step : 0;
          const shares = {};
          o.forEach(k => { shares[this.room.players[k].id] = each; });
          await this.doOffer(shares);
        }
      } else if (h.phase === 'vote') {
        // صوته لم يعد متوقَّعًا: قد يكون هو آخر من ننتظره
        h.votes[i] = null;
        const pending = this.others(h).filter(x => h.votes[x] === null).length;
        if (pending === 0) await this.resolveVotes();
      }
    }
    if (h && h.ready) h.ready = h.ready.filter(x => x !== i);

    this.migrateHostIfNeeded();
    await this.persist();
    this.broadcastState();
    // بقاء لاعب واحد يعني نهاية الجولة
    if (this.room.hand && this.room.hand.phase === 'reveal') this.checkReady();
  }

  // تُستدعى بعد أي خروج: قد يكون الباقون جاهزين فعلًا
  checkReady() {
    const h = this.room.hand;
    if (!h || h.phase !== 'reveal') return;
    const waiting = this.room.players
      .filter((p, k) => p.connected && !p.out && !p.sitting && !h.ready.includes(k));
    if (waiting.length === 0) this.nextHand();
  }

  async startGame() {
    const seated = this.room.players.filter(p => p.connected);
    if (seated.length < DQ_MIN_PLAYERS) {
      this.send(this.room.hostId, { type: 'error', message: 'محتاج ٣ لاعبين على الأقل' });
      return;
    }
    this.room.phase = 'playing';
    this.room.players.forEach(p => {
      p.chips = this.room.cfg.start;
      p.out = false; p.sitting = false; p.autoMiss = 0;
    });
    this.room.handNo = 0;
    this.room.dealerIdx = 0;
    await this.newHand();
  }

  // ═══════════ اليد ═══════════
  activeSeats() {
    // من يستحق الجلوس على الطاولة هذي اليد
    return this.room.players
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => !p.out && !p.sitting && p.chips > 0)
      .map(({ i }) => i);
  }

  async newHand() {
    this.clearPhaseTimer();
    const r = this.room;

    // الآن فقط يُحذف المطرودون: لا توجد يد جارية لتفسد فهارسها
    if (r.players.some(p => p.kicked)) {
      const dealerId = r.players[r.dealerIdx] ? r.players[r.dealerIdx].id : null;
      r.players = r.players.filter(p => !p.kicked);
      // الفهرس بعد الحذف قد يشير لمقعد آخر أو خارج المصفوفة
      const d = r.players.findIndex(p => p.id === dealerId);
      r.dealerIdx = d >= 0 ? d : 0;
      this.migrateHostIfNeeded();
    }

    r.players.forEach(p => { if (p.chips <= 0) p.out = true; });

    // بلغ الهدف: اللعبة تنتهي هنا بدل ما تستمر بلا نهاية
    if (r.cfg.target > 0 && r.handNo > 0) {
      const champ = r.players.reduce((a, b) => (a && a.chips >= b.chips ? a : b), null);
      if (champ && champ.chips >= r.cfg.target) {
        r.phase = 'over';
        r.hand = null;
        await this.persist();
        this.broadcastState();
        return;
      }
    }

    const seats = this.activeSeats();

    if (seats.length < 2) {
      r.phase = 'over';
      r.hand = null;
      await this.persist();
      this.broadcastState();
      return;
    }

    // الموزّع: السابق في الترتيب (عكس عقارب الساعة) مع تخطي الخارجين
    let d = r.dealerIdx;
    const n = r.players.length;
    for (let k = 1; k <= n; k++) {
      const cand = (d - k + n * 2) % n;
      if (seats.includes(cand)) { d = cand; break; }
    }
    r.dealerIdx = d;

    const deck = dqNewDeck();
    const cards = r.players.map(() => null);
    const evals = r.players.map(() => null);
    for (const i of seats) {
      const c = [];
      for (let k = 0; k < 4; k++) c.push(deck.pop());
      cards[i] = c;
      evals[i] = dqEvaluate(c);
    }

    // ترتيب المزاد: يبدأ بعد الموزّع، والموزّع آخر واحد
    const order = [];
    for (let k = 1; k <= n; k++) {
      const i = (d + k) % n;
      if (seats.includes(i)) order.push(i);
    }

    r.handNo++;
    r.hand = {
      no: r.handNo,
      seq: 1,
      seats,
      dealerIdx: d,
      order,
      turn: 0,
      phase: 'bet',
      pot: 0,
      last: 0,
      bets: r.players.map(() => 0),
      folded: r.players.map(() => false),
      cards, evals,
      offer: r.players.map(() => 0),
      votes: r.players.map(() => null),
      votesOpen: false,
      safe: [], winners: [], shown: [], gains: r.players.map(() => 0),
      rebels: [], agreed: false, ready: [],
      prize: 0, revealed: false,
      endsAt: 0,
      log: [],
      title: '',
    };
    this.log('الموزّع: ' + r.players[d].name);
    await this.persist();
    this.armTurn();
    this.broadcastState();
  }

  log(t) {
    const h = this.room.hand;
    if (h) h.log.push(cleanText(t, 120));
  }

  // الدور ينتقل عكس عقارب الساعة، وهذا غير بديهي — نحسب التالي لنعرضه
  nextDealerIdx() {
    const seats = this.activeSeats();
    const n = this.room.players.length;
    const d = this.room.dealerIdx;
    for (let k = 1; k <= n; k++) {
      const cand = (d - k + n * 2) % n;
      if (seats.includes(cand)) return cand;
    }
    return d;
  }

  others(h) {
    return h.order.filter(i => !h.folded[i] && i !== h.dealerIdx);
  }
  live(h) {
    return h.order.filter(i => !h.folded[i]);
  }

  // ═══════════ المؤقّت ═══════════
  /* الـ DO يبقى حيًّا ما دامت هناك اتصالات مفتوحة، فـ setTimeout كافٍ.
     ومع ذلك نتحقق من endsAt عند كل رسالة، حتى لو نام المؤقّت. */
  setPhaseTimer(ms, fn) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = null;
      try { await fn(); } catch (e) {}
    }, ms);
  }
  clearPhaseTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }

  armTurn() {
    const h = this.room.hand;
    if (!h) return;
    const ms = this.room.cfg.turnSec * 1000;
    h.endsAt = Date.now() + ms;
    const snapNo = h.no, snapSeq = h.seq;
    this.setPhaseTimer(ms + 400, () => this.onTimeout(snapNo, snapSeq));
  }

  async onTimeout(handNo, seq) {
    const h = this.room.hand;
    // قفل السباق نفسه يحمي المؤقّت: لو تحرّك الدور، هذا المؤقّت ميّت
    if (!h || h.no !== handNo || h.seq !== seq) return;
    if (Date.now() < h.endsAt - 500) return;

    if (h.phase === 'bet') {
      const i = h.order[h.turn];
      if (i === undefined) return;
      const p = this.room.players[i];
      p.autoMiss++;
      // انتهى وقته: ينسحب لو الانسحاب متاح وفيه رهان قائم،
      // وإلا يفتح بالحد الأدنى (أو بكل رصيده لو أقل)
      if (this.room.cfg.fold && h.last > 0) {
        this.log(p.name + ' انتهى وقته — انسحب تلقائيًا');
        await this.doFold(i);
      } else {
        const amt = Math.min(Math.max(h.last, this.room.cfg.min), p.chips);
        this.log(p.name + ' انتهى وقته — نزّل الحد الأدنى');
        await this.doBet(i, amt);
      }
    } else if (h.phase === 'offer') {
      const p = this.room.players[h.dealerIdx];
      p.autoMiss++;
      const o = this.others(h);
      const step = this.room.cfg.min;
      const each = o.length ? Math.floor(h.pot / o.length / step) * step : 0;
      const shares = {};
      o.forEach(i => { shares[this.room.players[i].id] = each; });
      this.log(p.name + ' انتهى وقته — وُزّع بالتساوي');
      await this.doOffer(shares);
    } else if (h.phase === 'vote') {
      // انتهى الوقت: الصامتون يُحسبون «راضين» — أقل ضررًا من إجبار كشف
      const o = this.others(h);
      o.forEach(i => {
        if (h.votes[i] === null) {
          h.votes[i] = 'yes';
          this.room.players[i].autoMiss++;
        }
      });
      this.log('انتهى وقت التصويت — الصامتون رضوا');
      await this.resolveVotes();
    } else if (h.phase === 'reveal') {
      await this.nextHand();
    }
    this.parkIdlePlayers();
    await this.persist();
    this.broadcastState();
  }

  // من انتهى وقته ٣ مرات متتالية يُقعَد على الاحتياط بدل تجميد الطاولة
  parkIdlePlayers() {
    this.room.players.forEach(p => {
      if (p.autoMiss >= DQ_MAX_AUTO && !p.sitting) {
        p.sitting = true;
        this.log(p.name + ' قعد على الاحتياط');
      }
    });
  }

  // ═══════════ قفل السباق ═══════════
  /* كل طلب يحمل رقم اليد ورقم الدور. الـ Durable Object أصلاً وحيد الخيط،
     فما فيه تزامن حقيقي — لكن الضغطتين المتتاليتين أو الطلب المتأخر
     من شبكة بطيئة يُرفضان هنا. */
  gate(playerId, msg, phase) {
    const h = this.room.hand;
    if (!h || this.room.phase !== 'playing') return null;
    if (h.phase !== phase) return null;
    if (msg.handNo !== h.no || msg.seq !== h.seq) {
      this.send(playerId, { type: 'stale' });
      return null;
    }
    const i = this.idxOf(playerId);
    if (i < 0 || !h.seats.includes(i)) return null;
    return i;
  }

  bump() {
    const h = this.room.hand;
    if (h) h.seq++;
  }

  // ═══════════ المزاد ═══════════
  async actBet(playerId, msg) {
    const h = this.room.hand;
    const i = this.gate(playerId, msg, 'bet');
    if (i === null) return;
    if (h.order[h.turn] !== i) return;            // مو دوره
    if (Date.now() > h.endsAt + 1500) return;     // انتهى وقته فعليًا

    const p = this.room.players[i];
    let amt = Number(msg.amount);
    if (!Number.isInteger(amt) || amt < 0) return;
    if (amt > p.chips) return;                    // ما يقدر يراهن بأكثر من رصيده

    const step = this.room.cfg.min;
    const allIn = amt === p.chips;

    if (h.last === 0) {
      // أول واحد: لازم الحد الأدنى ومن مضاعفاته، إلا لو كل رصيده أقل
      if (!allIn && (amt < step || amt % step !== 0)) return;
      if (allIn && amt < step && p.chips >= step) return;
    } else {
      // مجاراة تمامًا، أو زيادة بمضاعفات الوحدة، أو كل الرصيد
      const isCall = amt === h.last;
      const isRaise = amt > h.last && (amt - h.last) % step === 0;
      if (!isCall && !isRaise && !allIn) return;
    }
    p.autoMiss = 0;
    await this.doBet(i, amt);
    await this.persist();
    this.broadcastState();
  }

  async doBet(i, amt) {
    const h = this.room.hand;
    const p = this.room.players[i];
    amt = Math.min(amt, p.chips);
    const before = h.last;
    p.chips -= amt;
    h.bets[i] = amt;
    h.pot += amt;
    h.last = Math.max(h.last, amt);
    this.log(p.name + (before === 0 ? ' فتح بـ ' : amt > before ? ' زاد إلى ' : ' جارى ')
      + amt + (p.chips === 0 ? ' — كل رصيده' : ''));
    h.turn++;
    this.bump();
    await this.advanceBetting();
  }

  async actFold(playerId, msg) {
    const h = this.room.hand;
    const i = this.gate(playerId, msg, 'bet');
    if (i === null) return;
    if (h.order[h.turn] !== i) return;
    if (!this.room.cfg.fold) return;                 // الانسحاب مطفي أصلًا
    if (Date.now() > h.endsAt + 1500) return;
    this.room.players[i].autoMiss = 0;
    await this.doFold(i);
    await this.persist();
    this.broadcastState();
  }

  async doFold(i) {
    const h = this.room.hand;
    const p = this.room.players[i];
    h.folded[i] = true;
    this.log(p.name + ' انسحب' + (h.bets[i] > 0 ? ' وخسر ' + h.bets[i] : ''));
    h.turn++;
    this.bump();
    await this.advanceBetting();
  }

  async advanceBetting() {
    const h = this.room.hand;
    /* مقعد قد يُطوى خارج دوره (الطرد يطوي المطرود فورًا)، والدور كان
       ينزل عليه فتقف الطاولة تنتظر لاعبًا لن يلعب حتى ينتهي مؤقّته.
       نتخطّى المطويين، وإن بقي حيٌّ واحد ننهي المزاد فورًا. */
    while (h.turn < h.order.length && h.folded[h.order[h.turn]]) h.turn++;
    if (this.live(h).length <= 1) h.turn = h.order.length;
    if (h.turn < h.order.length) { this.armTurn(); return; }
    await this.startOffer();
  }

  // ═══════════ التوزيع ═══════════
  async startOffer() {
    const h = this.room.hand;
    const L = this.live(h);

    if (L.length === 0) {
      // ما يُفترض يوصلها (أول لاعب ما عنده انسحاب) — لكن لو صار،
      // القدر يُرجَّع لأصحابه بدل ما يختفي
      L.length === 0 && h.order.forEach(i => { this.room.players[i].chips += h.bets[i]; });
      h.phase = 'reveal'; h.revealed = false;
      h.title = 'كلهم انسحبوا — رُدّت الرهانات';
      this.bump(); this.armRevealTimer();
      return;
    }
    if (L.length === 1) {
      const w = L[0];
      this.room.players[w].chips += h.pot;
      h.gains[w] = h.pot;
      h.winners = [w];
      h.prize = h.pot;
      h.phase = 'reveal'; h.revealed = true; h.shown = L.slice();
      h.title = this.room.players[w].name + ' بقي لحاله وأخذ القدر — ' + h.pot;
      this.bump(); this.armRevealTimer();
      return;
    }
    // الموزّع انسحب: تنتقل المهمة لآخر لاعب حي، ويُعاد حساب others تلقائيًا
    if (h.folded[h.dealerIdx]) {
      h.dealerIdx = L[L.length - 1];
      this.log('الموزّع انسحب — انتقل التوزيع لـ ' + this.room.players[h.dealerIdx].name);
    }
    h.phase = 'offer';
    this.bump();
    this.armTurn();
  }

  async actOffer(playerId, msg) {
    const h = this.room.hand;
    const i = this.gate(playerId, msg, 'offer');
    if (i === null) return;
    if (i !== h.dealerIdx) return;               // الموزّع وحده يوزّع
    if (Date.now() > h.endsAt + 1500) return;
    if (!msg.shares || typeof msg.shares !== 'object') return;
    this.room.players[i].autoMiss = 0;
    await this.doOffer(msg.shares);
    await this.persist();
    this.broadcastState();
  }

  async doOffer(shares) {
    const h = this.room.hand;
    const cfg = this.room.cfg;
    const step = cfg.min;
    const o = this.others(h);

    h.offer = this.room.players.map(() => 0);
    let given = 0;
    for (const i of o) {
      const id = this.room.players[i].id;
      let v = Number(shares[id]);
      if (!Number.isInteger(v) || v < 0) v = 0;
      v = Math.floor(v / step) * step;           // مضاعفات الوحدة فقط
      v = Math.min(v, h.pot);
      h.offer[i] = v;
      given += v;
    }
    // مجموع الحصص لا يتجاوز القدر أبدًا — نقصّ من الأكبر
    while (given > h.pot && o.length) {
      const j = o.reduce((a, b) => (h.offer[a] >= h.offer[b] ? a : b));
      const cut = Math.min(step, h.offer[j]);
      if (cut === 0) break;
      h.offer[j] -= cut;
      given -= cut;
    }
    // «ما راح أوزّع» ممنوع لو keepAll مطفي: أرضية إلزامية لكل واحد
    if (!cfg.keepAll && o.length) {
      const floor = Math.min(step, Math.floor(h.pot / o.length / step) * step);
      o.forEach(i => { h.offer[i] = Math.max(h.offer[i], floor); });
      given = o.reduce((a, i) => a + h.offer[i], 0);
      while (given > h.pot) {
        const j = o.reduce((a, b) => (h.offer[a] >= h.offer[b] ? a : b));
        h.offer[j] = Math.max(0, h.offer[j] - step);
        given = o.reduce((a, i) => a + h.offer[i], 0);
      }
    }
    h.offer[h.dealerIdx] = h.pot - given;

    h.phase = 'vote';
    h.votes = this.room.players.map(() => null);
    h.votesOpen = false;
    this.log(this.room.players[h.dealerIdx].name + ' عرض التوزيع');
    this.bump();
    this.armTurn();
  }

  // ═══════════ التصويت ═══════════
  async actVote(playerId, msg) {
    const h = this.room.hand;
    const i = this.gate(playerId, msg, 'vote');
    if (i === null) return;
    if (i === h.dealerIdx) return;               // الموزّع ما يصوّت
    if (h.folded[i]) return;                     // المنسحب ما يصوّت
    if (h.votes[i] !== null) return;             // صوت واحد لكل لاعب
    if (Date.now() > h.endsAt + 1500) return;
    h.votes[i] = msg.ok ? 'yes' : 'no';
    this.room.players[i].autoMiss = 0;
    // ملاحظة: ما نستدعي bump() هنا — التصويت متزامن لا تسلسلي،
    // وبقاء seq ثابتًا يسمح للبقية بإرسال أصواتهم
    const pending = this.others(h).filter(x => h.votes[x] === null).length;
    if (pending === 0) {
      await this.resolveVotes();
    } else {
      await this.persist();
      this.broadcastState();
    }
  }

  async resolveVotes() {
    const h = this.room.hand;
    if (h.phase !== 'vote') return;
    this.clearPhaseTimer();
    const cfg = this.room.cfg;
    const o = this.others(h);
    o.forEach(i => { if (h.votes[i] === null) h.votes[i] = 'yes'; });
    h.votesOpen = true;

    const rebels = o.filter(i => h.votes[i] === 'no');
    h.rebels = rebels;
    h.agreed = rebels.length === 0;

    if (rebels.length === 0) {
      // رضوا كلهم: التقسيم ماشي بلا كشف
      h.offer[h.dealerIdx] = Math.max(0, h.pot - o.reduce((a, i) => a + h.offer[i], 0));
      this.live(h).forEach(i => {
        this.room.players[i].chips += h.offer[i];
        h.gains[i] = h.offer[i];
      });
      h.winners = this.live(h).filter(i => h.offer[i] > 0);
      // الأوراق تنكشف بعد إقفال التوزيع — القرار انتهى فما تتأثر اللعبة،
      // واللاعبون كانوا يشتكون إنهم ما يشوفون على وش راضوا
      h.revealed = !!cfg.openCards;
      h.shown = cfg.openCards ? this.live(h) : [];
      h.phase = 'reveal';
      h.title = 'رضوا كلهم — ' + this.room.players[h.dealerIdx].name
        + ' أخذ ' + h.offer[h.dealerIdx] + ' بلا كشف';
      this.bump();
      this.armRevealTimer();
      await this.persist();
      this.broadcastState();
      return;
    }

    // فيه رافض: كشف
    h.safe = [];
    let inHand = this.live(h);
    if (cfg.guar) {
      // من رضي وحصته أكبر من صفر يقبضها ويخرج من الكشف
      h.safe = o.filter(i => h.votes[i] === 'yes' && h.offer[i] > 0);
      h.safe.forEach(i => {
        this.room.players[i].chips += h.offer[i];
        h.gains[i] = h.offer[i];
      });
      inHand = inHand.filter(i => !h.safe.includes(i));
    }
    h.prize = h.pot - h.safe.reduce((a, i) => a + h.offer[i], 0);
    h.shown = inHand.slice();
    h.revealed = true;

    if (inHand.length === 1) {
      const w = inHand[0];
      this.room.players[w].chips += h.prize;
      h.gains[w] += h.prize;
      h.winners = [w];
      h.title = this.room.players[w].name + ' بقي لحاله في الكشف — ' + h.prize;
    } else {
      this.payShowdown(inHand);
    }
    h.phase = 'reveal';
    this.bump();
    this.armRevealTimer();
    await this.persist();
    this.broadcastState();
  }

  /* دفع الكشف مع القدور الجانبية.
     بدونها: لاعب دخل بـ ٥٠٠٠ يكسب قدرًا فيه ٢٠٠٠٠٠ — يعني «قلّل رصيدك
     واربح مجانًا» تصير الاستراتيجية المثلى أونلاين.
     مع القدور: كل لاعب يكسب فقط بقدر ما غطّى من رهان كل خصم.
     والباقي ينزل لأقوى يد تالية غطّت أكثر. */
  payShowdown(inHand) {
    const h = this.room.hand;
    const cfg = this.room.cfg;
    const P = this.room.players;

    if (!cfg.sidepot) {
      let best = h.evals[inHand[0]];
      inHand.forEach(i => { if (dqCmp(h.evals[i], best) > 0) best = h.evals[i]; });
      const winners = inHand.filter(i => dqCmp(h.evals[i], best) === 0);
      const share = Math.floor(h.prize / winners.length);
      let rem = h.prize - share * winners.length;   // ما يضيع ولا ريال
      winners.forEach((i, k) => {
        const add = share + (k < rem ? 1 : 0);
        P[i].chips += add; h.gains[i] += add;
      });
      h.winners = winners;
      h.title = winners.map(i => P[i].name).join(' و ') + ' أقوى يد — ' + h.prize;
      return;
    }

    // الطبقات: مبنية على مساهمة كل مشارك بالكشف
    const contrib = {};
    inHand.forEach(i => { contrib[i] = h.bets[i]; });

    const levels = [...new Set(inHand.map(i => contrib[i]))].sort((a, b) => a - b);
    const winners = new Set();
    let prev = 0;
    let paid = 0;

    for (const lv of levels) {
      if (paid >= h.prize) break;
      const eligible = inHand.filter(i => contrib[i] >= lv);
      // في وضع «الضمان» تخرج حصص الراضين من القدر قبل الكشف، فمجموع
      // الرهانات قد يتجاوز الجائزة. بدون هذا القصّ تُخلق فلوس من العدم.
      let layer = Math.min((lv - prev) * eligible.length, h.prize - paid);
      prev = lv;
      if (layer <= 0) continue;
      let best = h.evals[eligible[0]];
      eligible.forEach(i => { if (dqCmp(h.evals[i], best) > 0) best = h.evals[i]; });
      const w = eligible.filter(i => dqCmp(h.evals[i], best) === 0);
      const share = Math.floor(layer / w.length);
      let rem = layer - share * w.length;
      w.forEach((i, k) => {
        const add = share + (k < rem ? 1 : 0);
        P[i].chips += add; h.gains[i] += add;
        winners.add(i);
      });
      paid += layer;
    }

    // الفائض (رهانات المنسحبين والآمنين) لأقوى يد بين كل المشاركين
    const leftover = h.prize - paid;
    if (leftover > 0) {
      let best = h.evals[inHand[0]];
      inHand.forEach(i => { if (dqCmp(h.evals[i], best) > 0) best = h.evals[i]; });
      const w = inHand.filter(i => dqCmp(h.evals[i], best) === 0);
      const share = Math.floor(leftover / w.length);
      let rem = leftover - share * w.length;
      w.forEach((i, k) => {
        const add = share + (k < rem ? 1 : 0);
        P[i].chips += add; h.gains[i] += add;
        winners.add(i);
      });
    }

    h.winners = [...winners];
    const top = h.winners.filter(i => h.gains[i] > 0);
    h.title = (top.length ? top.map(i => P[i].name).join(' و ') : '—')
      + ' أخذ الكشف — ' + h.prize;
  }

  armRevealTimer() {
    const h = this.room.hand;
    h.endsAt = Date.now() + DQ_REVEAL_MS;
    const snapNo = h.no, snapSeq = h.seq;
    this.setPhaseTimer(DQ_REVEAL_MS + 400, () => this.onTimeout(snapNo, snapSeq));
  }

  async nextHand() {
    const h = this.room.hand;
    if (!h || h.phase !== 'reveal') return;
    this.parkIdlePlayers();
    // من رجع من انقطاع أو ضغط أي زر يعود من الاحتياط تلقائيًا
    this.room.players.forEach(p => { if (p.connected && p.chips > 0 && !p.kicked) p.sitting = false; });
    await this.newHand();
    await this.persist();
    this.broadcastState();
  }
}
applyRoomCommon(DaqashRoom);

// ══════════════════════ لودو الكذب (LudoRoom) ══════════════════════
// نموذج مختلف عن بقية الألعاب: HTTP قصير (استطلاع كل ١.٢ث) بدل WebSocket،
// لأن المحرك يعمل عند كل لاعب ويتزامن عبر سجل أحداث. الخادم يحتفظ بشيئين فقط
// لا يجوز أن يعرفهما أحد غيره: قيمة النرد الحقيقية، ورصيد الكذب لكل لاعب.
const LUDO_MAX_PLAYERS = 4;
const LUDO_ROLL_LOCK_MS = 90 * 1000;      // بعدها تُعتبر الرمية مهجورة
const LUDO_CARDS = ['freeze', 'shield', 'push', 'swap'];   // مطابقة CARDS في ludo/index.html
const LUDO_SKINS = ['classic', 'disc', 'gem', 'hex'];      // مطابقة SKINS في ludo/index.html
const LUDO_BY_ACTIONS = new Set(['pick', 'reveal', 'veto', 'card', 'skin']);

// عدد صحيح داخل مدى، أو null
function ludoInt(v, min, max) {
  const n = Number(v);
  return (Number.isInteger(n) && n >= min && n <= max) ? n : null;
}

/* يبني حركة نظيفة من جسم الطلب: نوع معروف وحقول معروفة فقط.
   أي شيء ناقص أو خارج المدى = رفض، لأن السجل يُعاد تشغيله عند كل لاعب. */
function ludoCleanAction(raw, mySeat) {
  if (!raw || typeof raw !== 'object' || typeof raw.t !== 'string') return null;
  const seat = (v) => ludoInt(v, 0, LUDO_MAX_PLAYERS - 1);
  const piece = (v) => ludoInt(v, 0, 3);
  switch (raw.t) {
    case 'roll':
    case 'nomove':
    case 'commit':
      return { t: raw.t };
    case 'pick': {
      const by = seat(raw.by);
      if (by === null || !LUDO_CARDS.includes(raw.kind)) return null;
      return { t: 'pick', by, kind: raw.kind };
    }
    case 'skin': {   // شكل الحجر — يشوفه الجميع، فيمرّ في سجل الأحداث
      const by = seat(raw.by);
      if (by === null || !LUDO_SKINS.includes(raw.skin)) return null;
      return { t: 'skin', by, skin: raw.skin };
    }
    case 'declare': {
      const v = ludoInt(raw.v, 1, 6), i = piece(raw.i);
      if (v === null || i === null) return null;
      return { t: 'declare', v, i };
    }
    case 'reveal': {
      const by = seat(raw.by);
      if (by === null) return null;
      return { t: 'reveal', by };          // real تُضاف من الخادم
    }
    case 'veto': {
      const by = seat(raw.by);
      if (by === null) return null;
      return { t: 'veto', by };
    }
    case 'card': {
      const by = seat(raw.by);
      if (by === null || !LUDO_CARDS.includes(raw.kind)) return null;
      const out = { t: 'card', by, kind: raw.kind };
      if (raw.kind === 'freeze' || raw.kind === 'push' || raw.kind === 'swap') {
        const target = seat(raw.target);
        if (target === null) return null;
        out.target = target;
      }
      if (raw.kind === 'push' || raw.kind === 'swap') {
        const tp = piece(raw.tp);
        if (tp === null) return null;
        out.tp = tp;
      }
      if (raw.kind === 'swap') {
        const mp = piece(raw.mp);
        if (mp === null) return null;
        out.mp = mp;
      }
      return out;
    }
    default:
      return null;
  }
}

export class LudoRoom {
  constructor(state) {
    this.s = state;
    this.d = { code: '', names: [], started: false, actions: [],
               secret: null, seat: null, lieLimit: 1, lies: [], tokens: [], revealed: false, ts: Date.now() };
    this.loaded = this.s.blockConcurrencyWhile(async () => {
      const saved = await this.s.storage.get('d');
      if (saved) this.d = saved;
    });
  }
  save() {
    this.d.ts = Date.now();
    // لودو ما يمرّ على RoomCommon (بنيته مختلفة)، فمنبّهه مكتوب هنا —
    // بدونه تبقى كل غرفة لودو مخزّنة للأبد
    try { this.s.storage.setAlarm(Date.now() + ROOM_TTL_MS); } catch {}
    return this.s.storage.put('d', this.d);
  }

  async alarm() {
    if (Date.now() - (this.d.ts || 0) >= ROOM_TTL_MS) await this.s.storage.deleteAll();
    else { try { await this.s.storage.setAlarm(Date.now() + ROOM_TTL_MS); } catch {} }
  }
  static json(o, st = 200) {
    return new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json' } });
  }

  async fetch(request) {
    await this.loaded;
    const url = new URL(request.url);
    const J = LudoRoom.json;
    let body = {};
    if (request.method === 'POST') { try { body = await request.json(); } catch { body = {}; } }
    const d = this.d;
    const path = url.pathname.replace(/^.*\/room\/[A-Z0-9]{4,8}/i, '') || url.pathname;

    // إنشاء: يأتي من الراوتر ومعه roomCode. 409 = الكود مستعمل فيولّد الراوتر غيره
    if (url.pathname.endsWith('/create')) {
      if (d.started || d.names.length) return new Response('busy', { status: 409 });
      d.code = String(body.roomCode || '').toUpperCase();
      d.names = [cleanName(body.name)];
      d.tokens = [newSeatToken()];
      await this.save();
      return J({ code: d.code, seat: 0, names: d.names, token: d.tokens[0] });
    }
    if (path === '/join') {
      if (d.started) return J({ error: 'اللعبة بدأت' }, 400);
      if (!d.names.length) return J({ error: 'غرفة غير موجودة' }, 404);
      if (d.names.length >= LUDO_MAX_PLAYERS) return J({ error: 'الغرفة ممتلئة' }, 400);
      d.names.push(cleanName(body.name));
      d.tokens = d.tokens || [];
      d.tokens[d.names.length - 1] = newSeatToken();
      await this.save();
      return J({ seat: d.names.length - 1, names: d.names, token: d.tokens[d.names.length - 1] });
    }
    // المقعد يُشتقّ من التوكن السرّي، لا من جسم الطلب — وإلا لعب أيُّ أحدٍ بمقعد غيره
    const hasTokens = Array.isArray(d.tokens) && d.tokens.length > 0;
    const seatOf = () => {
      if (!hasTokens) return typeof body.seat === 'number' ? body.seat : -1;  // غرف قديمة قبل التحديث
      const t = body.token;
      if (!t) return -1;
      const i = d.tokens.indexOf(t);
      return i;
    };
    const mySeat = seatOf();
    const needSeat = () => mySeat >= 0;

    if (path === '/start') {
      if (!needSeat() || mySeat !== 0) return J({ error: 'المضيف بس يبدأ' }, 403);
      if (d.names.length < 2) return J({ error: 'لازم لاعبين على الأقل' }, 400);
      d.lieLimit = body.lieLimit === -1 ? -1 : Math.max(0, Number(body.lieLimit ?? 1));
      d.lies = d.names.map(() => d.lieLimit);
      d.started = true;
      await this.save();
      return J({ ok: true });
    }
    if (path === '/state') {
      const since = Math.max(0, Number(url.searchParams.get('since') || 0));
      return J({ started: d.started, names: d.names, actions: d.actions.slice(since), n: d.actions.length });
    }
    if (path === '/roll') {
      if (!d.started) return J({ error: 'اللعبة ما بدأت' }, 400);
      if (!needSeat()) return J({ error: 'مقعد غير معروف' }, 403);
      // رمية معلّقة لغيرك = ممنوع ترمي فوقها. بدون هذا يقدر أي لاعب يرمي في أي
      // لحظة فيصير هو صاحب الإعلان بدل صاحب الدور. المهلة تفكّ القفل لو انقطع.
      if (d.secret != null && d.seat !== mySeat
          && Date.now() - (d.rollAt || 0) < LUDO_ROLL_LOCK_MS) {
        return J({ error: 'مو دورك — فيه رمية معلّقة' }, 403);
      }
      d.rollAt = Date.now();
      d.secret = 1 + Math.floor(Math.random() * 6);
      d.seat = mySeat;
      d.revealed = false;
      await this.save();
      return J({ value: d.secret, lieLimit: d.lieLimit,
                 liesLeft: d.lieLimit === -1 ? -1 : (d.lies[mySeat] ?? 0) });
    }
    if (path === '/reveal') {
      if (d.secret == null) return J({ error: 'ما فيه رمية' }, 400);
      // لا يُسلَّم الرقم الحقيقي قبل أن يُعلَن الكشف فعلًا — وإلا استرقّه أيُّ لاعبٍ
      // قبل أن يقرّر: يصيح «كذاب» أو يسكت، فتنهار اللعبة كلها
      if (!d.revealed) return J({ error: 'ما انكشفت بعد' }, 403);
      return J({ real: d.secret });
    }
    if (path === '/action') {
      if (!d.started) return J({ error: 'اللعبة ما بدأت' }, 400);
      if (!needSeat()) return J({ error: 'مقعد غير معروف' }, 403);
      // الحركة تُبنى من جديد بحقولها المعروفة فقط: أي حقل غريب أو نوع مجهول
      // كان يُخزَّن في السجل للأبد، ويكسر apply() عند كل اللاعبين عند أي مزامنة
      const a = ludoCleanAction(body.action, mySeat);
      if (!a) return J({ error: 'حركة غير صالحة' }, 400);
      // الحركات المرتبطة بصاحبها لا تُقبل إلا منه هو
      if (LUDO_BY_ACTIONS.has(a.t) && a.by !== mySeat) return J({ error: 'مقعد غير مطابق' }, 403);
      if (a.t === 'roll' && mySeat !== d.seat) return J({ error: 'ارمِ أول' }, 400);
      if (a.t === 'declare' && mySeat !== d.seat) return J({ error: 'ما هو دورك' }, 403);
      if ((a.t === 'nomove' || a.t === 'commit') && d.seat != null && mySeat !== d.seat) {
        return J({ error: 'ما هو دورك' }, 403);
      }
      if (a.t === 'reveal') {
        if (d.secret == null) return J({ error: 'ما فيه رمية' }, 400);
        a.real = d.secret;              // الحقيقة من الخادم لا من العميل
        d.revealed = true;
      }
      let liesLeft = null;
      if (a.t === 'declare' && d.lieLimit !== -1) {
        const lying = d.secret != null && a.v !== d.secret;
        if (lying && (d.lies[mySeat] || 0) <= 0)
          return J({ error: 'خلصت كذبتك — لازم تعلن الرقم الحقيقي', liesLeft: 0 }, 403);
        if (lying) d.lies[mySeat] -= 1;
        liesLeft = d.lies[mySeat];
      }
      if (d.actions.length > 4000) return J({ error: 'الجولة طويلة جدًا' }, 409);
      d.actions.push(a);
      // 'nomove' كذلك يُنهي الرمية — بدونها بقي القفل مغلقًا على اللاعب التالي
      if (a.t === 'commit' || a.t === 'reveal' || a.t === 'veto' || a.t === 'nomove') {
        d.secret = null; d.seat = null; d.rollAt = 0;
      }
      await this.save();
      return J({ ok: true, n: d.actions.length, liesLeft });
    }
    return J({ error: 'unknown: ' + url.pathname }, 404);
  }
}

// ══════════════════════ مين الدخيل — أونلاين ══════════════════════
// غرفة واحدة = instance من DakhilRoom. الجميع في نفس المجلس، كل واحد
// على جواله: الجهاز يوزّع الأدوار ويجمع التصويت، والكلام يصير على الطاولة.
// الكلمة السرية لا تُرسل أبدًا لمن ما يستحقها — الدخيل ما يشوفها إلا
// في شاشة النتائج.

const DK_MIN_PLAYERS = 3;
const DK_MAX_PLAYERS = 12;

const DAKHIL_BANK = {
  "مسلسلات": ["Game of Thrones", "Prison Break", "House", "Suits", "Breaking Bad", "Friends", "Stranger Things", "The Office", "Dark", "Money Heist", "Peaky Blinders", "The Crown", "Vikings", "Sherlock", "Better Call Saul", "The Witcher", "Narcos", "How I Met Your Mother", "The Big Bang Theory", "Squid Game"],
  "أكلات": ["كبسة", "شاورما", "سوشي", "برجر", "مندي", "بيتزا", "باستا", "فلافل", "حمص", "تكو", "دجاج مشوي", "رز بخاري", "مقلوبة", "برياني", "سمبوسة", "كباب", "شيش طاووق", "ستيك", "سلطة سيزر", "رامن", "فتة", "مظبي", "جريش", "مرقوق", "حنيني", "مسخن", "ماكاروني", "لازانيا", "تشيز برجر", "سلمون مشوي"],
  "حلويات": ["كنافة", "دونات", "كوكيز", "لقيمات", "بقلاوة", "أم علي", "كيك", "تشيز كيك", "آيس كريم", "مهلبية", "بسبوسة", "هريسة", "معمول", "جيلي", "فطيرة تفاح", "براونيز", "وافل", "كريب", "حلاوة جبن", "تمر"],
  "أنمي": ["هجوم العمالقة", "ناروتو", "قاتل الشياطين", "مذكرة الموت", "ون بيس", "بليتش", "دراغون بول", "فيري تيل", "تشينسو مان", "جوجتسو كايسن", "سباي فاميلي", "فول ميتال ألكيميست", "هانتر × هانتر", "توكيو غول", "ماي هيرو أكاديميا", "ون بانش مان", "كودو غياس", "إيفانجيليون", "سيلور مون", "دورايمون"],
  "ألعاب": ["ببجي", "فورتنايت", "دارك سولز", "ماريو", "ماين كرافت", "روبلوكس", "GTA", "فيفا", "كول أوف ديوتي", "أوفرواتش", "فالورانت", "ليج أوف ليجيندز", "ذا لاست أوف أس", "ريزيدنت إيفل", "سبايدرمان", "جود أوف وور", "زيلدا", "سونيك", "ستريت فايتر", "موبايل ليجيندز"],
  "كيبوب": ["BTS", "BLACKPINK", "TWICE", "EXO", "SEVENTEEN", "Stray Kids", "NewJeans", "IVE", "(G)I-DLE", "ATEEZ", "ENHYPEN", "TXT", "ITZY", "Red Velvet", "NCT", "aespa", "Super Junior", "SHINee", "BIGBANG", "iKON"],
  "أماكن": ["مستشفى", "مطار", "مدرسة", "ملعب", "سجن", "مسجد", "بنك", "سوق", "حديقة", "فندق", "مطعم", "صيدلية", "محطة قطار", "جامعة", "شاطئ", "مستشفى نفسية", "محطة بنزين", "مول", "سينما", "متحف", "مكتبة", "ملاهي", "حديقة حيوان", "مصنع", "مزرعة", "ميناء", "محكمة", "مقهى", "مسبح", "صالة رياضية", "ديسكو", "كازينو", "ملهى ليلي", "قصر مسكون", "يخت فاخر", "حفلة تنكرية", "استراحة", "صحراء ليلاً", "جزيرة مهجورة", "سطح ناطحة سحاب"],
  "ملابس": ["ثوب", "عباية", "شماغ", "بشت", "تيشيرت", "جينز", "هودي", "فستان", "بدلة رسمية", "كاب", "جاكيت", "شورت", "تنورة", "بلوزة", "غترة", "طاقية", "جوتي", "حذاء رياضي", "معطف", "بيجامة"],
  "رياضات": ["كرة قدم", "كرة سلة", "سباحة", "جري", "بادل", "كرة طائرة", "فنون قتالية", "تنس", "ركوب خيل", "بولينغ", "جولف", "ملاكمة", "مصارعة", "تزلج", "غوص", "رماية", "دراجات", "كرة يد", "هوكي", "كرة طاولة"],
  "سيارات": ["تويوتا", "لكزس", "فورد", "تسلا", "بي إم دبليو", "هامر", "جيب", "فيراري", "نيسان", "كامري", "مرسيدس", "أودي", "بورش", "كورفيت", "لامبورجيني", "رنج روفر", "هوندا", "شفروليه", "مازدا", "كيا"],
  "مدن ودول": ["الرياض", "دبي", "القاهرة", "اسطنبول", "لندن", "طوكيو", "باريس", "نيويورك", "مكة", "جدة", "برشلونة", "روما", "سيؤول", "بانكوك", "أمستردام", "فيينا", "الدوحة", "الكويت", "بيروت", "مراكش"],
  "مهن": ["طبيب", "مهندس", "معلم", "طيار", "شرطي", "محامي", "طباخ", "مبرمج", "ممرض", "رجل إطفاء", "محاسب", "صحفي", "مصور", "نجار", "كهربائي", "سائق", "مترجم", "صيدلي", "مصمم", "بائع", "مزارع", "خياط", "حلاق", "جراح", "طبيب أسنان", "مهندس معماري", "محقق", "عالم", "رائد فضاء", "مدرب رياضي", "راقصة", "دي جي", "مغني", "ممثل", "عارض أزياء", "حارس شخصي", "جاسوس", "ساحر", "مهرج", "مذيع"],
  "مشروبات": ["قهوة سعودية", "شاي كرك", "عصير مانجو", "كولا", "ستاربكس", "موهيتو", "لاتيه", "سوبيا", "فيمتو", "شاي أحمر", "عصير برتقال", "ميلك شيك", "سفن أب", "ريد بُل", "ماء", "نسكافيه", "شاي أخضر", "عصير ليمون بالنعناع", "كابتشينو", "هوت شوكليت"],
  "حيوانات": ["أسد", "نمر", "جمل", "صقر", "ذئب", "فيل", "دلفين", "قط", "كلب", "حصان", "نسر", "غزال", "دب", "تمساح", "قرد", "بطريق", "زرافة", "ثعلب", "أرنب", "حوت"]
};

const DK_CATS = Object.keys(DAKHIL_BANK);

const sanitizeDakhilBools = makeConfigSanitizer(
  ['useCustom', 'mukhadiOn', 'decoyOn', 'guessOn'],
  { dakhilCount: [1, 11, 1] }
);

function sanitizeDakhilConfig(raw) {
  const out = sanitizeDakhilBools(raw);
  /* تخمين الدخيل مفعّل افتراضيًا مثل وضع الجهاز الواحد — كان يبدأ مطفأً
     أونلاين فقط، فالغرف الجديدة تلعب بلا شاشة التخمين إلا لو انتبه المضيف */
  out.guessOn = raw && Object.prototype.hasOwnProperty.call(raw, 'guessOn') ? !!raw.guessOn : true;
  const cat = raw && typeof raw.catKey === 'string' ? raw.catKey : '';
  out.catKey = DK_CATS.includes(cat) ? cat : DK_CATS[0];
  out.customWord = cleanText(raw && raw.customWord, 24);
  out.dakhilMode = (raw && raw.dakhilMode === 'random') ? 'random' : 'fixed';
  if (!out.customWord) out.useCustom = false;
  if (out.useCustom) out.decoyOn = false;   // الكلمة القريبة تحتاج فئة
  return out;
}

export class DakhilRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map();
    this.timer = null;
    this.state.blockConcurrencyWhile(async () => {
      this.room = (await this.state.storage.get('room')) || {
        code: null, hostId: null, phase: 'lobby',
        cfg: sanitizeDakhilConfig({}),
        players: [],
        round: null,
        roundNo: 0,
        usedWords: {},
        lastSeen: Date.now(),
      };
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/ws')) return this.handleWebSocket(request);
    if (url.pathname.endsWith('/create')) return this.handleCreate(request);
    return new Response('غير موجود', { status: 404 });
  }

  async persist() {
    await this.touchRoom();
    await this.state.storage.put('room', this.room);
  }

  findPlayer(id) { return this.room.players.find(p => p.id === id) || null; }
  idxOf(id) { return this.room.players.findIndex(p => p.id === id); }
  activePlayers() { return this.room.players.filter(p => p.connected); }

  setPhaseTimer(ms, fn) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = null;
      try { await fn(); } catch (e) {}
    }, ms);
  }
  clearPhaseTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }

  async handleCreate(request) {
    let body;
    try { body = await request.json(); } catch { return new Response('bad-json', { status: 400 }); }
    const { name, roomCode } = body || {};
    if (this.room.code && this.room.players.length && this.room.phase !== 'over') {
      return new Response('room-exists', { status: 409 });
    }
    this.room.code = roomCode;
    this.room.phase = 'lobby';
    this.room.cfg = sanitizeDakhilConfig(body && body.cfg);
    this.room.round = null;
    this.room.roundNo = 0;
    this.room.usedWords = {};
    const hostId = crypto.randomUUID();
    const hostToken = newSeatToken();
    this.room.hostId = hostId;
    this.room.players = [this.newSeat(hostId, name, hostToken)];
    await this.persist();
    return Response.json({ roomCode: this.room.code, playerId: hostId, seatToken: hostToken });
  }

  newSeat(id, name, token) {
    return {
      id,
      name: cleanName(name),
      seatToken: token || newSeatToken(),
      connected: false,
      score: 0,
      g: 'm',
      st: { right: 0, wrong: 0, target: 0, undetected: 0, wordGuessed: 0, against: 0 },
    };
  }

  // ═══════════ الاتصال ═══════════
  async handleWebSocket(request) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('يتطلب WebSocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const token = url.searchParams.get('token');
    const name = url.searchParams.get('name');

    let player = this.seatByToken(token);

    if (player) {
      const stale = this.sockets.get(player.id);
      if (stale && stale !== server) { try { stale.close(); } catch {} }
      this.sockets.delete(player.id);
      player.connected = true;
    } else {
      if (!this.room.code) {
        server.send(JSON.stringify({ type: 'error', message: 'ما فيه غرفة بهذا الرمز' }));
        server.close();
        return new Response(null, { status: 101, webSocket: client });
      }
      if (this.room.phase !== 'lobby' && this.room.phase !== 'results') {
        server.send(JSON.stringify({ type: 'error', message: 'الجولة شغّالة — انتظر لين تخلص' }));
        server.close();
        return new Response(null, { status: 101, webSocket: client });
      }
      if (this.room.players.length >= DK_MAX_PLAYERS) {
        server.send(JSON.stringify({ type: 'error', message: 'الغرفة ممتلئة' }));
        server.close();
        return new Response(null, { status: 101, webSocket: client });
      }
      player = this.newSeat(crypto.randomUUID(), name, newSeatToken());
      player.connected = true;
      this.room.players.push(player);
    }

    this.sockets.set(player.id, server);
    server.addEventListener('message', evt => this.onMessage(player.id, evt));
    server.addEventListener('close', () => this.onClose(player.id));

    await this.persist();
    this.sendPrivate(player.id, {
      type: 'welcome',
      playerId: player.id,
      roomCode: this.room.code,
      seatToken: player.seatToken,
    });
    this.broadcastState();
    return new Response(null, { status: 101, webSocket: client });
  }

  async onClose(playerId) {
    const p = this.findPlayer(playerId);
    if (p) p.connected = false;
    this.sockets.delete(playerId);
    const wasHost = this.room.hostId === playerId;
    this.migrateHostIfNeeded();
    if (wasHost && this.room.hostId !== playerId) {
      this.broadcast({ type: 'hostChanged', hostId: this.room.hostId });
    }
    await this.persist();
    // لو كان آخر واحد ننتظره، لا نعلّق الجولة عليه
    await this.maybeAdvance();
    this.broadcastState();
  }

  migrateHostIfNeeded() {
    const host = this.findPlayer(this.room.hostId);
    if (host && host.connected) return;
    const next = this.room.players.find(p => p.connected);
    if (next) this.room.hostId = next.id;
  }

  send(playerId, obj) {
    const ws = this.sockets.get(playerId);
    if (!ws) return;
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
  sendPrivate(playerId, obj) { this.send(playerId, obj); }
  broadcast(obj) { for (const id of this.sockets.keys()) this.send(id, obj); }
  broadcastState() { for (const id of this.sockets.keys()) this.send(id, this.stateFor(id)); }

  // ═══════════ الحالة المنقّاة ═══════════
  /* جدار الأمان: الكلمة السرية والأدوار ما تُرسل إلا لمن يملكها،
     والتصويت يبقى مخفيًا حتى شاشة النتائج. */
  stateFor(viewerId) {
    const r = this.room;
    const rd = r.round;
    const over = r.phase === 'results';

    const players = r.players.map(p => {
      const base = {
        id: p.id, name: p.name, connected: p.connected,
        isHost: p.id === r.hostId, score: p.score, g: p.g || 'm',
      };
      if (rd) {
        base.seen = rd.seen.includes(p.id);
        base.voted = Array.isArray(rd.votes[p.id]);
        base.guessed = rd.guesses[p.id] !== undefined;
        base.gain = rd.gains ? (rd.gains[p.id] || 0) : 0;
        if (over) {
          base.role = this.roleOf(p.id);
          base.guess = rd.guesses[p.id] !== undefined ? rd.guesses[p.id] : null;
          base.guessRight = rd.guesses[p.id] === rd.word;
        }
      }
      return base;
    });

    const out = {
      type: 'state',
      phase: r.phase,
      code: r.code,
      cfg: r.cfg,
      cats: DK_CATS,
      hostId: r.hostId,
      you: viewerId,
      roundNo: r.roundNo,
      players,
      max: DK_MAX_PLAYERS,
      min: DK_MIN_PLAYERS,
      maxDakhil: this.maxDakhil(),
      now: Date.now(),
    };

    if (rd) {
      out.round = {
        catKey: rd.custom ? null : rd.catKey,
        custom: rd.custom,
        endsAt: rd.endsAt || null,
        paused: !!rd.paused,
        remain: rd.remain != null ? rd.remain : null,
        total: rd.total || 0,
        waitingSeen: this.waitingIds(rd.seen).length,
        waitingVote: this.waitingIds(Object.keys(rd.votes)).length,
        guessTurn: r.phase === 'guess' ? rd.dakhil.filter(id => rd.guesses[id] === undefined).length : 0,
      };
      if (r.phase === 'expose') {
        // الكشف الدرامي بعد التصويت: الأسماء فقط، والكلمة تبقى محجوبة
        out.round.exposed = rd.dakhil.slice();
        out.round.willGuess = this.guessWillRun();
      }
      if (over) {
        out.round.word = rd.word;
        out.round.dakhilCount = rd.dakhil.length;
        out.round.hasMukhadi = !!rd.mukhadi;
        out.round.titles = this.titles();
        out.round.votes = r.players.map(p => ({
          id: p.id,
          on: (rd.votes[p.id] || []).slice(),
        }));
      }

      // ── البطاقة الخاصة: كل واحد يشوف دوره هو فقط ──
      const you = {};
      const role = this.roleOf(viewerId);
      if (role) {
        you.role = role;
        if (role === 'dakhil') {
          you.decoy = rd.decoy[viewerId] || null;
          you.catKey = rd.custom ? null : rd.catKey;
        } else {
          // داخل أو مخادع: الاثنين يعرفون الكلمة
          you.word = rd.word;
        }
        you.seen = rd.seen.includes(viewerId);
        you.vote = rd.votes[viewerId] || null;
        if (r.phase === 'guess' && role === 'dakhil') {
          you.options = rd.options[viewerId] || [];
          you.guess = rd.guesses[viewerId] !== undefined ? rd.guesses[viewerId] : null;
        }
      }
      out.me = you;
    }
    return out;
  }

  waitingIds(doneList) {
    const done = new Set(doneList);
    return this.room.players.filter(p => p.connected && !done.has(p.id)).map(p => p.id);
  }

  roleOf(id) {
    const rd = this.room.round;
    if (!rd) return null;
    if (rd.dakhil.includes(id)) return 'dakhil';
    if (rd.mukhadi === id) return 'mukhadi';
    if (rd.seatIds.includes(id)) return 'dakhel';
    return null;   // انضم بعد ما بدأت الجولة
  }

  maxDakhil() {
    const n = this.activePlayers().length || this.room.players.length;
    return Math.max(1, n - 1 - (this.room.cfg.mukhadiOn ? 1 : 0));
  }

  // ═══════════ الرسائل ═══════════
  async onMessage(playerId, evt) {
    if (!this.allowMsg(playerId)) return;
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const p = this.findPlayer(playerId);
    if (!p) return;
    const isHost = playerId === this.room.hostId;

    switch (msg.type) {
      case 'updateName':
        if (typeof msg.name === 'string' && msg.name.trim()) {
          p.name = cleanName(msg.name);
          await this.persist(); this.broadcastState();
        }
        break;

      case 'updateSettings':
        if (isHost && (this.room.phase === 'lobby' || this.room.phase === 'results')) {
          this.room.cfg = sanitizeDakhilConfig(msg.cfg);
          const mx = this.maxDakhil();
          if (this.room.cfg.dakhilCount > mx) this.room.cfg.dakhilCount = mx;
          await this.persist(); this.broadcastState();
        }
        break;

      case 'kick':
        if (isHost && (this.room.phase === 'lobby' || this.room.phase === 'results')) {
          const i = this.idxOf(msg.targetId);
          if (i > -1 && this.room.players[i].id !== this.room.hostId) {
            const ws = this.sockets.get(msg.targetId);
            if (ws) {
              try { ws.send(JSON.stringify({ type: 'kicked', message: 'المضيف طلّعك من الغرفة' })); } catch {}
              try { ws.close(); } catch {}
            }
            this.sockets.delete(msg.targetId);
            this.room.players.splice(i, 1);
            await this.persist(); this.broadcastState();
          }
        }
        break;

      case 'setGender':
        // كل واحد يحدد جنسه هو — يستخدم في صياغة الألقاب
        if (this.room.phase === 'lobby' || this.room.phase === 'results') {
          p.g = msg.g === 'f' ? 'f' : 'm';
          await this.persist(); this.broadcastState();
        }
        break;

      case 'exposeNext':
        if (isHost && this.room.phase === 'expose') await this.afterExpose();
        break;

      case 'start':
        if (isHost && (this.room.phase === 'lobby' || this.room.phase === 'results')) await this.startRound();
        break;

      case 'seen':
        if (this.room.phase === 'reveal' && this.roleOf(playerId)) {
          const rd = this.room.round;
          if (!rd.seen.includes(playerId)) rd.seen.push(playerId);
          await this.persist();
          if (!(await this.maybeAdvance())) this.broadcastState();
        }
        break;

      case 'startTimer':
        if (isHost && this.room.phase === 'discuss') {
          const mins = Math.min(10, Math.max(1, Number(msg.minutes) || 3));
          const rd = this.room.round;
          rd.total = mins * 60;
          rd.remain = null;
          rd.paused = false;
          rd.endsAt = Date.now() + rd.total * 1000;
          this.setPhaseTimer(rd.total * 1000, () => this.startVote());
          await this.persist(); this.broadcastState();
        }
        break;

      case 'pauseTimer':
        // لا نشترط endsAt: الإيقاف يمسحه، فلو اشترطناه ما رجع أحد يكمّل أبدًا
        if (isHost && this.room.phase === 'discuss' && this.room.round &&
            (this.room.round.endsAt || this.room.round.paused)) {
          const rd = this.room.round;
          if (rd.paused) {
            rd.paused = false;
            rd.endsAt = Date.now() + (rd.remain || 0) * 1000;
            rd.remain = null;
            this.setPhaseTimer(Math.max(0, rd.endsAt - Date.now()), () => this.startVote());
          } else {
            rd.paused = true;
            rd.remain = Math.max(0, Math.round((rd.endsAt - Date.now()) / 1000));
            rd.endsAt = null;
            this.clearPhaseTimer();
          }
          await this.persist(); this.broadcastState();
        }
        break;

      case 'goVote':
        if (isHost && this.room.phase === 'discuss') await this.startVote();
        break;

      case 'vote': {
        if (this.room.phase !== 'vote' || !this.roleOf(playerId)) break;
        const rd = this.room.round;
        const ids = Array.isArray(msg.on) ? msg.on : [];
        const valid = ids
          .filter(id => id !== playerId && rd.seatIds.includes(id))
          .filter((id, i, a) => a.indexOf(id) === i)
          .slice(0, DK_MAX_PLAYERS);
        rd.votes[playerId] = valid;
        await this.persist();
        if (!(await this.maybeAdvance())) this.broadcastState();
        break;
      }

      case 'unvote':
        if (this.room.phase === 'vote') {
          delete this.room.round.votes[playerId];
          await this.persist(); this.broadcastState();
        }
        break;

      case 'guess': {
        if (this.room.phase !== 'guess') break;
        const rd = this.room.round;
        if (!rd.dakhil.includes(playerId)) break;
        const opts = rd.options[playerId] || [];
        if (!opts.includes(msg.word)) break;
        rd.guesses[playerId] = msg.word;
        await this.persist();
        if (!(await this.maybeAdvance())) this.broadcastState();
        break;
      }

      case 'force':
        // صمّام أمان: المضيف يقدر يقدّم أي شاشة انتظار
        if (isHost) await this.forceAdvance();
        break;

      case 'ping':
        this.send(playerId, this.stateFor(playerId));
        break;
    }
  }

  // ═══════════ الجولة ═══════════
  pickWord(cfg) {
    if (cfg.useCustom && cfg.customWord) return cfg.customWord;
    const pool = DAKHIL_BANK[cfg.catKey] || [];
    let used = this.room.usedWords[cfg.catKey] || [];
    let avail = pool.filter(w => used.indexOf(w) === -1);
    if (!avail.length) { avail = pool; used = []; }
    const w = avail[randInt(avail.length)];
    this.room.usedWords[cfg.catKey] = used.concat([w]);
    return w;
  }

  buildOptions(word, catKey, decoyWord) {
    const pool = DAKHIL_BANK[catKey] || [];
    const opts = [];
    if (decoyWord && decoyWord !== word) opts.push(decoyWord);
    const rest = shuffle(pool.filter(w => w !== word && opts.indexOf(w) === -1));
    const cap = Math.min(6, pool.length);
    for (let i = 0; i < rest.length && opts.length < cap - 1; i++) opts.push(rest[i]);
    opts.push(word);
    return shuffle(opts);
  }

  async startRound() {
    this.clearPhaseTimer();
    const r = this.room;
    const seats = this.activePlayers();
    if (seats.length < DK_MIN_PLAYERS) {
      this.send(r.hostId, { type: 'error', message: 'محتاج ٣ لاعبين متصلين على الأقل' });
      return;
    }
    if (r.cfg.useCustom && !r.cfg.customWord) {
      this.send(r.hostId, { type: 'error', message: 'اكتب الكلمة المخصصة أول' });
      return;
    }
    const n = seats.length;
    if (n - (r.cfg.mukhadiOn ? 1 : 0) < 2) {
      this.send(r.hostId, { type: 'error', message: 'عدد اللاعبين قليل على هذي الإعدادات' });
      return;
    }

    const word = this.pickWord(r.cfg);
    const maxD = Math.max(1, n - 1 - (r.cfg.mukhadiOn ? 1 : 0));
    const count = r.cfg.dakhilMode === 'fixed'
      ? Math.min(r.cfg.dakhilCount, maxD)
      : 1 + randInt(maxD);

    const order = shuffle(seats.map(p => p.id));
    const dakhil = order.slice(0, count);
    const mukhadi = r.cfg.mukhadiOn ? (order[count] || null) : null;

    const decoy = {};
    if (r.cfg.decoyOn && !r.cfg.useCustom) {
      const alt = shuffle((DAKHIL_BANK[r.cfg.catKey] || []).filter(w => w !== word));
      dakhil.forEach((id, i) => { if (alt.length) decoy[id] = alt[i % alt.length]; });
    }

    r.roundNo++;
    r.round = {
      word,
      catKey: r.cfg.catKey,
      custom: !!r.cfg.useCustom,
      seatIds: order.slice(),
      dakhil, mukhadi, decoy,
      seen: [], votes: {}, guesses: {}, options: {},
      gains: null,
      endsAt: null, remain: null, paused: false, total: 0,
    };
    r.phase = 'reveal';
    await this.persist();
    this.broadcastState();
  }

  async startVote() {
    if (this.room.phase !== 'discuss') return;  // حارس حسم مزدوج
    this.clearPhaseTimer();
    const rd = this.room.round;
    rd.endsAt = null; rd.remain = null; rd.paused = false;
    this.room.phase = 'vote';
    await this.persist();
    this.broadcastState();
  }

  async startDiscuss() {
    if (this.room.phase !== 'reveal') return;
    this.room.phase = 'discuss';
    await this.persist();
    this.broadcastState();
  }

  guessWillRun() {
    const r = this.room, rd = r.round;
    if (!rd) return false;
    const pool = DAKHIL_BANK[rd.catKey] || [];
    return !!(r.cfg.guessOn && !rd.custom && rd.dakhil.length > 0 && pool.length > 1);
  }

  async startGuessOrResults() {
    if (this.room.phase !== 'vote') return;
    this.clearPhaseTimer();
    const r = this.room;
    // شاشة كشف الدخيل بين التصويت والتخمين — مثل الوضع المحلي
    if (r.round.dakhil.length > 0) {
      r.phase = 'expose';
      await this.persist();
      this.broadcastState();
      return;
    }
    return this.afterExpose();
  }

  async afterExpose() {
    const r = this.room, rd = r.round;
    if (r.phase !== 'expose' && r.phase !== 'vote') return;
    const doGuess = this.guessWillRun();
    if (doGuess) {
      rd.options = {};
      rd.dakhil.forEach(id => { rd.options[id] = this.buildOptions(rd.word, rd.catKey, rd.decoy[id]); });
      rd.guesses = {};
      r.phase = 'guess';
      await this.persist();
      this.broadcastState();
    } else {
      await this.finishRound();
    }
  }

  async finishRound() {
    if (this.room.phase === 'results') return;   // حارس حسم مزدوج
    this.clearPhaseTimer();
    const r = this.room, rd = r.round;
    const targets = rd.dakhil.concat(rd.mukhadi ? [rd.mukhadi] : []);
    const isTarget = id => targets.includes(id);
    const gains = {};
    rd.seatIds.forEach(id => { gains[id] = 0; });

    // تخمين المشتبهين
    for (const voter of rd.seatIds) {
      const on = rd.votes[voter] || [];
      let right = 0, wrong = 0;
      on.forEach(id => { if (isTarget(id)) right++; else wrong++; });
      gains[voter] += right - wrong;
      const p = this.findPlayer(voter);
      if (p) { p.st.right += right; p.st.wrong += wrong; }
    }

    // مكافأة من ما انكشف
    // كم صوتًا وقع على كل لاعب (لقب كبش الفدا)
    rd.seatIds.forEach(id => {
      let n = 0;
      rd.seatIds.forEach(v => { if ((rd.votes[v] || []).includes(id)) n++; });
      const pp = this.findPlayer(id);
      if (pp && n) pp.st.against = (pp.st.against || 0) + n;
    });

    const nSeats = rd.seatIds.length;
    targets.forEach(id => {
      let hits = 0;
      rd.seatIds.forEach(v => { if ((rd.votes[v] || []).includes(id)) hits++; });
      const p = this.findPlayer(id);
      if (p) p.st.target += 1;
      if (hits === 0) {
        gains[id] = (gains[id] || 0) + 3;
        if (p) p.st.undetected += 1;
      } else if (hits < Math.ceil((nSeats - 1) / 2)) {
        gains[id] = (gains[id] || 0) + 1;
      }
    });

    // تخمين الدخيل للكلمة
    Object.keys(rd.guesses).forEach(id => {
      if (rd.guesses[id] === rd.word) {
        gains[id] = (gains[id] || 0) + 2;
        const p = this.findPlayer(id);
        if (p) p.st.wordGuessed += 1;
      }
    });

    rd.seatIds.forEach(id => {
      const p = this.findPlayer(id);
      if (p) p.score = Math.max(0, p.score + (gains[id] || 0));
    });
    rd.gains = gains;
    r.phase = 'results';
    await this.persist();
    this.broadcastState();
  }

  titles() {
    const top = key => {
      let best = null, n = 0;
      for (const p of this.room.players) {
        const v = (p.st && p.st[key]) || 0;
        if (v > n) { n = v; best = p; }
      }
      return best ? { p: best, n } : null;
    };
    const f = p => (p.g === 'f');
    const times = n => n + ' ' + (n === 1 ? 'مرة' : 'مرات');
    const innocents = n => n === 1 ? 'بريئًا واحدًا' : n === 2 ? 'بريئين'
      : n <= 10 ? n + ' أبرياء' : n + ' بريئًا';

    const out = [];
    const actor = top('undetected');
    if (actor) out.push({
      em: '🎭', kind: 'actor', name: actor.p.name, n: actor.n,
      lb: f(actor.p) ? 'أفضل ممثلة' : 'أفضل ممثل',
      sb: (f(actor.p) ? 'نجت بدون ما يشك فيها أحد ' : 'نجا بدون ما يشك فيه أحد ') + times(actor.n),
    });
    const det = top('right');
    if (det) out.push({
      em: '🕵️', kind: 'detective', name: det.p.name, n: det.n,
      lb: f(det.p) ? 'أذكى محققة' : 'أذكى محقق',
      sb: (f(det.p) ? 'صابت ' : 'صاب ') + det.n + ' تخمين صحيح خلال الجلسة',
    });
    const reck = top('wrong');
    if (reck) out.push({
      em: '🤡', kind: 'reckless', name: reck.p.name, n: reck.n,
      lb: f(reck.p) ? 'المتهوّرة' : 'المتهوّر',
      sb: (f(reck.p) ? 'اتهمت ' : 'اتهم ') + innocents(reck.n) + ' بلا وجه حق',
    });
    const scape = top('against');
    if (scape) out.push({
      em: '🩸', kind: 'scapegoat', name: scape.p.name, n: scape.n,
      lb: 'كبش الفدا',
      sb: 'صوّتوا ' + (f(scape.p) ? 'عليها' : 'عليه') + ' ' + times(scape.n) + ' خلال الجلسة',
    });
    return out;
  }

  // ── الانتقال التلقائي حين يخلص الجميع ──
  async maybeAdvance() {
    const r = this.room, rd = r.round;
    if (!rd) return false;
    const active = this.activePlayers().filter(p => this.roleOf(p.id));
    if (!active.length) return false;
    if (r.phase === 'reveal' && active.every(p => rd.seen.includes(p.id))) {
      await this.startDiscuss(); return true;
    }
    if (r.phase === 'vote' && active.every(p => Array.isArray(rd.votes[p.id]))) {
      await this.startGuessOrResults(); return true;
    }
    if (r.phase === 'guess') {
      const waiting = rd.dakhil.filter(id => {
        const p = this.findPlayer(id);
        return p && p.connected && rd.guesses[id] === undefined;
      });
      if (!waiting.length) { await this.finishRound(); return true; }
    }
    return false;
  }

  // ── صمّام الأمان: المضيف يقدّم الطور مهما كان المعلّق ──
  async forceAdvance() {
    const r = this.room;
    if (r.phase === 'reveal') return this.startDiscuss();
    if (r.phase === 'discuss') return this.startVote();
    if (r.phase === 'vote') return this.startGuessOrResults();
    if (r.phase === 'expose') return this.afterExpose();
    if (r.phase === 'guess') return this.finishRound();
  }
}
applyRoomCommon(DakhilRoom);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsFor(origin) });
    }

    /* /health قبل حارس المصدر عمدًا: فتحه من شريط المتصفح لا يرسل Origin،
       فكان الحارس يردّه بـ origin-not-allowed ويصير الفحص عديم الفائدة
       وقت ما تحتاجه بالضبط. لا يكشف إلا وجود الربطات من عدمه. */
    if (url.pathname === '/health') {
      return withCors(Response.json({
        ok: true,
        version: 'v24',
        bindings: {
          MAFIA_ROOM: !!env.MAFIA_ROOM, GOT_ROOM: !!env.GOT_ROOM,
          MAWWIH_ROOM: !!env.MAWWIH_ROOM, FATIN_ROOM: !!env.FATIN_ROOM,
          DAQASH_ROOM: !!env.DAQASH_ROOM, WALIMA_ROOM: !!env.WALIMA_ROOM,
          LUDO_ROOM: !!env.LUDO_ROOM, DAKHIL_ROOM: !!env.DAKHIL_ROOM,
        },
      }), origin);
    }

    // ── حارس المصدر: يمنع أي طلب من خارج الموقع ──
    // لا بد من CORS حتى على الرفض، وإلا حجب المتصفحُ الردَّ وظهر
    // "Failed to fetch" بدل السبب الحقيقي.
    if (!isAllowedOrigin(origin)) {
      return withCors(new Response('origin-not-allowed: ' + (origin || 'بلا مصدر'), { status: 403 }), origin);
    }

    // إنشاء غرفة جديدة: نولّد كودًا عشوائيًا أولاً، ثم نربطه بـ DO ثابت عبر idFromName
    // حتى الانضمام لاحقًا بنفس الكود يوصل لنفس الغرفة دائمًا
    // ── لودو: HTTP بدل WebSocket ──
    const ludoCreate = url.pathname === '/ludo/room/create';
    const ludoOp = url.pathname.match(/^\/ludo\/room\/([A-Z0-9]{6})\/(join|start|state|roll|reveal|action)$/i);
    if (ludoCreate || ludoOp) {
      if (!env.LUDO_ROOM) {
        return withCors(new Response(
          'binding-missing: أضف ربط LUDO_ROOM في wrangler.toml ثم أعد النشر', { status: 501 }), origin);
      }
      if (ludoCreate) {
        const ip = request.headers.get('CF-Connecting-IP') || '';
        if (!allowCreate(ip)) return withCors(new Response('too-many-rooms', { status: 429 }), origin);
        let body;
        try { body = await request.json(); } catch { return withCors(new Response('bad-json', { status: 400 }), origin); }
        for (let attempt = 0; attempt < 6; attempt++) {
          const code = newRoomCode();
          const stub = env.LUDO_ROOM.get(env.LUDO_ROOM.idFromName(code));
          const resp = await stub.fetch(new Request(url.origin + '/create', {
            method: 'POST', body: JSON.stringify({ ...body, roomCode: code }),
          }));
          if (resp.status !== 409) return withCors(resp, origin);
        }
        return withCors(new Response('تعذّر إنشاء غرفة، حاول مرة ثانية', { status: 503 }), origin);
      }
      const code = ludoOp[1].toUpperCase();
      const stub = env.LUDO_ROOM.get(env.LUDO_ROOM.idFromName(code));
      const resp = await stub.fetch(new Request(url.origin + '/room/' + code + '/' + ludoOp[2].toLowerCase() + url.search, {
        method: request.method,
        body: request.method === 'POST' ? await request.text() : undefined,
      }));
      return withCors(resp, origin);
    }

    if (url.pathname === '/room/create' || url.pathname === '/got/room/create' || url.pathname === '/mawwih/room/create' || url.pathname === '/fatin/room/create' || url.pathname === '/daqash/room/create' || url.pathname === '/walima/room/create' || url.pathname === '/dakhil/room/create') {
      const gameNS = url.pathname.startsWith('/got/') ? env.GOT_ROOM
                    : url.pathname.startsWith('/mawwih/') ? env.MAWWIH_ROOM
                    : url.pathname.startsWith('/fatin/') ? env.FATIN_ROOM
                    : url.pathname.startsWith('/daqash/') ? env.DAQASH_ROOM
                    : url.pathname.startsWith('/walima/') ? env.WALIMA_ROOM
                    : url.pathname.startsWith('/dakhil/') ? env.DAKHIL_ROOM
                    : env.MAFIA_ROOM;
      // بدون هذا الفحص يرمي الربطُ المفقود استثناءً فيرجع 500 بلا CORS،
      // ويظهر عند اللاعب كـ "Failed to fetch" بلا أي دلالة على السبب
      if (!gameNS) {
        return withCors(new Response(
          'binding-missing: أضف ربط الـ Durable Object في wrangler.toml ثم أعد النشر',
          { status: 501 }), origin);
      }
      const ip = request.headers.get('CF-Connecting-IP') || '';
      if (!allowCreate(ip)) {
        return withCors(new Response('too-many-rooms', { status: 429 }), origin);
      }
      let body;
      try { body = await request.json(); }
      catch { return withCors(new Response('bad-json', { status: 400 }), origin); }
      // لو صادف الكود غرفة حيّة، نولّد غيره بدل ما نمسحها
      for (let attempt = 0; attempt < 6; attempt++) {
        const code = newRoomCode();
        const id = gameNS.idFromName(code);
        const stub = gameNS.get(id);
        const resp = await stub.fetch(new Request(url.origin + '/create', {
          method: 'POST',
          body: JSON.stringify({ ...body, roomCode: code }),
        }));
        if (resp.status !== 409) return withCors(resp, origin);
      }
      return withCors(new Response('تعذّر إنشاء غرفة، حاول مرة ثانية', { status: 503 }), origin);
    }

    // الانضمام لغرفة موجودة بالكود، أو فتح اتصال WebSocket لغرفة قائمة
    const match = url.pathname.match(/^\/(got|mawwih|fatin|daqash|walima|dakhil)?\/?room\/([A-Z0-9]{6})\/ws$/i);
    if (match) {
      const g = (match[1]||'').toLowerCase();
      const gameNS = g==='got' ? env.GOT_ROOM : g==='mawwih' ? env.MAWWIH_ROOM : g==='fatin' ? env.FATIN_ROOM : g==='daqash' ? env.DAQASH_ROOM : g==='walima' ? env.WALIMA_ROOM : g==='dakhil' ? env.DAKHIL_ROOM : env.MAFIA_ROOM;
      if (!gameNS) {
        return withCors(new Response(
          'binding-missing: أضف ربط الـ Durable Object في wrangler.toml ثم أعد النشر',
          { status: 501 }), origin);
      }
      // حارس وجود الغرفة يرفض الرمز الغلط، لكن كل محاولة توقظ Durable Object.
      // نخنق المحاولات نفسها حتى لا يصير مسح الرموز بالتخمين رخيصًا.
      if (!allowSocket(request.headers.get('CF-Connecting-IP') || '')) {
        return withCors(new Response('too-many-connections', { status: 429 }), origin);
      }
      const code = match[2].toUpperCase();
      const id = gameNS.idFromName(code);
      const stub = gameNS.get(id);
      return stub.fetch(request);
    }

    // مسار إنشاء/انضمام لم يُطابَق: أعطِ 404 صريحًا بترويسات CORS بدل
    // السقوط على صفحة الترحيب، وإلا رأى العميل "Failed to fetch"
    if (/\/room\/(create|[A-Z0-9]{6}\/ws)$/i.test(url.pathname)) {
      return withCors(new Response('unknown-route: ' + url.pathname, { status: 404 }), origin);
    }

    return withCors(new Response(
      'مافيا، لمن العرش، موّه، فَطِن، داقش، وليمة، ولودو أونلاين — استوديو يا٧ · /health للفحص',
      { status: 200 }), origin);
  },
};
