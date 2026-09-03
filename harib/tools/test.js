#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   test.js — اختبارات «الهارب» قبل التسليم (تُشغَّل: npm test)

   ١. node --check لكل سكربت داخل index.html ولأدوات البناء.
   ٢. سلامة البيانات: ١٣ منطقة، الوحدات، جوار متماثل، لا وحدة معزولة، كل
      وحدة قابلة للوصول (BFS) وبمشي عشوائي طويل.
   ٣. Haversine على مسافات معروفة (الرياض ↔ جدة).
   ٤. محاكاة jsdom لمباريات كاملة عشوائية بـ٣ و٧ و١٢ و٢٠ لاعبًا، بالنمطين،
      تُدار من الواجهة نفسها (نقرات على الخريطة والأزرار)، مع فحص قواعد
      الحركة والقراءات والقبض وانتهاء الجولات.
   ٥. القبض بتطابق دقيق فقط، وفوز الهارب تلقائيًا بانتهاء الجولات، ونقطة
      التفتيش تمنع الدخول والخروج.
   ٦. حقن أسماء خبيثة — لا عنصر يُنشأ من نصّ اللاعب ولا alert.
   الناتج: test-report.md بجانب هذا الملف.
   ═══════════════════════════════════════════════════════════════════════ */
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML_PATH = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const results = []; let failures = 0;
const t0 = Date.now();
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' }); if (!ok) failures++;
  console.log((ok ? '✔ ' : '✘ ') + name + (detail ? ' — ' + detail : ''));
}
/* مولّد عشوائي ببذرة حتى تكون المحاكاة قابلة للإعادة */
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* ═══ ١. الصياغة ═══ */
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
scripts.forEach((src, i) => {
  const f = path.join(os.tmpdir(), `harib-script-${i}.js`); fs.writeFileSync(f, src);
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); check(`node --check: سكربت index.html رقم ${i + 1} (${(src.length / 1024).toFixed(0)} ك.ب)`, true); }
  catch (e) { check(`node --check: سكربت index.html رقم ${i + 1}`, false, String(e.stderr).slice(0, 300)); }
});
for (const f of ['build-geo.js', 'test.js']) {
  try { execFileSync(process.execPath, ['--check', path.join(__dirname, f)], { stdio: 'pipe' }); check(`node --check: ${f}`, true); }
  catch (e) { check(`node --check: ${f}`, false, String(e.stderr).slice(0, 200)); }
}
check('لا استدعاء alert() في الصفحة', !/\balert\s*\(/.test(html));
check('لا استخدام innerHTML في الصفحة', !/innerHTML/.test(html));
check('بيانات الخريطة محقونة', /const GEO = \{/.test(html));

/* ═══ بيئة jsdom ═══ */
const jsErrors = [];
function makeDom() {
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/not implemented/i.test(e.message)) jsErrors.push(e.message); });
  vc.on('error', m => jsErrors.push(String(m)));
  return new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/harib/', virtualConsole: vc,
    beforeParse(w) { w.scrollTo = () => {}; w.alert = () => { jsErrors.push('alert() استُدعيت'); }; },
  });
}
const dom0 = makeDom(); const H0 = dom0.window.HARIB;
check('الصفحة تُحمَّل في jsdom بلا أخطاء', H0 && !jsErrors.length, jsErrors.join(' | '));

