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
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
function withCors(resp) {
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(resp.body, { status: resp.status, headers: h });
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
const BOT_NAMES = ['فهد','سارة','عبدالله','نورة','خالد','ريم','تركي','لمى','سلطان','هند','ماجد','جود','بندر','شهد','ناصر','دانة','راكان','العنود','مشعل','غلا'];
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
    const { name, gender, roomCode } = await request.json();
    this.room.code = roomCode;
    const hostId = crypto.randomUUID();
    this.room.hostId = hostId;
    this.room.players = [{
      id: hostId, name, gender: gender || 'm', alive: true,
      role: null, twinId: null, connected: false,
    }];
    await this.persist();
    return withCors(Response.json({ roomCode: this.room.code, playerId: hostId }));
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

    let player = this.room.players.find(p => p.id === playerId);
    if (!player) {
      // لاعب جديد ينضم
      if (this.room.phase !== 'lobby') {
        server.send(JSON.stringify({ type: 'error', message: 'اللعبة بدأت، ما تقدر تنضم الحين' }));
        server.close();
        return new Response(null, { status: 101, webSocket: client });
      }
      player = {
        id: playerId || crypto.randomUUID(), name, gender,
        alive: true, role: null, twinId: null, connected: true,
      };
      this.room.players.push(player);
    } else {
      player.connected = true;
    }

    this.sockets.set(player.id, server);
    server.addEventListener('message', (evt) => this.onMessage(player.id, evt));
    server.addEventListener('close', () => this.onClose(player.id));

    await this.persist();
    this.broadcastLobby();
    // إرسال حالة اللاعب الحالية له (مهم لو أعاد الاتصال بعد انقطاع)
    this.sendPrivate(player.id, { type: 'welcome', playerId: player.id, roomCode: this.room.code });
    if (player.role) this.sendPrivate(player.id, this.roleMessageFor(player));
    if (this.room.phase !== 'lobby') this.sendRoundStateTo(player.id);

    return new Response(null, { status: 101, webSocket: client });
  }

  async onMessage(playerId, evt) {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }

    if (msg.type === 'updateConfig' && playerId === this.room.hostId) {
      Object.assign(this.room.config, msg.config);
      await this.persist();
      this.broadcastLobby();
    }

    if (msg.type === 'kickPlayer' && playerId === this.room.hostId && this.room.phase === 'lobby') {
      await this.kickPlayer(msg.targetId);
    }

    if (msg.type === 'addBot' && playerId === this.room.hostId && this.room.phase === 'lobby') {
      await this.addBot();
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

  onClose(playerId) {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) player.connected = false;
    this.sockets.delete(playerId);
    this.persist();
    this.broadcastLobby();
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

  async addBot() {
    const used = new Set(this.room.players.map(p => p.name));
    const name = BOT_NAMES.find(n => !used.has(n)) || ('بوت' + (this.room.players.length + 1));
    const gender = Math.random() < 0.5 ? 'm' : 'f';
    this.room.players.push({
      id: 'bot-' + crypto.randomUUID(), name, gender, alive: true,
      role: null, twinId: null, connected: true, isBot: true,
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
    this.room.firstDeathDone = false;
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
      const others = alive.filter(p => p.id !== bot.id);
      // ٨٠٪ يصوّتون لأحد، ٢٠٪ يمتنعون — لتنويع طبيعي
      this.room.dayVotes[bot.id] = (others.length && Math.random() < 0.8) ? pickRandom(others).id : null;
    }
  }

  // ═══════════ مرحلة الليل ═══════════
  async handleNightAction(playerId, msg) {
    const player = this.findPlayer(playerId);
    if (!player || !player.alive) return;
    const na = this.room.nightActions;

    switch (player.role) {
      case 'mafia':
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
    const mafiaAlive = alive.filter(p => p.role === 'mafia');
    if (mafiaAlive.length && !mafiaAlive.every(p => (na.mafiaVotes || {})[p.id])) return false;
    if (this.isAliveRole('doctor') && na.doctorTarget === undefined) return false;
    if (this.isAliveRole('detective') && na.detectiveTarget === undefined) return false;
    if (this.isAliveRole('spy') && na.spyTarget === undefined) return false;
    // ننتظر ردًّا صريحًا من الساحرة (إلا لو انتهت قدرتاها) ومن المنتقم كل ليلة
    const witch = alive.find(p => p.role === 'witch');
    if (witch && !(witch.usedSave && witch.usedPoison) && !na.witchResponded) return false;
    const avenger = alive.find(p => p.role === 'avenger');
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
      for (const t of Object.values(na.mafiaVotes)) tally[t] = (tally[t] || 0) + 1;
      const max = Math.max(...Object.values(tally));
      const top = Object.keys(tally).filter(k => tally[k] === max);
      killedByMafia = top[Math.floor(Math.random() * top.length)];
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
    const info = ROLES[heir.role];
    this.sendPrivate(heir.id, {
      type: 'roleChanged', role: heir.role, roleName: info.name, team: info.team,
      note: `مات ${deadPlayer.name} — ورثت دوره: ${info.name}`,
    });
  }

  // ═══════════ مرحلة النهار / التصويت ═══════════
  async startVoting() {
    this.room.phase = 'voting';
    this.room.dayVotes = {};
    this.autoBotVotes();
    await this.persist();
    this.broadcastPublic({ type: 'phaseChanged', phase: 'voting', dayNum: this.room.dayNum });
    if (Object.keys(this.room.dayVotes).length >= this.alivePlayers().length) await this.resolveVote();
  }

  async handleVote(playerId, targetId) {
    const voter = this.findPlayer(playerId);
    if (!voter || !voter.alive) return;
    this.room.dayVotes[playerId] = targetId; // null = امتناع
    await this.persist();
    this.broadcastPublic({
      type: 'voteUpdate',
      votesIn: Object.keys(this.room.dayVotes).length,
      totalAlive: this.alivePlayers().length,
    });
    if (Object.keys(this.room.dayVotes).length >= this.alivePlayers().length) {
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
    if (executedId) {
      const p = this.findPlayer(executedId);
      if (p && p.alive) {
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
    if (this.room.phase === 'night') await this.resolveNight();
    else if (this.room.phase === 'voting') await this.resolveVote();
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
};

function gotLannisterCount(n){ return n>=10?3:n>=7?2:1; }
function gotDefaultConfig(n){
  return { varys:true, melisandre:n>=6, hound:n>=8, baelish:n>=5, lovers:false, craster:false, bronn:false };
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
  while(roles.length<n) roles.push('stark');
  while(roles.length>n) roles.pop();
  return roles;
}

export class GotRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map();
    this.state.blockConcurrencyWhile(async () => {
      this.room = (await this.state.storage.get('room')) || {
        code: null, hostId: null, phase: 'lobby',
        players: [], // {id,name,gender,alive,role,partnerId,connected,usedRevive}
        config: { varys:true, melisandre:false, hound:false, baelish:false, lovers:false, craster:false, bronn:false },
        nightActions: {}, nightNum: 0, deathsTotal: 0,
        crasterTransformed: false, bronnArrowUsed: false, bronnContract: null, baelishSide: null,
        accuseVotes: {}, accusedId: null, finalVotes: {},
        lastDeaths: [],
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
    const { name, gender, roomCode } = await request.json();
    this.room.code = roomCode;
    const hostId = crypto.randomUUID();
    this.room.hostId = hostId;
    this.room.players = [{ id: hostId, name, gender: gender || 'm', alive: true, role: null, partnerId: null, connected: false, usedRevive: false }];
    await this.persist();
    return Response.json({ roomCode: this.room.code, playerId: hostId });
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

    let player = this.room.players.find(p => p.id === playerId);
    if (!player) {
      if (this.room.phase !== 'lobby') {
        server.send(JSON.stringify({ type: 'error', message: 'اللعبة بدأت، ما تقدر تنضم الحين' }));
        server.close();
        return new Response(null, { status: 101, webSocket: client });
      }
      player = { id: playerId || crypto.randomUUID(), name, gender, alive: true, role: null, partnerId: null, connected: true, usedRevive: false };
      this.room.players.push(player);
    } else {
      player.connected = true;
    }

    this.sockets.set(player.id, server);
    server.addEventListener('message', evt => this.onMessage(player.id, evt));
    server.addEventListener('close', () => this.onClose(player.id));

    await this.persist();
    this.broadcastLobby();
    this.sendPrivate(player.id, { type: 'welcome', playerId: player.id, roomCode: this.room.code });
    if (player.role) this.sendPrivate(player.id, this.roleMessageFor(player));
    if (this.room.phase !== 'lobby') this.sendRoundStateTo(player.id);

    return new Response(null, { status: 101, webSocket: client });
  }

  async onMessage(playerId, evt) {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }

    if (msg.type === 'updateConfig' && playerId === this.room.hostId) {
      Object.assign(this.room.config, msg.config);
      await this.persist(); this.broadcastLobby();
    }
    if (msg.type === 'kickPlayer' && playerId === this.room.hostId && this.room.phase === 'lobby') await this.kickPlayer(msg.targetId);
    if (msg.type === 'startGame' && playerId === this.room.hostId) await this.startGame();
    if (msg.type === 'nightAction' && this.room.phase === 'night') await this.handleNightAction(playerId, msg);
    if (msg.type === 'baelishAlign') await this.handleBaelishAlign(playerId, msg.side);
    if (msg.type === 'startAccusation' && playerId === this.room.hostId && this.room.phase === 'day') await this.startAccusation();
    if (msg.type === 'accuseVote' && this.room.phase === 'accusing') await this.handleAccuseVote(playerId, msg.targetId);
    if (msg.type === 'startFinalVote' && playerId === this.room.hostId && this.room.phase === 'trial') await this.startFinalVote();
    if (msg.type === 'finalVote' && this.room.phase === 'finalVoting') await this.handleFinalVote(playerId, msg.guilty);
    if (msg.type === 'hostForceAdvance' && playerId === this.room.hostId) await this.forceAdvance();
  }

  onClose(playerId) {
    const p = this.findPlayer(playerId);
    if (p) p.connected = false;
    this.sockets.delete(playerId);
    this.persist(); this.broadcastLobby();
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
  leaderPlayer(){
    for (const r of ['tywin','cersei','joffrey']) {
      const p = this.alivePlayers().find(x=>x.role===r);
      if (p) return p;
    }
    return null;
  }

  async startGame() {
    const n = this.room.players.length;
    if (n < 4) { this.sendPrivate(this.room.hostId, { type:'error', message:'أقل عدد للبدء ٤ لاعبين' }); return; }
    const roles = gotBuildRoles(n, this.room.config);
    for (let i=roles.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [roles[i],roles[j]]=[roles[j],roles[i]]; }
    this.room.players.forEach((p,i)=>{ p.role = roles[i]; p.alive = true; });
    const robb = this.room.players.find(p=>p.role==='robb');
    const talisa = this.room.players.find(p=>p.role==='talisa');
    if (robb && talisa) { robb.partnerId = talisa.id; talisa.partnerId = robb.id; }

    this.room.phase = 'night'; this.room.nightNum = 1; this.room.nightActions = {};
    await this.persist();
    for (const p of this.room.players) this.sendPrivate(p.id, this.roleMessageFor(p));
    this.broadcastPublic({ type:'phaseChanged', phase:'night', nightNum:1 });
    this.sendNightState();
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
    const na = this.room.nightActions;
    const leader = this.leaderPlayer();

    if (leader && p.id===leader.id) na.kill = msg.targetId ?? null;
    else if (p.role==='varys') {
      na.inspectTarget = msg.targetId;
      const target = this.findPlayer(msg.targetId);
      let res;
      if (target.role==='tywin') res='stark';
      else if (target.role==='baelish') res = this.room.baelishSide || null;
      else if (target.role==='craster') res = this.room.crasterTransformed ? null : 'stark';
      else if (target.role==='bronn') res = this.room.bronnArrowUsed ? (this.room.bronnContract||null) : null;
      else res = GOT_ROLES[target.role].team==='lannister' ? 'lannister' : 'stark';
      this.sendPrivate(p.id, { type:'investigateResult', targetId:target.id, targetName:target.name, team:res });
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

    await this.persist();
    if (this.allNightActionsIn()) await this.resolveNight();
  }

  allNightActionsIn(){
    const na = this.room.nightActions;
    const leader = this.leaderPlayer();
    if (leader && na.kill===undefined) return false;
    if (this.alivePlayers().some(p=>p.role==='varys') && na.inspectTarget===undefined) return false;
    if (this.alivePlayers().some(p=>p.role==='melisandre') && na.protectTarget===undefined && na.reviveTarget===undefined) return false;
    if (this.alivePlayers().some(p=>p.role==='hound') && na.guardTarget===undefined) return false;
    if (this.room.crasterTransformed && this.alivePlayers().some(p=>p.role==='craster') && na.crasterKill===undefined) return false;
    // ننتظر ردًّا من برون ما دام سهمه موجود
    const bronn = this.alivePlayers().find(p=>p.role==='bronn');
    if (bronn && !this.room.bronnArrowUsed && !na.bronnResponded) return false;
    return true;
  }

  async resolveNight(){
    if (this.room.phase !== 'night') return;
    this.room.phase = 'resolvingNight';
    const na = this.room.nightActions;
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
      const targetTeam = GOT_ROLES[this.findPlayer(na.bronnTarget).role].team;
      this.room.bronnContract = targetTeam==='lannister' ? 'stark' : (targetTeam==='stark' ? 'lannister' : null);
    }

    // موت مرتبط: روب وتاليسا
    const deadNames = [];
    const applyDeath = (id) => {
      const p = this.findPlayer(id);
      if (p && p.alive) {
        p.alive = false; this.room.deathsTotal++;
        deadNames.push({ id:p.id, name:p.name });
        if (p.partnerId) { const partner=this.findPlayer(p.partnerId); if (partner && partner.alive) applyDeath(partner.id); }
      }
    };
    for (const id of deaths) applyDeath(id);

    if (na.reviveTarget!==null && na.reviveTarget!==undefined) {
      const p = this.findPlayer(na.reviveTarget);
      if (p && !p.alive) { p.alive = true; this.room.deathsTotal = Math.max(0,this.room.deathsTotal-1); }
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
    await this.persist();
    this.broadcastPublic({ type:'phaseChanged', phase:'accusing' });
  }
  async handleAccuseVote(playerId, targetId){
    const voter = this.findPlayer(playerId);
    if (!voter || !voter.alive) return;
    this.room.accuseVotes[playerId] = targetId;
    await this.persist();
    this.broadcastPublic({ type:'voteUpdate', votesIn:Object.keys(this.room.accuseVotes).length, totalAlive:this.alivePlayers().length });
    if (Object.keys(this.room.accuseVotes).length >= this.alivePlayers().length) await this.resolveAccusation();
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
    await this.persist();
    this.broadcastPublic({ type:'phaseChanged', phase:'finalVoting' });
  }
  async handleFinalVote(playerId, guilty){
    const voter = this.findPlayer(playerId);
    if (!voter || !voter.alive || voter.id===this.room.accusedId) return;
    this.room.finalVotes[playerId] = !!guilty;
    await this.persist();
    const eligible = this.alivePlayers().filter(p=>p.id!==this.room.accusedId).length;
    this.broadcastPublic({ type:'voteUpdate', votesIn:Object.keys(this.room.finalVotes).length, totalAlive:eligible });
    if (Object.keys(this.room.finalVotes).length >= eligible) await this.resolveFinalVote();
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
    await this.persist();
    this.broadcastPublic({ type:'phaseChanged', phase:'night', nightNum:this.room.nightNum });
    this.sendNightState();
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
    const publicPlayers = this.room.players.map(p=>({ id:p.id, name:p.name, gender:p.gender, connected:p.connected, alive:p.alive }));
    this.broadcastPublic({ type:'lobbyUpdate', players:publicPlayers, hostId:this.room.hostId, config:this.room.config });
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
      }
    } else if (this.room.phase === 'day') {
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
  async persist(){ await this.state.storage.put('room', this.room); }
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
["كم نسبة الماء من سطح الأرض تقريباً؟","٧١٪"],["ما اسم الرياح الموسمية في جنوب آسيا؟","المونسون"]]]
];
// ══════════════════════ موّه — الغرفة ══════════════════════
export class MawwihRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map();
    this.state.blockConcurrencyWhile(async () => {
      this.room = (await this.state.storage.get('room')) || {
        code: null, hostId: null, phase: 'lobby',
        players: [], // {id,name,gender,connected,score,av}
        cats: null, rounds: 8,
        round: 0, chooserIdx: 0, used: [],
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
    const { name, gender, roomCode } = await request.json();
    this.room.code = roomCode;
    const hostId = crypto.randomUUID();
    this.room.hostId = hostId;
    this.room.players = [{ id: hostId, name, gender: gender || 'm', connected: false, score: 0, av: null }];
    await this.persist();
    return Response.json({ roomCode: this.room.code, playerId: hostId });
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

    let player = this.room.players.find(p => p.id === playerId);

    // استعادة المقعد بالاسم لمن ضاعت هويته (سكّر المتصفح مثلًا) — يمنع القفل خارج اللعبة
    if (!player && name) {
      const nn = norm(name);
      const seat = this.room.players.find(p => norm(p.name) === nn && !p.connected);
      if (seat) {
        const oldId = seat.id;
        const newId = playerId || crypto.randomUUID();
        seat.id = newId;
        // ننقل كل ما هو مرتبط بالمعرّف القديم
        if (this.room.subs && oldId in this.room.subs) { this.room.subs[newId] = this.room.subs[oldId]; delete this.room.subs[oldId]; }
        if (this.room.votes && oldId in this.room.votes) { this.room.votes[newId] = this.room.votes[oldId]; delete this.room.votes[oldId]; }
        if (this.room.options) this.room.options.forEach(o => { o.by = o.by.map(b => b === oldId ? newId : b); });
        if (this.room.hostId === oldId) this.room.hostId = newId;
        this.sockets.delete(oldId);
        player = seat;
      }
    }

    if (!player) {
      if (this.room.phase !== 'lobby') {
        server.send(JSON.stringify({ type: 'error', message: 'اللعبة بدأت — اكتب نفس اسمك السابق للرجوع لمقعدك' }));
        server.close();
        return new Response(null, { status: 101, webSocket: client });
      }
      player = { id: playerId || crypto.randomUUID(), name, gender, connected: true, score: 0, av: null };
      this.room.players.push(player);
    } else {
      player.connected = true;
    }

    this.sockets.set(player.id, server);
    server.addEventListener('message', evt => this.onMessage(player.id, evt));
    server.addEventListener('close', () => this.onClose(player.id));

    await this.persist();
    this.broadcastLobby();
    this.sendPrivate(player.id, { type: 'welcome', playerId: player.id, roomCode: this.room.code });
    if (this.room.phase !== 'lobby') this.sendRoundStateTo(player.id);

    return new Response(null, { status: 101, webSocket: client });
  }

  async onMessage(playerId, evt) {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }

    if (msg.type === 'setAvatar') { const p = this.findPlayer(playerId); if (p) { p.av = msg.av; await this.persist(); this.broadcastLobby(); } }

    if (msg.type === 'updateProfile' && this.room.phase === 'lobby') {
      const p = this.findPlayer(playerId);
      if (p) {
        if (typeof msg.name === 'string' && msg.name.trim()) p.name = msg.name.trim().slice(0, 14);
        if (typeof msg.av === 'string' && msg.av) p.av = msg.av;
        if (msg.gender === 'm' || msg.gender === 'f') p.gender = msg.gender;
        await this.persist();
        this.broadcastLobby();
      }
    }
    if (msg.type === 'updateSettings' && playerId === this.room.hostId) {
      if (Array.isArray(msg.cats)) this.room.cats = msg.cats;
      if (msg.rounds) this.room.rounds = msg.rounds;
      await this.persist(); this.broadcastLobby();
    }
    if (msg.type === 'kickPlayer' && playerId === this.room.hostId && this.room.phase === 'lobby') await this.kickPlayer(msg.targetId);
    if (msg.type === 'startGame' && playerId === this.room.hostId) await this.startGame();
    if (msg.type === 'pickCategory' && this.room.phase === 'picking' && playerId === this.chooser().id) await this.pickCategory(msg.catIndex);
    if (msg.type === 'submitAnswer' && this.room.phase === 'writing') await this.submitAnswer(playerId, msg.text);
    if (msg.type === 'submitVote' && this.room.phase === 'voting') await this.submitVote(playerId, msg.key);
    if (msg.type === 'nextRound' && playerId === this.room.hostId && this.room.phase === 'reveal') await this.nextRound();
    if (msg.type === 'hostForceAdvance' && playerId === this.room.hostId) await this.forceAdvance();
  }

  onClose(playerId) {
    const p = this.findPlayer(playerId);
    if (p) p.connected = false;
    this.sockets.delete(playerId);
    this.persist(); this.broadcastLobby();
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
  chooser() { return this.room.players[this.room.chooserIdx % this.room.players.length]; }

  async startGame() {
    if (this.room.players.length < 3) { this.sendPrivate(this.room.hostId, { type: 'error', message: 'تحتاجون ٣ لاعبين على الأقل' }); return; }
    this.room.round = 0; this.room.used = [];
    this.room.players.forEach(p => { p.score = 0; });
    if (!this.room.cats || !this.room.cats.length) this.room.cats = BANK.map((_, i) => i);
    await this.nextRound();
  }

  async nextRound() {
    this.room.round++;
    this.room.subs = {}; this.room.votes = {}; this.room.options = null; this.room.q = null;
    this.room.chooserIdx = (this.room.round - 1) % this.room.players.length;
    const avail = this.room.cats.filter(ci => BANK[ci][1].some((_, qi) => !this.room.used.includes(ci + ':' + qi)));
    const pool = avail.length >= 3 ? avail : (this.room.used = [], this.room.cats.slice());
    const choices = shuffleArr(pool.slice()).slice(0, Math.min(3, pool.length));
    this.room.choices = choices;
    this.room.phase = 'picking';
    await this.persist();
    this.broadcastPublic({ type: 'phaseChanged', phase: 'picking', round: this.room.round, rounds: this.room.rounds, chooserId: this.chooser().id, chooserName: this.chooser().name });
    this.sendPrivate(this.chooser().id, {
      type: 'catChoices',
      options: choices.map(ci => ({ index: ci, name: BANK[ci][0], left: BANK[ci][1].filter((_, qi) => !this.room.used.includes(ci + ':' + qi)).length })),
    });
  }

  async pickCategory(catIndex) {
    const pool = [];
    BANK[catIndex][1].forEach((q, qi) => { const key = catIndex + ':' + qi; if (!this.room.used.includes(key)) pool.push({ key, cat: BANK[catIndex][0], text: q[0], ans: q[1] }); });
    const q = pool[Math.floor(Math.random() * pool.length)];
    this.room.used.push(q.key);
    this.room.q = q;
    this.room.phase = 'writing';
    await this.persist();
    this.broadcastPublic({ type: 'phaseChanged', phase: 'writing', cat: q.cat, text: q.text, chooserName: this.chooser().name });
  }

  async submitAnswer(playerId, text) {
    const t = (text || '').trim();
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
    this.broadcastPublic({ type: 'writeProgress', submitted: Object.keys(this.room.subs).length, total: this.room.players.length });
    if (Object.keys(this.room.subs).length >= this.room.players.length) await this.startVoting();
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
    this.room.phase = 'voting';
    await this.persist();
    // كل لاعب يستلم قائمة خاصة فيه، بدون إجابته هو — يمنع تصويت غلط لا يُحتسب بصمت
    for (const p of this.room.players) {
      const myOptions = this.room.options.filter(o => !o.by.includes(p.id)).map(o => ({ key: o.k, text: o.text }));
      this.sendPrivate(p.id, { type: 'phaseChanged', phase: 'voting', cat: this.room.q.cat, text: this.room.q.text, options: myOptions });
    }
  }

  async submitVote(playerId, key) {
    const opt = this.room.options.find(o => o.k === key);
    if (!opt || opt.by.includes(playerId)) {
      this.sendPrivate(playerId, { type: 'error', message: 'ما تقدر تصوّت لإجابتك — اختر غيرها' });
      return;
    }
    this.room.votes[playerId] = key;
    await this.persist();
    this.broadcastPublic({ type: 'voteProgress', submitted: Object.keys(this.room.votes).length, total: this.room.players.length });
    if (Object.keys(this.room.votes).length >= this.room.players.length) await this.reveal();
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
    this.room.players.forEach(p => { p.gain = gain[p.id] || 0; p.score += p.gain; });
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
      isLast,
    });
    if (isLast) await this.endGame();
  }

  async endGame() {
    this.room.phase = 'over';
    await this.persist();
    this.broadcastPublic({
      type: 'gameOver',
      players: [...this.room.players].sort((a, b) => b.score - a.score).map(p => ({ id: p.id, name: p.name, score: p.score })),
    });
  }

  sendRoundStateTo(playerId) {
    // إعادة اتصال أثناء اللعب — نرسل الحالة العامة الحالية بدل ما يعلق باللوبي
    if (this.room.phase === 'picking') this.sendPrivate(playerId, { type: 'phaseChanged', phase: 'picking', round: this.room.round, rounds: this.room.rounds, chooserId: this.chooser().id, chooserName: this.chooser().name });
    else if (this.room.phase === 'writing') this.sendPrivate(playerId, { type: 'phaseChanged', phase: 'writing', cat: this.room.q.cat, text: this.room.q.text, chooserName: this.chooser().name });
    else if (this.room.phase === 'voting') {
      const myOptions = this.room.options.filter(o => !o.by.includes(playerId)).map(o => ({ key: o.k, text: o.text }));
      this.sendPrivate(playerId, { type: 'phaseChanged', phase: 'voting', cat: this.room.q.cat, text: this.room.q.text, options: myOptions });
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
    const publicPlayers = this.room.players.map(p => ({ id: p.id, name: p.name, gender: p.gender, connected: p.connected, av: p.av }));
    this.broadcastPublic({ type: 'lobbyUpdate', players: publicPlayers, hostId: this.room.hostId, cats: this.room.cats, rounds: this.room.rounds });
  }
  broadcastPublic(payload) {
    const json = JSON.stringify(payload);
    for (const ws of this.sockets.values()) { try { ws.send(json); } catch {} }
  }
  sendPrivate(playerId, payload) {
    const ws = this.sockets.get(playerId);
    if (ws) { try { ws.send(JSON.stringify(payload)); } catch {} }
  }
  async persist() { await this.state.storage.put('room', this.room); }
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // إنشاء غرفة جديدة: نولّد كودًا عشوائيًا أولاً، ثم نربطه بـ DO ثابت عبر idFromName
    // حتى الانضمام لاحقًا بنفس الكود يوصل لنفس الغرفة دائمًا
    if (url.pathname === '/room/create' || url.pathname === '/got/room/create' || url.pathname === '/mawwih/room/create') {
      const gameNS = url.pathname.startsWith('/got/') ? env.GOT_ROOM
                    : url.pathname.startsWith('/mawwih/') ? env.MAWWIH_ROOM
                    : env.MAFIA_ROOM;
      const code = Array.from({ length: 6 }, () =>
        '23456789ABCDEFGHJKMNPQRSTUVWXYZ'[Math.floor(Math.random() * 32)]
      ).join('');
      const body = await request.json();
      const id = gameNS.idFromName(code);
      const stub = gameNS.get(id);
      const resp = await stub.fetch(new Request(url.origin + '/create', {
        method: 'POST',
        body: JSON.stringify({ ...body, roomCode: code }),
      }));
      return withCors(resp);
    }

    // الانضمام لغرفة موجودة بالكود، أو فتح اتصال WebSocket لغرفة قائمة
    const match = url.pathname.match(/^\/(got|mawwih)?\/?room\/([A-Z0-9]{6})\/ws$/i);
    if (match) {
      const gameNS = match[1]==='got' ? env.GOT_ROOM : match[1]==='mawwih' ? env.MAWWIH_ROOM : env.MAFIA_ROOM;
      const code = match[2].toUpperCase();
      const id = gameNS.idFromName(code);
      const stub = gameNS.get(id);
      return stub.fetch(request);
    }

    return new Response('مافيا، لمن العرش، وموّه أونلاين — استوديو يا٧', { status: 200 });
  },
};
