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
  let twinPair = null;
  if (config.twins && Math.random() < 0.3) {
    const evilTwin = Math.random() < 0.5;
    roles.push(evilTwin ? 'twin_evil' : 'twin_good');
    roles.push('twin_good');
    twinPair = [roles.length - 2, roles.length - 1];
  }
  while (roles.length < playerCount) roles.push('citizen');
  return { roles: roles.slice(0, playerCount), twinPair };
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
        dayNum: 1,
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
    return Response.json({ roomCode: this.room.code, playerId: hostId });
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

    if (msg.type === 'startGame' && playerId === this.room.hostId) {
      await this.startGame();
    }

    // مراحل الليل/النهار (فعل، تصويت) تُضاف في المرحلة ٣+٤
  }

  onClose(playerId) {
    const player = this.room.players.find(p => p.id === playerId);
    if (player) player.connected = false;
    this.sockets.delete(playerId);
    this.persist();
    this.broadcastLobby();
  }

  async startGame() {
    const n = this.room.players.length;
    if (n < 4) {
      this.sendPrivate(this.room.hostId, { type: 'error', message: 'أقل عدد للبدء ٤ لاعبين' });
      return;
    }
    const { roles, twinPair } = buildRoleList(this.room.config, n);
    shuffle(roles);
    this.room.players.forEach((p, i) => {
      p.role = roles[i];
      p.alive = true;
    });
    if (twinPair) {
      const [a, b] = twinPair;
      this.room.players[a].twinId = this.room.players[b].id;
      this.room.players[b].twinId = this.room.players[a].id;
    }
    this.room.phase = 'night';
    this.room.dayNum = 1;
    await this.persist();

    // كل لاعب يستقبل دوره الخاص فقط — ما حد غيره يشوفه
    for (const p of this.room.players) {
      this.sendPrivate(p.id, this.roleMessageFor(p));
    }
    this.broadcastPublic({ type: 'phaseChanged', phase: 'night', dayNum: 1 });
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
      id: p.id, name: p.name, gender: p.gender, connected: p.connected,
    }));
    this.broadcastPublic({
      type: 'lobbyUpdate',
      players: publicPlayers,
      hostId: this.room.hostId,
      config: this.room.config,
    });
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
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // إنشاء غرفة جديدة: نولّد كودًا عشوائيًا أولاً، ثم نربطه بـ DO ثابت عبر idFromName
    // حتى الانضمام لاحقًا بنفس الكود يوصل لنفس الغرفة دائمًا
    if (url.pathname === '/room/create') {
      const code = Array.from({ length: 6 }, () =>
        '23456789ABCDEFGHJKMNPQRSTUVWXYZ'[Math.floor(Math.random() * 32)]
      ).join('');
      const body = await request.json();
      const id = env.MAFIA_ROOM.idFromName(code);
      const stub = env.MAFIA_ROOM.get(id);
      return stub.fetch(new Request(url.origin + '/create', {
        method: 'POST',
        body: JSON.stringify({ ...body, roomCode: code }),
      }));
    }

    // الانضمام لغرفة موجودة بالكود، أو فتح اتصال WebSocket لغرفة قائمة
    const match = url.pathname.match(/^\/room\/([A-Z0-9]{6})\/ws$/i);
    if (match) {
      const code = match[1].toUpperCase();
      const id = env.MAFIA_ROOM.idFromName(code);
      const stub = env.MAFIA_ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response('مافيا أونلاين — استوديو يا٧', { status: 200 });
  },
};