/* ═══ ٢. سلامة البيانات ═══ */
for (const mode of ['regions', 'units']) {
  const M = H0.MAPS[mode]; const ids = new Set(M.ids);
  check(`${mode}: عدد الوحدات ${M.nodes.length}`, mode === 'regions' ? M.nodes.length === 13 : M.nodes.length >= 130);
  let sym = true, dangling = 0, isolated = 0, noPath = 0;
  for (const n of M.nodes) {
    if (!n.adj.length) isolated++;
    if (!n.d || n.d.length < 10) noPath++;
    for (const a of n.adj) { if (!ids.has(a)) dangling++; else if (!M.by.get(a).adj.includes(n.id)) sym = false; }
    if (mode === 'units' && !H0.MAPS.regions.by.has(n.r)) dangling++;
  }
  check(`${mode}: الجوار متماثل وبلا مراجع معلّقة`, sym && !dangling, `dangling=${dangling}`);
  check(`${mode}: لا وحدة بلا جيران`, isolated === 0, `isolated=${isolated}`);
  check(`${mode}: لكل وحدة مسار SVG`, noPath === 0);
  const seen = new Set([M.ids[0]]); const st = [M.ids[0]];
  while (st.length) { const x = st.pop(); for (const y of M.by.get(x).adj) if (!seen.has(y)) { seen.add(y); st.push(y); } }
  check(`${mode}: كل الوحدات قابلة للوصول (BFS)`, seen.size === M.nodes.length, `${seen.size}/${M.nodes.length}`);
  const names = M.nodes.map(n => n.name); check(`${mode}: لا أسماء مكررة`, new Set(names).size === names.length);
  check(`${mode}: أرقام هندية في الأسماء أو لا أرقام`, names.every(n => !/[0-9]/.test(n)));
  /* مشي عشوائي طويل عبر قواعد الحركة نفسها */
  const rngW = mulberry32(7); let cur = M.ids[Math.floor(rngW() * M.ids.length)]; const vis = new Set([cur]); let steps = 0;
  while (vis.size < M.nodes.length && steps < 200000) { const adj = M.by.get(cur).adj; cur = adj[Math.floor(rngW() * adj.length)]; vis.add(cur); steps++; }
  check(`${mode}: مشي عشوائي يغطي كل الوحدات`, vis.size === M.nodes.length, `${vis.size}/${M.nodes.length} في ${steps} خطوة`);
}
/* ═══ ٣. Haversine ═══ */
{
  const dRJ = H0.distKm('units', 'riyadh', 'jiddah');
  check(`Haversine الرياض ↔ جدة = ${dRJ.toFixed(1)} كم (المتوقع ≈ ٨٥٠-٨٧٠)`, dRJ > 800 && dRJ < 900);
  const dMM = H0.distKm('units', 'makkah-al-mukarramah', 'al-madinah-al-munawwarah');
  check(`Haversine مكة ↔ المدينة = ${dMM.toFixed(1)} كم (المتوقع ≈ ٣٤٠)`, dMM > 300 && dMM < 380);
  const eq = H0.haversine(0, 0, 0, 1); check(`Haversine درجة على خط الاستواء = ${eq.toFixed(2)} كم (≈ ١١١.٢)`, Math.abs(eq - 111.19) < 0.5);
  check('المسافة متماثلة وصفرية للوحدة نفسها', H0.distKm('regions', 'RD', 'MQ') === H0.distKm('regions', 'MQ', 'RD') && H0.distKm('regions', 'RD', 'RD') === 0);
}

