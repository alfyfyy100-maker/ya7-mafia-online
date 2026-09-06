/* مولّد نسخة التجربة: يشتقّ الملف من المصدرين الحقيقيين (worker.js و
   tari/index.html) ولا ينسخ منطق لعبٍ بيده — عشان ما تفترق النسختان. */
import fs from 'node:fs';

const W = fs.readFileSync('/home/user/ya7-mafia-online/worker.js', 'utf8');
const H = fs.readFileSync('/home/user/ya7-mafia-online/tari/index.html', 'utf8');
const PJ = fs.readFileSync('/home/user/ya7-mafia-online/tari/prompts.json', 'utf8');

/* الاستخراج بنهاية السطر لا بموازنة الأقواس: محارف مثل " و ' داخل
   حرفيات regex (مثل /[<>&"'`\\]/g في cleanName) تخدع أي ماسح مبسّط
   فيبتلع نصف الملف. وكل دوال المستوى الأعلى هنا تنتهي بـ} في العمود ٠. */
function topLevel(src, header, endLine) {
  const i = src.indexOf('\n' + header);
  if (i < 0) throw new Error('missing: ' + header);
  const j = src.indexOf('\n' + endLine + '\n', i);
  if (j < 0) throw new Error('no terminator for: ' + header);
  return src.slice(i + 1, j + 1 + endLine.length);
}
const fn = name => topLevel(W, 'function ' + name + '(', '}');
const afn = name => topLevel(W, 'async function ' + name + '(', '}');
const objConst = name => topLevel(W, 'const ' + name + ' = {', '};');

const HELPERS = [
  "const MAX_PLAYERS = " + (W.match(/const MAX_PLAYERS = (\d+);/) || [])[1] + ";",
  "const MSG_PER_SEC = " + (W.match(/const MSG_PER_SEC = (\d+);/) || [])[1] + ";",
  "const ROOM_TTL_MS = 6 * 60 * 60 * 1000;",
  (W.match(/const RESERVED_IDS = [^\n]+/) || [])[0],
  fn('cleanName'), fn('cleanText'), fn('randInt'), fn('newSeatToken'),
  fn('tokenEquals'), fn('validPlayerId'), fn('uniqueName'), fn('topBy'), fn('reclaimSeat'),
  'async function recordResult() {}',
  objConst('RoomCommon'),
].join('\n\n');

const a = W.indexOf('/* ═════════════════ طاريك — لعبة حفلات أونلاين (TariRoom) ═════════════════');
const b = W.indexOf("applyRoomCommon(TariRoom, 'tari');");
if (a < 0 || b < 0) throw new Error('TARI block markers not found');
const TARI = W.slice(a, b).replace('export class TariRoom', 'class TariRoom');

/* ملاحظة: TARI_CLIP_MIME تبقى كما هي — اللاعبون الآليون يولّدون webm
   حقيقيًا عبر MediaRecorder، فلا حاجة لتوسيع القائمة في التجربة. */

