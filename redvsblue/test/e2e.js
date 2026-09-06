const { chromium } = require('playwright');
const API = 'http://127.0.0.1:8787';
const BASE = '' + new URL('../index.html', 'file://' + __dirname + '/').href + '?api=' + encodeURIComponent(API);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, label) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + label); await sleep(120); } }
(async () => {
  const browser = await chromium.launch({ executablePath: '' + (process.env.CHROME || '') + '' });
  const errors = [];
  async function newPage(name, extra) {
    const ctx = await browser.newContext({ viewport: { width: 430, height: 860 }, deviceScaleFactor: 2, hasTouch: true });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') errors.push(name + ': ' + m.text()); });
    page.on('pageerror', e => errors.push(name + ' pageerror: ' + e.message));
    await page.goto(BASE + (extra || ''));
    page.nm = name; page.ctx = ctx;
    return page;
  }
  const phase = p => p.evaluate(() => RVB.G.phase);
  const shown = (p, id) => p.evaluate(id => document.getElementById(id).classList.contains('show'), id);

  // ── إنشاء غرفة ──
  const host = await newPage('host');
  await host.click('#tabOnline'); await host.fill('#nameIn', 'سلطان'); await host.click('#createBtn');
  const code = await until(async () => { const c = await host.textContent('#roomCode'); return /^[A-Z0-9]{6}$/.test(c) && (await shown(host, 'lobby')) && (await host.$$eval('#plist li', l => l.length)) === 1 ? c : null; }, 6000, 'room created');
  console.log('room', code);
  // ── انضمام ٣ لاعبين ──
  const names = ['ريم', 'فهد', 'نورة'];
  const others = [];
  for (const nm of names) {
    const p = await newPage(nm, '&room=' + code);
    await until(() => p.evaluate(() => document.getElementById('modeOnline').hidden === false && document.getElementById('codeIn').value.length === 6), 3000, 'room prefill');
    await p.fill('#nameIn', nm); await p.click('#joinBtn');
    others.push(p);
  }
  await until(async () => (await host.$$eval('#plist li', l => l.length)) === 4, 8000, '4 players in lobby');
  const lobby = await host.$$eval('#plist li', l => l.map(x => x.textContent.trim()));
  console.log('lobby', JSON.stringify(lobby));
  // الألوان الأربعة موزّعة تلقائيًا ومختلفة
  const colors = await host.evaluate(() => RVB.Net.st.players.map(p => p.color));
  console.log('colors', colors.join(','), 'distinct', new Set(colors).size === 4);
  await host.screenshot({ path: 'o_lobby_host.png' }); await others[1].screenshot({ path: 'o_lobby_guest.png' });
  // ── بدء الجولة ──
  await host.click('#startBtn');
  const all = [host, ...others];
  await until(async () => (await Promise.all(all.map(phase))).every(ph => ph === 'countdown' || ph === 'fight'), 6000, 'round started');
  await sleep(3800);
  const ph1 = await Promise.all(all.map(phase));
  const rep = await Promise.all(all.map(p => p.evaluate(() => ({ replica: RVB.G.replica, host: RVB.Net.isHost(), n: RVB.G.balls.length, me: RVB.G.player, names: RVB.G.balls.map(b => b.name), colors: RVB.G.balls.map(b => b.c.key) }))));
  console.log('phases', ph1.join(','), 'roles', JSON.stringify(rep));
  // ── دفعة من نسخة (ريم) تصل للمضيف ──
  const pid2 = await others[0].evaluate(() => RVB.Net.pid);
  await others[0].touchscreen.tap(215, 520);
  const pushed = await until(() => host.evaluate(pid => { const b = RVB.G.balls.find(b => b.pid === pid); return b && b.pushCd > 0 ? b.pushCd : null; }, pid2), 2500, 'push relayed to host');
  console.log('push relayed, host pushCd', pushed.toFixed(2));
  await others[0].screenshot({ path: 'o_fight_guest.png' }); await host.screenshot({ path: 'o_fight_host.png' });
  // ── تحديث صفحة نورة أثناء المعركة: تعود لمقعدها وتستلم اللقطة ──
  await others[2].reload();
  await until(() => others[2].evaluate(() => window.RVB && RVB.G.mode === 'online' && RVB.G.phase === 'fight' && RVB.G.balls.length === 4), 8000, 'reconnect after reload');
  console.log('reload rejoin ok');
  // ── تسريع المعركة على المضيف حتى النهاية ──
  for (let i = 0; i < 60; i++) {
    const ph = await host.evaluate(() => { for (let k = 0; k < 480 && RVB.G.phase === 'fight'; k++) RVB.update(1 / 120); return RVB.G.phase; });
    await sleep(160);
    if (ph === 'over') break;
  }
  await until(async () => (await Promise.all(all.map(p => shown(p, 'over')))).every(Boolean), 12000, 'over panel on all');
  const titles = await Promise.all(all.map(p => p.textContent('#resTitle')));
  const againVis = await Promise.all(all.map(p => p.evaluate(() => !document.getElementById('again').hidden)));
  console.log('winner titles', JSON.stringify(titles.map(t => t.trim())), 'again visible', againVis.join(','));
  await others[1].screenshot({ path: 'o_over_guest.png' });
  // ── جولة جديدة ──
  await host.click('#again');
  await until(async () => (await Promise.all(all.map(p => shown(p, 'lobby')))).every(Boolean), 6000, 'back to lobby');
  const scores = await host.$$eval('#plist li', l => l.map(x => x.textContent.trim()));
  console.log('lobby after round', JSON.stringify(scores));
  // ── الجولة ٢: انقطاع المضيف أثناء المعركة → انتقال الاستضافة ──
  await host.click('#startBtn');
  await until(async () => (await Promise.all(all.map(phase))).every(ph => ph === 'countdown' || ph === 'fight'), 6000, 'round 2 started');
  await sleep(4200);
  await host.ctx.close();
  const rest = others;
  const newHost = await until(async () => { for (const p of rest) { const h = await p.evaluate(() => RVB.Net.isHost() && !RVB.G.replica && RVB.G.phase === 'fight'); if (h) return p; } return null; }, 10000, 'host migration');
  console.log('new host:', newHost.nm);
  for (let i = 0; i < 60; i++) {
    const ph = await newHost.evaluate(() => { for (let k = 0; k < 480 && RVB.G.phase === 'fight'; k++) RVB.update(1 / 120); return RVB.G.phase; });
    await sleep(160);
    if (ph === 'over') break;
  }
  await until(async () => (await Promise.all(rest.map(p => shown(p, 'over')))).every(Boolean), 12000, 'over after migration');
  const t2 = await Promise.all(rest.map(p => p.textContent('#resTitle')));
  console.log('round2 winner titles', JSON.stringify(t2.map(t => t.trim())));
  // ── مغادرة ──
  await rest[0].click('#leaveBtn2');
  await until(() => shown(rest[0], 'start'), 3000, 'left room');
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