/* ═══ ٤. محاكاة مباريات كاملة من الواجهة ═══ */
function hopsTo(M, from, to) { if (from === to) return 0; const seen = new Set([from]); let fr = [from]; for (let h = 1; h < 60; h++) { const nx = []; for (const x of fr) for (const y of M.by.get(x).adj) { if (y === to) return h; if (!seen.has(y)) { seen.add(y); nx.push(y); } } fr = nx; if (!fr.length) break; } return Infinity; }
function playMatch(cfg) {
  const dom = makeDom(); const w = dom.window, d = w.document, H = w.HARIB, E = H.Engine;
  const rng = mulberry32(cfg.seed); H.setRng(rng);
  const click = e => { if (!e) throw new Error('عنصر مفقود للنقر'); e.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); };
  const vis = id => !d.getElementById(id).hidden;
  const errs = [];
  click(d.querySelector('[data-act=new]'));
  while (H.setup.names.length < cfg.n) click(d.querySelector('[data-act=add-player]'));
  while (H.setup.names.length > cfg.n) click(d.querySelector('[data-act=remove-player]'));
  d.querySelectorAll('#setup-players input').forEach((inp, i) => { inp.value = (cfg.names && cfg.names[i]) || 'لاعب ' + (i + 1); inp.dispatchEvent(new w.Event('input', { bubbles: true })); });
  click(d.querySelector(`#setup-mode button[data-v="${cfg.mode || 'auto'}"]`));
  if (cfg.rounds) click(d.querySelector(`#setup-rounds button[data-v="${cfg.rounds}"]`));
  click(d.querySelector('[data-act=start]'));
  if (!vis('s-curtain')) errs.push('لم تظهر شاشة الستار بعد البدء');
  const G = H.G; const M = H.MAPS[G.mode];
  if (G.players.length !== cfg.n) errs.push('عدد اللاعبين لا يطابق');
  const stats = { turns: 0, moves: 0, shares: 0, pinpoint: false, fake: false, readingsChecked: 0, checkpoints: 0, reports: 0 };
  let guard = 0, lastRound = 0;
  const posBefore = new Map();
  while (guard++ < 20000) {
    if (G.phase === 'over') break;
    if (G.phase === 'summary') {
      if (!vis('s-summary')) errs.push('حالة summary بلا شاشة الملخص');
      if (d.querySelectorAll('#map-summary .dot').length) errs.push('شاشة الملخص العامة تعرض نقاط لاعبين');
      if (G.closedRound === G.round && G.closed) stats.checkpoints++;
      click(d.querySelector('#summary-panel button.primary')); continue;
    }
    if (G.curtain) { if (!vis('s-curtain')) errs.push('الستار مرفوع في الحالة لكن الشاشة غير ظاهرة'); click(d.querySelector('[data-act=reveal]')); continue; }
    if (!vis('s-turn')) { errs.push('شاشة الدور غير ظاهرة'); break; }
    const p = E.current(G); const legal = [...E.legalTargets(G, p)];
    stats.turns++;
    /* فحص ما تعرضه شاشة الدور: لا نقاط لغير الكاشفين، والقراءة داخل النطاق */
    const dots = [...d.querySelectorAll('#map-turn .dot')].map(g => g.dataset.dot);
    if (p.role === 'fugitive' && dots.some(id => id !== p.pos)) errs.push('الهارب يرى نقاط غيره');
    if (p.role === 'chaser') {
      const allowed = new Set([p.pos, ...E.chasers(G).filter(c => c.share && c.id !== p.id).map(c => c.pos)]);
      if (dots.some(id => !allowed.has(id))) errs.push('مطارد يرى موقع زميل لم يكشف');
      if (dots.includes(E.fugitive(G).pos) && !allowed.has(E.fugitive(G).pos)) errs.push('موقع الهارب ظاهر لمطارد');
      if (p.reading && G.phase === 'round') {
        const r = p.reading; stats.readingsChecked++;
        /* الحقيقة داخل النطاق دائمًا؛ والمسافة صفر (نفس الوحدة) تُعرض «أقل من ٥ كم» فحدّها الأدنى صفر */
        if (r.fake == null && !r.exact && !((r.lo < r.t || r.t === 0) && r.t < r.hi)) errs.push(`قراءة خارج النطاق: ${r.lo}-${r.hi} والحقيقة ${r.t.toFixed(1)}`);
        if (r.fake == null && Math.abs(r.t - H.distKm(G.mode, r.from, G.trail[G.trail.length - 1].pos)) > 1e-6 && G.trail.length && r.round === G.round - 1 && !p.moved) { /* الهارب تحرّك بعد القراءة — لا فحص هنا */ }
        const txt = d.querySelector('#turn-panel .reading').textContent;
        if (/[0-9]/.test(txt)) errs.push('أرقام غير هندية في القراءة: ' + txt);
      }
    }
    /* تمرين القدرات والكشف من الأزرار نفسها */
    if (G.phase === 'round' && p.role === 'chaser') {
      const cb = d.querySelector('#turn-panel input[type=checkbox]');
      if (cb && !cb.checked && rng() < 0.45) { cb.checked = true; cb.dispatchEvent(new w.Event('change', { bubbles: true })); stats.shares++; }
      if (!G.pinpoint.used && rng() < 0.12) { const b = [...d.querySelectorAll('#turn-panel button')].find(b => b.textContent.includes('تحديد الفريق الدقيق')); if (b) { click(b); click(b); if (G.pinpoint.used) stats.pinpoint = true; } }
    }
    if (G.phase === 'round' && p.role === 'fugitive' && !G.fake.used && rng() < 0.25) {
      const b = [...d.querySelectorAll('#turn-panel button')].find(b => b.textContent.includes('إشارة مزيفة'));
      if (b) { click(b); const t = [...d.querySelectorAll('#turn-panel button.small')].find(b => !b.classList.contains('ghost')); if (t) { click(t); if (G.fake.used) stats.fake = true; } }
    }
    /* اختيار الوجهة: عشوائي، والمطارد أحيانًا يقترب من الهارب (بوت اختبار يعرف الحقيقة) */
    let target;
    if (G.phase === 'place') target = legal[Math.floor(rng() * legal.length)];
    else if (p.role === 'chaser' && rng() < cfg.smart) { const f = E.fugitive(G).pos; target = legal.slice().sort((a, b) => hopsTo(M, a, f) - hopsTo(M, b, f))[0]; }
    else target = rng() < 0.65 ? legal[Math.floor(rng() * legal.length)] : p.pos;
    posBefore.set(p.id, p.pos);
    if (target !== p.pos || G.phase === 'place') {
      click(d.querySelector(`#map-turn path.u[data-mode="${G.mode}"][data-id="${target}"]`));
      const info = d.querySelector('#map-turn .map-info').textContent;
      if (!info.includes(M.by.get(target).name)) errs.push('شريط المعلومات لا يعرض الوجهة المختارة');
    }
    const btn = [...d.querySelectorAll('#turn-panel button')].find(b => (target === p.pos && G.phase !== 'place') ? b.textContent.startsWith('اثبت') : (b.textContent.startsWith('تثبيت') || b.textContent.startsWith('تحرّك')));
    const roundNow = G.round, phaseNow = G.phase;
    click(btn);
    if (p.pos !== target) { errs.push(`الحركة لم تُطبَّق: ${p.name} → ${target}`); break; }
    if (phaseNow === 'round' && posBefore.get(p.id) !== target) { stats.moves++; if (!M.by.get(posBefore.get(p.id)).adj.includes(target)) errs.push('حركة إلى غير جار'); }
    if (!G.curtain && G.phase !== 'summary' && G.phase !== 'over') errs.push('الستار لم يُسدل بعد إنهاء الدور');
    if (G.round !== roundNow && G.phase === 'summary') lastRound = roundNow;
  }
  /* فحوص النهاية */
  if (G.phase !== 'over') errs.push('المباراة لم تنتهِ');
  const f = E.fugitive(G);
  const onF = E.chasers(G).filter(c => c.pos === f.pos);
  if (G.winner === 'chasers' && !onF.length) errs.push('فوز المطاردين بلا أحد في موقع الهارب');
  if (G.winner === 'fugitive' && onF.length) errs.push('فوز الهارب رغم وجود مطارد في موقعه');
  if (G.winner === 'fugitive' && G.round !== G.maxRounds) errs.push(`فوز الهارب قبل انتهاء الجولات (${G.round}/${G.maxRounds})`);
  if (G.winner === 'chasers' && G.captors.some(id => E.byId(G, id).pos !== f.pos)) errs.push('قابض ليس في موقع الهارب');
  for (let i = 1; i < G.trail.length; i++) { const a = G.trail[i - 1].pos, b = G.trail[i].pos; if (a !== b && !M.by.get(a).adj.includes(b)) errs.push('الهارب قفز إلى غير جار'); }
  if (!vis('s-over')) errs.push('شاشة النهاية غير ظاهرة');
  if (![...d.querySelectorAll('#map-over .dot')].length) errs.push('الكشف الكامل بلا نقاط');
  stats.reports = G.reports.length;
  return { G, errs, stats, mode: G.mode, rounds: G.round, maxRounds: G.maxRounds, winner: G.winner, n: cfg.n };
}
const matchRows = [];
const configs = [];
for (const n of [3, 7, 12, 20]) for (const mode of ['auto', 'regions', 'units']) for (let s = 1; s <= (mode === 'auto' ? 3 : 1); s++) configs.push({ n, mode, seed: n * 100 + s + (mode === 'units' ? 50 : mode === 'regions' ? 70 : 0), smart: s === 1 ? 0.55 : s === 2 ? 0 : 0.2 });
let simFail = 0, totalTurns = 0;
for (const cfg of configs) {
  let r;
  try { r = playMatch(cfg); } catch (e) { r = { errs: ['استثناء: ' + (e.stack || e).toString().slice(0, 400)], stats: {}, mode: cfg.mode, n: cfg.n }; }
  if (r.errs.length) simFail++;
  totalTurns += r.stats.turns || 0;
  matchRows.push({ cfg, r });
  console.log(`  مباراة: ${cfg.n} لاعبين · ${cfg.mode}→${r.mode} · بذرة ${cfg.seed} · ذكاء ${cfg.smart} · جولات ${r.rounds}/${r.maxRounds} · الفائز ${r.winner} · أدوار ${r.stats.turns} · حركات ${r.stats.moves} · كشف ${r.stats.shares} · تحديد ${r.stats.pinpoint ? 'نعم' : 'لا'} · مزيفة ${r.stats.fake ? 'نعم' : 'لا'} · بلاغات ${r.stats.reports} · تفتيش ${r.stats.checkpoints}${r.errs.length ? ' · أخطاء: ' + r.errs.slice(0, 3).join(' / ') : ''}`);
}
check(`محاكاة ${configs.length} مباراة كاملة من الواجهة (٣/٧/١٢/٢٠ لاعبًا، بالنمطين) بلا خرق للقواعد — ${totalTurns} دورًا`, simFail === 0, simFail ? `${simFail} مباراة فيها أخطاء` : '');
check('الفائزون شملوا الطرفين عبر المحاكاة', matchRows.some(m => m.r.winner === 'chasers') && matchRows.some(m => m.r.winner === 'fugitive'));
check('القدرات (تحديد دقيق / إشارة مزيفة) والكشف تمرّنت في المحاكاة', matchRows.some(m => m.r.stats.pinpoint) && matchRows.some(m => m.r.stats.fake) && matchRows.some(m => m.r.stats.shares > 0));
check('الأحداث (بلاغ / نقطة تفتيش) ظهرت في المحاكاة', matchRows.some(m => m.r.stats.reports > 0) && matchRows.some(m => m.r.stats.checkpoints > 0));
check('النمط التلقائي: ≤٦ لاعبين مناطق، ≥٧ محافظات', matchRows.filter(m => m.cfg.mode === 'auto').every(m => m.r.mode === (m.cfg.n >= 7 ? 'units' : 'regions')));
check('الجولات الافتراضية: ٨ للمناطق و١٢ للمحافظات', matchRows.filter(m => m.cfg.mode === 'auto').every(m => m.r.maxRounds === (m.r.mode === 'units' ? 12 : 8)));
check('لا أخطاء JS أثناء المحاكاة', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

/* ═══ ٥. القبض وانتهاء الجولات ونقطة التفتيش (المحرّك مباشرة) ═══ */
{
  const w = dom0.window, H = w.HARIB, E = H.Engine; H.setRng(mulberry32(3));
  const M = H.MAPS.units;
  const A = 'al-kharj', B = M.by.get(A).adj[0], FAR = 'tabuk';
  const mk = () => { const G = E.newGame({ names: ['هارب', 'مطارد١', 'مطارد٢'], mode: 'units', rounds: 4, fugitive: 0, reports: false, checkpoints: false }); E.commit(G, E.byId(G, 'p1'), A); E.commit(G, E.byId(G, 'p2'), B); E.commit(G, E.byId(G, 'p3'), FAR); return G; };
  let G = mk();
  check('بعد التمركز: القراءات محسوبة وليست دقيقة', E.chasers(G).every(c => c.reading && !c.reading.exact && c.reading.lo < c.reading.t && c.reading.t < c.reading.hi));
  E.startRound(G); E.commit(G, E.byId(G, 'p1'), A); E.commit(G, E.byId(G, 'p2'), B); E.commit(G, E.byId(G, 'p3'), FAR);
  check('مطارد في محافظة مجاورة (لا نفسها) → لا قبض', G.phase === 'summary' && !G.winner);
  E.startRound(G); E.commit(G, E.byId(G, 'p1'), A); E.commit(G, E.byId(G, 'p2'), A); E.commit(G, E.byId(G, 'p3'), FAR);
  check('مطارد يصل إلى نفس المحافظة في نهاية الجولة → قبض وفوز الفريق', G.phase === 'over' && G.winner === 'chasers' && G.captors.length === 1 && G.captors[0] === 'p2');
  G = mk();
  for (let r = 1; r <= 4; r++) { E.startRound(G); E.commit(G, E.byId(G, 'p1'), A); E.commit(G, E.byId(G, 'p2'), B); E.commit(G, E.byId(G, 'p3'), FAR); }
  check('انتهاء الجولات المحدودة (٤) بلا قبض → الهارب يفوز تلقائيًا', G.phase === 'over' && G.winner === 'fugitive' && G.round === 4);
  G = mk(); E.startRound(G);
  let threw = false; try { E.commit(G, E.byId(G, 'p1'), FAR); } catch (e) { threw = true; }
  check('الهارب لا يستطيع القفز إلى غير جار', threw && E.byId(G, 'p1').pos === A);
  G.closed = B; G.closedRound = G.round;
  check('نقطة تفتيش على جار: الهارب لا يدخلها', !E.legalTargets(G, E.byId(G, 'p1')).has(B) && E.legalTargets(G, E.byId(G, 'p1')).size === M.by.get(A).adj.length);
  G.closed = A;
  check('نقطة تفتيش على موقع الهارب: لا يخرج منها', E.legalTargets(G, E.byId(G, 'p1')).size === 1);
  G.closed = null; G.closedRound = null;
  E.commit(G, E.byId(G, 'p1'), A);
  const p2 = E.byId(G, 'p2');
  check('تحديد دقيق: قراءة واحدة تصير دقيقة ومكشوفة، ولا يتكرر للفريق', E.usePinpoint(G, p2) && p2.reading.exact && p2.share && !E.usePinpoint(G, E.byId(G, 'p3')) && G.pinpoint.by === 'p2');
  const G2 = mk(); E.startRound(G2);
  check('إشارة مزيفة: مرة واحدة، والقراءة الكاذبة تُسجَّل للهدف', E.useFake(G2, E.byId(G2, 'p1'), 'p3') && !E.useFake(G2, E.byId(G2, 'p1'), 'p2') && (E.commit(G2, E.byId(G2, 'p1'), A), E.commit(G2, E.byId(G2, 'p2'), B), E.commit(G2, E.byId(G2, 'p3'), FAR), E.byId(G2, 'p3').reading.fake != null && E.byId(G2, 'p2').reading.fake == null));
  check('نص القراءة بأرقام هندية ونطاق', /^بين [٠-٩]+ و[٠-٩]+ كم$/.test(E.readingText({ lo: 60, hi: 80 })) && E.readingText({ exact: true, t: 237.4 }) === '٢٣٧ كم بالضبط');
  check('عدد اللاعبين خارج ٣-٢٠ مرفوض', (() => { try { E.newGame({ names: ['a', 'b'] }); return false; } catch (e) { return true; } })() && (() => { try { E.newGame({ names: new Array(21).fill('x') }); return false; } catch (e) { return true; } })());
}

/* ═══ ٦. حقن الأسماء ═══ */
{
  const evil = ['<img src=x onerror=alert(1)>', '"><script>alert(2)</script>', 'يحيى‮abc‏', 'ك'.repeat(60), '   ', 'javascript:alert(3)'];
  const dom = makeDom(); const w = dom.window, d = w.document, H = w.HARIB;
  const scriptsBefore = d.querySelectorAll('script').length;
  const click = e => e.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  click(d.querySelector('[data-act=new]'));
  while (H.setup.names.length < evil.length) click(d.querySelector('[data-act=add-player]'));
  d.querySelectorAll('#setup-players input').forEach((inp, i) => { inp.value = evil[i]; inp.dispatchEvent(new w.Event('input', { bubbles: true })); });
  click(d.querySelector('[data-act=start]'));
  click(d.querySelector('[data-act=reveal]'));
  const names = H.G.players.map(p => p.name);
  check('لا عناصر img/script أُنشئت من أسماء خبيثة', d.querySelectorAll('img').length === 0 && d.querySelectorAll('script').length === scriptsBefore);
  check('الأسماء منقّاة: بلا < > & " \' ` ومحارف اتجاه، وبطول ≤ ٢٠', names.every(n => !/[<>&"'`\\‮‏​]/.test(n) && n.length <= 20 && n.trim().length > 0), names.join(' | '));
  check('الاسم الفارغ يُعوَّض باسم افتراضي', names[4] === 'لاعب ٥');
  check('اسم اللاعب يُعرض نصًّا لا ترميزًا', d.querySelector('#turn-name').textContent === H.G.players.find(p => p.id === H.G.queue[0]).name);
  check('لا alert استُدعيت', !jsErrors.some(e => e.includes('alert')));
}

/* ═══ التقرير ═══ */
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const md = [`# تقرير اختبارات «الهارب» — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, '',
  `النتيجة: **${failures === 0 ? 'كل الاختبارات ناجحة' : failures + ' اختبار فشل'}** — ${results.length} فحصًا في ${secs} ث (node ${process.version}, jsdom ${require('jsdom/package.json').version})`, '',
  '| # | الفحص | النتيجة | تفاصيل |', '|--|--|--|--|',
  ...results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.ok ? '✔' : '✘'} | ${r.detail.replace(/\|/g, '/')} |`), '',
  '## المباريات المحاكاة', '', '| لاعبون | النمط المطلوب → الفعلي | بذرة | بوت المطارد | جولات | الفائز | أدوار | حركات | كشف | تحديد | مزيفة | بلاغات | تفتيش | أخطاء |', '|--|--|--|--|--|--|--|--|--|--|--|--|--|--|',
  ...matchRows.map(({ cfg, r }) => `| ${cfg.n} | ${cfg.mode} → ${r.mode} | ${cfg.seed} | ${cfg.smart ? 'يقترب ' + Math.round(cfg.smart * 100) + '٪' : 'عشوائي'} | ${r.rounds}/${r.maxRounds} | ${r.winner === 'chasers' ? 'المطاردون' : r.winner === 'fugitive' ? 'الهارب' : '—'} | ${r.stats.turns || 0} | ${r.stats.moves || 0} | ${r.stats.shares || 0} | ${r.stats.pinpoint ? 'نعم' : 'لا'} | ${r.stats.fake ? 'نعم' : 'لا'} | ${r.stats.reports || 0} | ${r.stats.checkpoints || 0} | ${r.errs.length ? r.errs.join(' / ').replace(/\|/g, '/') : '—'} |`), ''].join('\n');
fs.writeFileSync(path.join(__dirname, 'test-report.md'), md);
console.log(`\n${failures === 0 ? 'كل الاختبارات ناجحة' : failures + ' اختبار فشل'} — ${results.length} فحصًا في ${secs} ث · التقرير: test-report.md`);
process.exit(failures ? 1 : 0);