const SHIM = `
/* ══════════════════════════════════════════════════════════════════
   نسخة التجربة — تشتغل وحدها بلا نت وبلا نشر.
   الخادم نفسه (TariRoom) يعمل داخل هذي الصفحة، ومعه ثلاثة لاعبين
   آليّين. المنطق مستخرَج آليًا من worker.js — ما فيه نسخة بيد.
   ⚠️ هذي للتجربة فقط. النسخة الحقيقية أونلاين في tari/index.html.
   ══════════════════════════════════════════════════════════════════ */
const DEMO = (() => {

/* ── ردّ يشبه Response لكن يقبل 101 و webSocket (المتصفّح يرفضهما) ── */
class R2 {
  constructor(body, init) {
    init = init || {};
    this._b = body; this.status = init.status || 200;
    this.webSocket = init.webSocket || null;
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new Headers(init.headers || {});
  }
  async json() { return typeof this._b === 'string' ? JSON.parse(this._b) : this._b; }
  async text() { return typeof this._b === 'string' ? this._b : JSON.stringify(this._b); }
  static json(o, init) { return new R2(JSON.stringify(o), init); }
}

/* ── مقبس داخلي: طرفان يتكلّمان في نفس الصفحة ── */
class Sock {
  constructor() { this.ls = {}; this.peer = null; this.readyState = 1; }
  accept() {}
  addEventListener(t, f) { (this.ls[t] = this.ls[t] || []).push(f); }
  fire(t, e) { for (const f of (this.ls[t] || [])) { try { f(e); } catch (err) { console.error(err); } } }
  send(data) { const p = this.peer; if (p && p.readyState === 1) setTimeout(() => p.fire('message', { data }), 0); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const p = this.peer;
    setTimeout(() => this.fire('close', {}), 0);
    if (p && p.readyState !== 3) { p.readyState = 3; setTimeout(() => p.fire('close', {}), 0); }
  }
}
class Pair { constructor() { const a = new Sock(), b = new Sock(); a.peer = b; b.peer = a; return { 0: a, 1: b }; } }

/* ── تخزين الكائن: في الذاكرة، وبنفس شكل الواجهة الحقيقية ── */
function demoState() {
  const mem = new Map();
  return {
    blockConcurrencyWhile: fn => fn(),
    waitUntil: p => p,
    storage: {
      get: k => mem.get(k),
      put: (k, v) => { mem.set(k, JSON.parse(JSON.stringify(v))); },
      setAlarm: () => {}, deleteAll: () => mem.clear(),
    },
  };
}

const Server = (() => {
  const Response = R2;              // يظلّل العام داخل هذا النطاق وحده
  const WebSocketPair = Pair;

${HELPERS.split('\n').map(l => l ? '  ' + l : l).join('\n')}

  /* نسخة مصغّرة من applyRoomCommon: تنسخ ما ينقص الصنف من RoomCommon
     وتلتقط نبضة hb — بلا مسارات /seat-check و/roster (لا لزوم لها هنا). */
  function applyRoomCommon(cls) {
    for (const [k, v] of Object.entries(RoomCommon)) if (!(k in cls.prototype)) cls.prototype[k] = v;
    const inner = cls.prototype.onMessage;
    cls.prototype.onMessage = function (pid, evt) {
      try {
        const m = JSON.parse(evt.data);
        if (m && m.type === 'hb') {
          const ws = this.sockets && this.sockets.get(pid);
          if (ws) { try { ws.send('{"type":"pong"}'); } catch {} }
          return;
        }
      } catch {}
      return inner.call(this, pid, evt);
    };
  }

${TARI.split('\n').map(l => l ? '  ' + l : l).join('\n')}
  applyRoomCommon(TariRoom);

  return { TariRoom, TARI_BANK, TARI_KINDS, TARI_ADD_MAX, TARI_TEXT_MAX, TARI_OPT_MAX, TARI_OPTS_MAX, TARI_ANS_MAX };
})();

/* ── الغرف الحيّة في هذي الصفحة ── */
const rooms = new Map();
async function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, new Server.TariRoom(demoState(), {}));
    await Promise.resolve(); await Promise.resolve();
  }
  return rooms.get(code);
}
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

/* ── صوت مُصطنَع: لاعبٌ آليّ لازم «يتكلّم» شيئًا يُسمَع ──
   نولّد webm حقيقيًا عبر MediaRecorder من نغمة متعرّجة، فيمرّ من نفس
   حرّاس الخادم بلا أي استثناء له. ونفس المسار هو بديل المايك حين
   يرفض المتصفّح فتحه (فتح الملف من file:// يمنع المايك). */
let AC = null;
function ac() {
  if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
  if (AC.state === 'suspended') AC.resume();
  return AC;
}
function pickMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'])
    { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {} }
  return '';
}
function babbleStream(base) {
  const c = ac();
  const dest = c.createMediaStreamDestination();
  const osc = c.createOscillator(), g = c.createGain();
  osc.type = 'sawtooth';
  const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100;
  osc.connect(lp); lp.connect(g); g.connect(dest);
  const t0 = c.currentTime;
  osc.frequency.setValueAtTime(base, t0);
  g.gain.setValueAtTime(0.0001, t0);
  for (let i = 0; i < 14; i++) {                       // تعرّج يشبه مقاطع الكلام
    const t = t0 + i * 0.13;
    osc.frequency.setValueAtTime(base * (0.75 + Math.random() * 0.7), t);
    g.gain.setValueAtTime(i % 3 === 2 ? 0.0001 : 0.22, t);
  }
  osc.start();
  return { stream: dest.stream, stop: () => { try { osc.stop(); } catch {} } };
}
async function synthClip(base, ms) {
  const b = babbleStream(base);
  const mime = pickMime();
  const mr = new MediaRecorder(b.stream, Object.assign({ audioBitsPerSecond: 24000 }, mime ? { mimeType: mime } : {}));
  const chunks = [];
  mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise(r => { mr.onstop = r; });
  mr.start();
  await new Promise(r => setTimeout(r, ms));
  try { mr.stop(); } catch {}
  await done; b.stop();
  const blob = new Blob(chunks, { type: chunks[0] ? chunks[0].type : 'audio/webm' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  return { b64: btoa(s), mime: (blob.type || 'audio/webm').split(';')[0], ms };
}

/* ── مايك مع بديل: نجرّب الحقيقي، وإن رُفض نعطي نغمة عشان تكمل التجربة ── */
const realGUM = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
  ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices) : null;
let micNoted = false;
if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async c => {
  if (realGUM) { try { return await realGUM(c); } catch (e) {} }
  if (!micNoted) { micNoted = true; setTimeout(() => note('ما فتح المايك (لأن الملف محلّي) — سجّلنا لك نغمة بدله عشان تكمل التجربة'), 300); }
  return babbleStream(210).stream;
};

/* ── fetch مزيّف: يخدم مسارات الوركر من داخل الصفحة ── */
const realFetch = window.fetch ? window.fetch.bind(window) : null;
window.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (/\\/tari\\/bank(\\?|$)/.test(url)) {
    return R2.json({
      ok: true,
      kinds: Object.fromEntries(Object.entries(Server.TARI_KINDS).map(([k, v]) => [k, {
        name: v.name, inputType: v.inputType, recorders: v.recorders,
        clipMs: v.clipMs || 0, textMax: v.textMax || Server.TARI_ANS_MAX,
        needsOpts: !!v.needsOpts, needsTones: !!v.needsTones,
      }])),
      bank: Server.TARI_BANK.map((p, i) => ({
        id: p.kind + ':' + i, kind: p.kind, text: p.text,
        opts: p.opts || null, tones: p.tones || null,
      })),
      limits: { add: Server.TARI_ADD_MAX, text: Server.TARI_TEXT_MAX, opt: Server.TARI_OPT_MAX, opts: Server.TARI_OPTS_MAX },
    });
  }
  if (/prompts\\.json(\\?|$)/.test(url)) return new R2(DEMO_PROMPTS_JSON, { status: 200 });
  if (/\\/tari\\/room\\/create$/.test(url)) {
    ac();                                            // نوقظ الصوت داخل ضغطة المستخدم
    let body = {}; try { body = JSON.parse((init && init.body) || '{}'); } catch {}
    const code = newCode();
    const room = await getRoom(code);
    const res = await room.fetch({
      url: 'https://demo.local/create',
      headers: { get: () => null },
      json: async () => ({ name: body.name, roomCode: code }),
    });
    const j = await res.json();
    setTimeout(() => spawnBots(code), 700);
    return R2.json(j);
  }
  if (realFetch) return realFetch(input, init);
  throw new Error('offline');
};

/* ── WebSocket مزيّف يوصل للغرفة في نفس الصفحة ── */
class DemoWS {
  constructor(url) {
    this.url = url; this.readyState = 0;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    (async () => {
      try {
        const http = url.replace(/^ws/, 'http');
        const code = (new URL(http).pathname.match(/\\/room\\/([A-Za-z0-9]{6})\\//) || [])[1];
        if (!code) throw new Error('bad code');
        const room = await getRoom(code.toUpperCase());
        const res = await room.fetch({
          url: http,
          headers: { get: h => (String(h).toLowerCase() === 'upgrade' ? 'websocket' : null) },
        });
        const c = res.webSocket;
        if (!c) throw new Error('no socket');
        this._c = c;
        c.addEventListener('message', e => this.onmessage && this.onmessage(e));
        c.addEventListener('close', () => { this.readyState = 3; this.onclose && this.onclose({}); });
        this.readyState = 1;
        setTimeout(() => this.onopen && this.onopen({}), 0);
      } catch (e) {
        this.readyState = 3;
        setTimeout(() => { this.onerror && this.onerror(e); this.onclose && this.onclose({}); }, 0);
      }
    })();
  }
  send(s) { if (this._c && this.readyState === 1) this._c.send(s); }
  close() { this.readyState = 3; if (this._c) this._c.close(); }
}
window.WebSocket = DemoWS;

/* ══════════════ اللاعبون الآليّون ══════════════ */
const BOTS = [
  { name: 'نورة', pitch: 320 }, { name: 'فهد', pitch: 165 }, { name: 'ريم', pitch: 260 },
];
const LINES = [
  'يقول «ثانية وحدة» ويختفي ساعة', 'ينسى ويجي بعدنا بيومين', 'يضحك وهو ما فهم شي',
  'يرسل صوتية عشر دقايق', 'يقول «أنا قلت لكم» وهو ما قال', 'يبدأ يخطّط وما يكمّل',
  'يطلب قهوة ثم ينساها', 'يحلف إنه في الطريق وهو بالبيت',
];
const wait = ms => new Promise(r => setTimeout(r, ms));

function spawnBots(code) {
  BOTS.forEach((b, i) => setTimeout(() => runBot(code, b, i), 200 + i * 260));
}
function runBot(code, spec, idx) {
  const ws = new DemoWS('ws://demo.local/tari/room/' + code + '/ws?name=' + encodeURIComponent(spec.name) + '&jid=' + 'b'.repeat(31) + idx);
  let me = null, busy = false, lastKey = '';
  const hb = setInterval(() => { try { ws.send(JSON.stringify({ type: 'hb' })); } catch {} }, 25000);
  ws.onclose = () => clearInterval(hb);
  ws.onmessage = async e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'welcome') { me = m.playerId; return; }
    if (m.type !== 'state' || busy) return;
    const s = m;
    const key = s.phase + ':' + s.round + ':' + (s.chain ? s.chain.turn : '');
    if (key === lastKey) return;

    if (s.phase === 'collect' && s.you.expected && !s.you.submitted) {
      if (s.chain && s.chain.whoId !== s.you.id) return;
      lastKey = key; busy = true;
      await wait(900 + Math.random() * 2200);
      try {
        if (s.inputType === 'audio') {
          const c = await synthClip(spec.pitch * (0.9 + Math.random() * 0.3), 1600 + Math.random() * 1200);
          ws.send(JSON.stringify({ type: 'clip', b64: c.b64, mime: c.mime, ms: c.ms }));
        } else if (s.inputType === 'choice') {
          ws.send(JSON.stringify({ type: 'submit', choice: Math.floor(Math.random() * (s.opts || [1]).length) }));
        } else {
          ws.send(JSON.stringify({ type: 'submit', text: LINES[Math.floor(Math.random() * LINES.length)] }));
        }
      } catch (err) { console.error('bot', err); }
      busy = false;
      return;
    }
    if (s.phase === 'vote' && s.you.canVote && !s.you.myVote) {
      lastKey = key; busy = true;
      await wait(1200 + Math.random() * 2500);
      const opts = (s.items || []).filter(x => !x.mine);
      if (opts.length) ws.send(JSON.stringify({ type: 'vote', id: opts[Math.floor(Math.random() * opts.length)].id }));
      busy = false;
    }
  };
}

function note(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg; t.className = 'toast on';
  clearTimeout(note._t); note._t = setTimeout(() => (t.className = 'toast'), 5000);
}

const DEMO_PROMPTS_JSON = ${JSON.stringify(PJ)};
return { note };
})();
`;

const BANNER = `
/* لافتة التجربة + تبسيط الشاشة الأولى (بلا لمس منطق اللعبة) */
(() => {
  const app = document.getElementById('app');
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;align-items:center;gap:8px;margin:0 0 10px;padding:7px 12px;' +
    'border:1px solid #ffc94d;background:#ffc94d14;border-radius:99px;font-size:.82rem;color:#ffeab8';
  const lbl = document.createElement('span');
  lbl.style.cssText = 'flex:1;cursor:pointer';
  lbl.innerHTML = '<b>نسخة تجربة</b> — بلا نت، ومعك ٣ لاعبين آليّين · <u>تفاصيل</u>';
  const x = document.createElement('span');
  x.textContent = '✕'; x.style.cssText = 'cursor:pointer;opacity:.6;padding:0 2px';
  x.onclick = () => bar.remove();
  bar.append(lbl, x);
  const more = document.createElement('div');
  more.className = 'card tight';
  more.hidden = true;
  more.style.cssText = 'margin:0 0 10px;border-color:#ffc94d;background:#ffc94d10';
  more.innerHTML = '<p class="mini" style="margin:0">الخادم يشتغل داخل هذي الصفحة — ما فيه نت ولا نشر. ' +
    'اكتب اسمك واضغط «ابدأ التجربة».<br><br>لو ما فتح المايك (لأن الملف محلّي، والمتصفّح يمنع المايك على ملفات file://) ' +
    'بنسجّل لك نغمة بدل صوتك عشان تكمل الجولة — والنسخة الحقيقية أونلاين تسجّل صوتك فعلًا.</p>';
  lbl.onclick = () => { more.hidden = !more.hidden; };
  app.insertBefore(more, app.firstChild);
  app.insertBefore(bar, app.firstChild);

  const j = document.getElementById('b-join');
  if (j) {
    const card = j.parentElement;
    const ci = document.getElementById('i-code');
    const lab = ci && ci.previousElementSibling;
    const hr = card.querySelector('.hr');
    [j, ci, lab, hr].forEach(n => n && n.remove());
  }
  const c = document.getElementById('b-create');
  if (c) c.textContent = '▶ ابدأ التجربة';
})();
`;

const marker = '<script>\n/* ══════════════════════════════════════════════════════════════════\n   طاريك — واجهة اللاعب';
if (!H.includes(marker)) throw new Error('page script marker not found');
let out = H
  .replace('<title>طاريك — لعبة حفلات</title>', '<title>طاريك — نسخة تجربة</title>')
  .replace(marker, '<script>' + SHIM + '<\/script>\n' + marker)
  .replace('</body>', '<script>' + BANNER + '<\/script>\n</body>');

fs.writeFileSync('/home/user/ya7-mafia-online/tari/طاريك-تجربة.html', out);
console.log('demo built:', (out.length / 1024).toFixed(0) + 'KB');
