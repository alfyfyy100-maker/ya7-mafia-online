#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   build-geo.js — يبني بيانات خريطة «الهارب» من مصادر حقيقية فقط.

   القاعدة الصارمة: لا إحداثية واحدة تُقدَّر من الذاكرة. كل نقطة ومضلّع
   هنا يأتي من ملف مصدر يمكن لأي أحد تنزيله ومراجعته:

   ١. geoBoundaries (gbOpen) للسعودية — حدود OpenStreetMap الإدارية:
        ADM0 حدود الدولة، ADM1 المناطق الـ١٣، ADM2 المحافظات (١٤٧ وحدة في
        لقطة OSM المبنية في ديسمبر ٢٠٢٣). المضلّعات كاملة (Multipolygon).
        الرخصة: ODbL / CC-BY-SA — © مساهمو OpenStreetMap.
   ٢. حزمة npm «saudi-national-address» — بيانات العنوان الوطني (SPL):
        المناطق الـ١٣ بمضلّعاتها الرسمية وأسمائها العربية، و٤٥٨١ مدينة
        بمركزها (خط عرض/طول) واسمها العربي والإنجليزي. تُستخدم لأسماء
        المحافظات العربية ونقطة «مقرّ المحافظة» (مدينتها الرئيسية).

   ما يُحسب حسابيًا (لا يدويًا):
   - المنطقة الأم لكل محافظة: احتواء نقطة داخل مضلّع المنطقة الرسمي.
   - الفجوات: فرق مضلّع الدولة عن اتحاد المحافظات (مثل ثغرة الدمام/الظهران
     في لقطة OSM) — تُملأ من الهندسة نفسها، ولا تُرسم بالتخمين.
   - الجوار: الأقواس المشتركة في الطوبولوجيا + تقارب الرؤوس + جسور تربط
     أي جزيرة أو مكوّن منفصل بأقرب جار حتى يصير الرسم البياني متصلًا.
   - الإسقاط: مستوي بتصحيح cos(lat) — الوحدة كيلومتر تقريبًا — والمسافات
     في اللعبة تُحسب بمعادلة Haversine على خط العرض/الطول لا على المستوي.
   - التبسيط: Visvalingam عبر TopoJSON فتبقى الحدود المشتركة متطابقة بين
     الجيران (بلا شقوق ولا تراكب) ثم تُكتب مسارات SVG مضغوطة.

   التشغيل:  npm install && node build-geo.js
   الناتج:   geo-data.json هنا، ويُحقن تلقائيًا داخل ../index.html بين
             العلامتين GEO-DATA-START / GEO-DATA-END إن وُجدتا.
   ═══════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const { topology } = require('topojson-server');
const { feature, merge, neighbors } = require('topojson-client');
const { presimplify, simplify, filter, filterAttachedWeight, planarTriangleArea, planarRingArea } = require('topojson-simplify');
const polylabel = (m => m.default || m)(require('polylabel'));
const pc = (m => m.default || m)(require('polygon-clipping'));

const HERE = __dirname;
const RAW = path.join(HERE, 'raw');
const OUT_JSON = path.join(HERE, 'geo-data.json');
const OUT_REPORT = path.join(HERE, 'geo-report.md');
const HTML = path.join(HERE, '..', 'index.html');

const GB = 'https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/main/releaseData/gbOpen/SAU/';
const SOURCES = {
  'geoBoundaries-SAU-ADM0.geojson': GB + 'ADM0/geoBoundaries-SAU-ADM0.geojson',
  'geoBoundaries-SAU-ADM1.geojson': GB + 'ADM1/geoBoundaries-SAU-ADM1.geojson',
  'geoBoundaries-SAU-ADM2.geojson': GB + 'ADM2/geoBoundaries-SAU-ADM2.geojson',
};

/* ── ثوابت الإسقاط والتبسيط ──
   LAT0 خط العرض المرجعي لتصحيح cos(lat)، وKM_DEG طول الدرجة بالكيلومتر.
   SIMPLIFY_KM2 مساحة المثلث الدنيا (Visvalingam) — كلما صغرت زادت الدقة
   والحجم. MIN_ISLAND_KM2 يُسقط الجزيرات الصغيرة غير الملتصقة بأي حد.
   NEAR_KM حد التقارب الذي يُعدّ به مضلّعان جارَين ولو لم يتشاركا قوسًا. */
const LAT0 = 24.5;
const KM_DEG = 111.32;
const SIMPLIFY_KM2 = 1.6;
const MIN_ISLAND_KM2 = 6;
const NEAR_KM = 0.8;
const GAP_MIN_KM2 = 150;
const SEAT_MAX_KM = 4;        // مقرّ المحافظة يُقبل لو كان داخل مضلّعها أو على بعد ≤ هذا (سواحل)

/* ── أسماء عربية للعرض حين لا يطابق الاسم الإنجليزي في OSM اسم المدينة في
   بيانات العنوان الوطني (اختلاف نقحرة فقط). القيمة تُطابَق مع مدينة SPL
   داخل مضلّع المحافظة نفسه، فلا تُقبل إلا إن وُجدت فعلًا هناك. ── */
const NAME_OVERRIDES = {
  'Al Khubar Governorate': 'الخبر', 'Abqaiq Governorate': 'بقيق', 'Al Udayd Governorate': 'العديد',
  'Al Jubayl Governorate': 'الجبيل', 'Qaryah Al Ulya Governorate': 'قرية العليا',
  'Uyun Al Jiwa': 'عيون الجواء', 'Riyadh Al Khabra': 'رياض الخبراء', 'Buraydah': 'بريدة',
  'Turayf': 'طريف', 'Al Uwayqilah': 'العويقيلة', 'Dawamat Al Jandal': 'دومة الجندل', 'Haqil': 'حقل',
  'Wadi Al Fara': 'وادي الفرع', 'Al Qunfudhah': 'القنفذة', 'Jiddah': 'جدة', 'Turubah': 'تربة',
  'Al Ardiyat': 'العرضيات', 'Adam': 'أضم', 'Al Harth': 'الحرث', 'Ahad Al Masarihah': 'أحد المسارحة',
  'Baysh': 'بيش', 'Zahran Al Janub': 'ظهران الجنوب', 'Ahad Rufaydah': 'أحد رفيدة', 'Al Harjah': 'الحرجة',
  'Khubash': 'خباش', 'Bahrah': 'بحرة', 'Al Mahd': 'مهد الذهب', 'Rijal Al Ma': 'رجال ألمع', 'Duba': 'ضباء',
};
/* مقرّ المحافظة حين يختلف اسمه عن اسمها (نقطة الإرساء تؤخذ من مدينة SPL) */
const SEAT_OVERRIDES = {
  'Al Harth': 'الخوبة', 'Wadi Al Fara': 'الفرع', 'Al Uwayqilah': 'العويقلية', 'Khubash': 'بئر خباش',
  'Bahrah': 'بحرة المجاهدين', 'Duba': 'ضبا', 'Rijal Al Ma': 'رجال المع',
};
/* تصحيح همزات فقط لأسماء العرض القادمة من SPL (الإحداثيات لا تتغير) */
const SPELLING = {
  'الاحساء': 'الأحساء', 'ابها': 'أبها', 'الافلاج': 'الأفلاج', 'املج': 'أملج', 'ابو عريش': 'أبو عريش',
  'الاسياح': 'الأسياح', 'راس تنورة': 'رأس تنورة', 'تربه': 'تربة', 'اضم': 'أضم', 'احد رفيده': 'أحد رفيدة',
  'احد المسارحة': 'أحد المسارحة', 'بلجرشي': 'بلجرشي',
};
/* فجوات معروفة في لقطة OSM تُملأ من الهندسة (فرق مضلّع الدولة عن اتحاد
   المحافظات) — لا تُضاف وحدة إلا إن وُجدت مدينة مقرّها داخل الفجوة فعلًا. */
const GAP_UNITS = [{ en: 'Dammam', name: 'الدمام', seat: 'الدمام' }];

/* المناطق: رمز SPL → اسم العرض المختصر (المشتق من الاسم الرسمي حسابيًا
   بحذف «منطقة»)، وعاصمتها تؤخذ من regions.center في بيانات SPL. */

/* ═════════════════════════ أدوات هندسية ═════════════════════════ */
const polys = g => g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
function bboxOf(coordsList) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of coordsList) for (const r of p) for (const [x, y] of r) {
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
  }
  return b;
}
function pip(pt, ring) {
  const x = pt[0], y = pt[1]; let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function inPolys(pt, coordsList, bb) {
  if (bb && (pt[0] < bb[0] || pt[0] > bb[2] || pt[1] < bb[1] || pt[1] > bb[3])) return false;
  for (const p of coordsList) {
    if (pip(pt, p[0])) { let hole = false; for (let i = 1; i < p.length; i++) if (pip(pt, p[i])) { hole = true; break; } if (!hole) return true; }
  }
  return false;
}
const rad = d => d * Math.PI / 180;
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
/* الإسقاط: x شرقًا بالكيلومتر مع تصحيح cos(lat0)، y جنوبًا بالكيلومتر */
let LON0 = 0, LATTOP = 0;
const proj = ([lon, lat]) => [(lon - LON0) * Math.cos(rad(LAT0)) * KM_DEG, (LATTOP - lat) * KM_DEG];
const projGeom = g => ({ type: g.type, coordinates: g.type === 'Polygon' ? g.coordinates.map(r => r.map(proj)) : g.coordinates.map(p => p.map(r => r.map(proj))) });
function ringAreaKm2(ring) { // على المستوي المُسقَط (كم²)
  let a = 0; for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(a) / 2;
}
function polyAreaKm2(projCoordsList) {
  let a = 0; for (const p of projCoordsList) { a += ringAreaKm2(p[0]); for (let i = 1; i < p.length; i++) a -= ringAreaKm2(p[i]); }
  return a;
}
function largestPoly(coordsList, projected) {
  let best = null, bestA = -1;
  for (const p of coordsList) { const a = ringAreaKm2(projected ? p[0] : p[0].map(proj)); if (a > bestA) { bestA = a; best = p; } }
  return best;
}
/* أقرب مسافة (كم على المستوي) بين نقطة ومجموعة رؤوس */
function minVertexDist(pt, coordsList) {
  let best = Infinity;
  for (const p of coordsList) for (const r of p) for (const v of r) { const d = Math.hypot(v[0] - pt[0], v[1] - pt[1]); if (d < best) best = d; }
  return best;
}
/* أقرب مسافة بين رؤوس مضلّعين (مع تصفية بالصندوق المحيط) */
function minPolyDist(A, B, limit) {
  let best = Infinity;
  const bb = bboxOf(B);
  const cells = new Map();
  const cs = limit;
  for (const p of B) for (const r of p) for (const v of r) {
    const k = Math.floor(v[0] / cs) + ':' + Math.floor(v[1] / cs);
    let c = cells.get(k); if (!c) cells.set(k, c = []); c.push(v);
  }
  for (const p of A) for (const r of p) for (const v of r) {
    if (v[0] < bb[0] - limit || v[0] > bb[2] + limit || v[1] < bb[1] - limit || v[1] > bb[3] + limit) continue;
    const cx = Math.floor(v[0] / cs), cy = Math.floor(v[1] / cs);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const c = cells.get((cx + dx) + ':' + (cy + dy)); if (!c) continue;
      for (const w of c) { const d = Math.hypot(v[0] - w[0], v[1] - w[1]); if (d < best) { best = d; if (best === 0) return 0; } }
    }
  }
  return best;
}
const normEn = s => s.toLowerCase().replace(/governorate/g, '').replace(/[’'`\-.]/g, '')
  .replace(/\b(al|ar|as|ad|an|at|ash|ath|az)\s+/g, '').replace(/\s+/g, ' ').trim();
const normAr = s => s.replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[\sـ]/g, '');
const slug = s => s.toLowerCase().replace(/governorate/g, '').replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ═════════════════════════ التحميل ═════════════════════════ */
async function ensureRaw() {
  fs.mkdirSync(RAW, { recursive: true });
  for (const [name, url] of Object.entries(SOURCES)) {
    const f = path.join(RAW, name);
    if (fs.existsSync(f) && fs.statSync(f).size > 10000) continue;
    process.stdout.write(`تنزيل ${name} … `);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`فشل تنزيل ${url}: ${res.status}`);
    fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
    console.log('تم');
  }
}

async function main() {
  const t0 = Date.now();
  await ensureRaw();
  const adm0 = JSON.parse(fs.readFileSync(path.join(RAW, 'geoBoundaries-SAU-ADM0.geojson')));
  const adm1 = JSON.parse(fs.readFileSync(path.join(RAW, 'geoBoundaries-SAU-ADM1.geojson')));
  const adm2 = JSON.parse(fs.readFileSync(path.join(RAW, 'geoBoundaries-SAU-ADM2.geojson')));
  const sna = path.join(HERE, 'node_modules', 'saudi-national-address', 'data');
  const cities = JSON.parse(fs.readFileSync(path.join(sna, 'cities.lite.json')));
  const regionsSpl = JSON.parse(fs.readFileSync(path.join(sna, 'regions.lite.json')));
  const regionsGeo = JSON.parse(fs.readFileSync(path.join(sna, 'regions.geojson')));
  const report = [];
  const log = s => { console.log(s); report.push(s); };
  log(`# تقرير بناء بيانات الخريطة — ${new Date().toISOString()}`);
  log(`- ADM0: ${adm0.features.length} · ADM1: ${adm1.features.length} · ADM2: ${adm2.features.length} وحدة (OSM عبر geoBoundaries)`);
  log(`- SPL: ${regionsSpl.length} منطقة · ${cities.length} مدينة`);

  /* حدود الإسقاط من مضلّع الدولة */
  const adm0Polys = polys(adm0.features[0].geometry).map(p => p.map(r => r.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)])));
  const bb0 = bboxOf(adm0Polys);
  LON0 = bb0[0]; LATTOP = bb0[3];
  const [W, H] = proj([bb0[2], bb0[1]]).map(v => Math.ceil(v));
  log(`- الإسقاط: lat0=${LAT0}° · العرض ${W} كم × الارتفاع ${H} كم (مستوي بتصحيح cos)`);

  /* ═══ ١. الوحدات الخام من ADM2 ═══ */
  /* تقريب الإحداثيات إلى ٦ منازل (≈ ١٠ سم): يثبّت خوارزمية القصّ (polygon-clipping
     تفشل على رؤوس شبه متطابقة) ويضمن أن رؤوس وحدة الفجوة تطابق رؤوس جيرانها
     بالضبط فتتشارك الأقواس في الطوبولوجيا. */
  const r6 = coords => coords.map(p => p.map(r => r.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)])));
  const units = adm2.features.map(f => ({ en: f.properties.shapeName.trim(), coords: r6(polys(f.geometry)) }));

  /* ═══ ٢. الفجوات: الدولة − اتحاد المحافظات ═══ */
  const tg = Date.now();
  let gaps = [];
  try {
    const diff = pc.difference(adm0Polys, ...units.map(u => u.coords));
    for (const p of diff) {
      const area = polyAreaKm2([p.map(r => r.map(proj))]);
      if (area < 5) continue;
      const bb = bboxOf([p]);
      const inside = cities.filter(c => inPolys([c.center[1], c.center[0]], [p], bb));
      gaps.push({ coords: [p], area, inside });
    }
  } catch (e) { log(`! فشل حساب الفجوات: ${e.message}`); }
  gaps.sort((a, b) => b.area - a.area);
  log(`- الفجوات (≥٥ كم²) بعد ${((Date.now() - tg) / 1000).toFixed(1)} ث: ${gaps.length}`);
  for (const g of gaps.slice(0, 12)) log(`  · ${g.area.toFixed(0)} كم² — مدن: ${g.inside.slice(0, 6).map(c => c.name_ar).join('، ') || '—'}`);
  const gapAdded = [];
  for (const gu of GAP_UNITS) {
    const g = gaps.find(g => g.area >= GAP_MIN_KM2 && g.inside.some(c => normAr(c.name_ar) === normAr(gu.seat)));
    if (!g) { log(`! لم تُوجد فجوة تحوي «${gu.seat}» — لم تُضف ${gu.name}`); continue; }
    units.push({ en: gu.en, coords: g.coords, ar: gu.name, seatName: gu.seat, gap: true });
    gapAdded.push(`${gu.name} (${g.area.toFixed(0)} كم²)`);
  }
  log(`- وحدات أُضيفت من الفجوات: ${gapAdded.join('، ') || 'لا شيء'}`);
  const bigUnnamed = gaps.filter(g => g.area >= GAP_MIN_KM2 && !GAP_UNITS.some(gu => g.inside.some(c => normAr(c.name_ar) === normAr(gu.seat))));
  if (bigUnnamed.length) log(`! فجوات كبيرة بلا وحدة (راجعها): ${bigUnnamed.map(g => g.area.toFixed(0) + ' كم² [' + g.inside.slice(0, 3).map(c => c.name_ar).join('، ') + ']').join(' · ')}`);

  /* ═══ ٣. المنطقة الأم + الاسم العربي + نقطة المقرّ ═══ */
  const regBB = regionsGeo.features.map(f => bboxOf(polys(f.geometry)));
  const adm1BB = adm1.features.map(f => bboxOf(polys(f.geometry)));
  const isoToCode = {}; // ISO في OSM → رمز SPL (للمقارنة فقط) — يُشتق من احتواء عاصمة المنطقة
  for (const r of regionsSpl) {
    const pt = [r.center[1], r.center[0]];
    const f = adm1.features.find((f, i) => inPolys(pt, polys(f.geometry), adm1BB[i]));
    if (f) isoToCode[f.properties.shapeISO] = r.code;
  }
  const cityByAr = new Map();
  for (const c of cities) { const k = normAr(c.name_ar); if (!cityByAr.has(k)) cityByAr.set(k, []); cityByAr.get(k).push(c); }
  const disagreements = [], unresolved = [], fallbackSeats = [];
  const usedIds = new Set();
  for (const u of units) {
    u.projCoords = u.coords.map(p => p.map(r => r.map(proj)));
    u.bb = bboxOf(u.coords);
    u.areaKm2 = polyAreaKm2(u.projCoords);
    const big = largestPoly(u.coords, false);
    const rep = polylabel(big, 0.001);
    u.rep = [rep[0], rep[1]];
    /* المنطقة: مضلّع SPL الرسمي أولًا، ثم OSM ADM1، ثم أقرب مضلّع SPL */
    let ri = regionsGeo.features.findIndex((f, i) => inPolys(u.rep, polys(f.geometry), regBB[i]));
    let how = 'SPL';
    if (ri < 0) {
      const f1 = adm1.features.findIndex((f, i) => inPolys(u.rep, polys(f.geometry), adm1BB[i]));
      if (f1 >= 0) { const code = isoToCode[adm1.features[f1].properties.shapeISO]; ri = regionsGeo.features.findIndex(f => f.properties.code === code); how = 'OSM'; }
    }
    if (ri < 0) {
      let best = Infinity;
      regionsGeo.features.forEach((f, i) => { const d = minVertexDist(proj(u.rep), polys(f.geometry).map(p => p.map(r => r.map(proj)))); if (d < best) { best = d; ri = i; } });
      how = 'nearest';
    }
    u.region = regionsGeo.features[ri].properties.code;
    u.regionHow = how;
    const f1 = adm1.features.findIndex((f, i) => inPolys(u.rep, polys(f.geometry), adm1BB[i]));
    const osmCode = f1 >= 0 ? isoToCode[adm1.features[f1].properties.shapeISO] : '?';
    if (osmCode !== u.region) disagreements.push(`${u.en}: SPL=${u.region} / OSM=${osmCode} → اعتُمد SPL`);

    /* الاسم العربي */
    const insideCities = cities.filter(c => inPolys([c.center[1], c.center[0]], u.coords, u.bb));
    if (!u.ar) {
      const ov = NAME_OVERRIDES[u.en];
      if (ov) u.ar = ov;
      else {
        const k = normEn(u.en);
        let m = insideCities.filter(c => normEn(c.name_en) === k);
        if (!m.length) m = insideCities.filter(c => normEn(c.name_en).includes(k) || k.includes(normEn(c.name_en)));
        if (m.length) u.ar = m[0].name_ar; else { unresolved.push(u.en); u.ar = u.en; }
      }
    }
    u.ar = SPELLING[u.ar] || u.ar;
    /* نقطة المقرّ: مدينة SPL بالاسم داخل المضلّع أو على مسافة ≤ SEAT_MAX_KM */
    const seatName = u.seatName || SEAT_OVERRIDES[u.en] || u.ar;
    const cands = cityByAr.get(normAr(seatName)) || [];
    let seat = cands.find(c => inPolys([c.center[1], c.center[0]], u.coords, u.bb));
    let seatHow = 'inside';
    if (!seat) {
      let best = Infinity;
      for (const c of cands) { const d = minVertexDist(proj([c.center[1], c.center[0]]), u.projCoords); if (d < best) { best = d; seat = c; } }
      if (seat && best <= SEAT_MAX_KM) seatHow = `near ${best.toFixed(1)}km`; else seat = null;
    }
    if (seat) { u.lat = seat.center[0]; u.lon = seat.center[1]; u.seatHow = seatHow; }
    else { u.lat = u.rep[1]; u.lon = u.rep[0]; u.seatHow = 'polylabel'; fallbackSeats.push(`${u.en} (${u.ar})`); }
    u.id = slug(u.en);
    if (usedIds.has(u.id)) u.id += '-2';
    usedIds.add(u.id);
  }
  log(`- خلافات المنطقة الأم بين SPL وOSM: ${disagreements.length ? disagreements.join(' · ') : 'لا شيء'}`);
  log(`- أسماء لم تُحلّ (بقيت إنجليزية): ${unresolved.length ? unresolved.join('، ') : 'لا شيء'}`);
  log(`- وحدات بلا مدينة مقرّ في SPL (أُخذ مركز المضلّع): ${fallbackSeats.length ? fallbackSeats.join('، ') : 'لا شيء'}`);
  const arDupes = units.map(u => u.ar).filter((a, i, arr) => arr.indexOf(a) !== i);
  if (arDupes.length) log(`! أسماء عربية مكررة: ${[...new Set(arDupes)].join('، ')}`);

  /* ═══ ٤. الطوبولوجيا الكاملة → الجوار الحقيقي (أقواس مشتركة) ═══ */
  const fc = { type: 'FeatureCollection', features: units.map(u => ({ type: 'Feature', properties: { id: u.id }, geometry: { type: 'MultiPolygon', coordinates: u.projCoords } })) };
  let topo = topology({ u: fc });
  const nb = neighbors(topo.objects.u.geometries);
  const adj = units.map(() => new Set());
  let sharedEdges = 0;
  nb.forEach((list, i) => list.forEach(j => { if (!adj[i].has(j)) sharedEdges++; adj[i].add(j); adj[j].add(i); }));
  log(`- جوار من الأقواس المشتركة: ${sharedEdges} حدًّا`);
  /* تقارب الرؤوس (مضلّعات متلاصقة بلا أقواس مطابقة) */
  let nearEdges = 0;
  for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
    if (adj[i].has(j)) continue;
    const a = units[i].projCoords, b = units[j].projCoords;
    const ba = bboxOf(a), bbb = bboxOf(b);
    if (ba[0] > bbb[2] + NEAR_KM || bbb[0] > ba[2] + NEAR_KM || ba[1] > bbb[3] + NEAR_KM || bbb[1] > ba[3] + NEAR_KM) continue;
    if (minPolyDist(a, b, NEAR_KM) <= NEAR_KM) { adj[i].add(j); adj[j].add(i); nearEdges++; }
  }
  log(`- جوار من تقارب الرؤوس (≤ ${NEAR_KM} كم): ${nearEdges} حدًّا`);
  /* الجسور: ربط المكوّنات المنفصلة بأقرب جار (بمسافة المقرّ Haversine) */
  const bridges = [];
  function components() {
    const comp = new Array(units.length).fill(-1); let n = 0;
    for (let s = 0; s < units.length; s++) { if (comp[s] >= 0) continue; const st = [s]; comp[s] = n; while (st.length) { const x = st.pop(); for (const y of adj[x]) if (comp[y] < 0) { comp[y] = n; st.push(y); } } n++; }
    return { comp, n };
  }
  const isolated = units.filter((u, i) => adj[i].size === 0).map(u => u.ar);
  log(`- وحدات بلا أي جار قبل الجسور: ${isolated.length ? isolated.join('، ') : 'لا شيء'}`);
  for (let guard = 0; guard < 200; guard++) {
    const { comp, n } = components();
    if (n === 1) break;
    let best = Infinity, bi = -1, bj = -1;
    for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
      if (comp[i] === comp[j]) continue;
      const d = haversine(units[i].lat, units[i].lon, units[j].lat, units[j].lon);
      if (d < best) { best = d; bi = i; bj = j; }
    }
    adj[bi].add(bj); adj[bj].add(bi);
    bridges.push(`${units[bi].ar} ↔ ${units[bj].ar} (${best.toFixed(0)} كم)`);
  }
  log(`- جسور أُضيفت للاتصال: ${bridges.length ? bridges.join(' · ') : 'لا شيء'} → المكوّنات الآن: ${components().n}`);
  const degs = adj.map(s => s.size);
  log(`- درجات الجوار: أدنى ${Math.min(...degs)} · أعلى ${Math.max(...degs)} · متوسط ${(degs.reduce((a, b) => a + b, 0) / degs.length).toFixed(1)}`);

  /* ═══ ٥. التبسيط الطوبولوجي والمسارات ═══ */
  topo = presimplify(topo, planarTriangleArea);
  topo = simplify(topo, SIMPLIFY_KM2);
  topo = filter(topo, filterAttachedWeight(topo, MIN_ISLAND_KM2, planarRingArea));
  const simpFC = feature(topo, topo.objects.u);
  const r1 = v => Math.round(v * 10) / 10;
  function pathOf(geom) {
    const list = polys(geom); let d = '', verts = 0;
    for (const p of list) for (const ring of p) {
      const pts = ring.map(([x, y]) => [r1(x), r1(y)]);
      if (pts.length < 4 || ringAreaKm2(pts) < 0.05) continue;   // حلقات منهارة بعد التبسيط
      /* مسار نسبي: M ثم "l" واحدة تليها أزواج الفروق؛ السالب يفصل نفسه
         بإشارته فلا يحتاج فراغًا. (التسلسل نصّ دائمًا — جمع رقمين خطأ قديم) */
      const tok = v => (v < 0 ? '' : ' ') + String(v);
      let s = 'M' + pts[0][0] + ' ' + pts[0][1] + 'l';
      for (let i = 1; i < pts.length - 1; i++) {
        const dx = r1(pts[i][0] - pts[i - 1][0]), dy = r1(pts[i][1] - pts[i - 1][1]);
        s += tok(dx) + tok(dy);
        verts++;
      }
      d += s + 'z';
    }
    return { d, verts };
  }
  let totalVerts = 0;
  simpFC.features.forEach((f, i) => { const { d, verts } = pathOf(f.geometry); units[i].d = d; totalVerts += verts; });
  log(`- التبسيط: ${SIMPLIFY_KM2} كم² → ${totalVerts} رأسًا في مسارات المحافظات`);
  const emptyPaths = units.filter(u => !u.d).map(u => u.ar);
  if (emptyPaths.length) log(`! وحدات بلا مسار بعد التبسيط: ${emptyPaths.join('، ')}`);

  /* ═══ ٦. المناطق: دمج محافظاتها من الطوبولوجيا نفسها ═══ */
  const regions = regionsSpl.map(r => {
    const members = units.map((u, i) => u.region === r.code ? i : -1).filter(i => i >= 0);
    const geom = merge(topo, members.map(i => topo.objects.u.geometries[i]));
    const { d } = pathOf(geom);
    const big = largestPoly(polys(geom), true);
    const lp = polylabel(big, 0.5);
    const [x, y] = proj([r.center[1], r.center[0]]);
    const short = r.name_ar.replace(/^(منطقة|المنطقة)\s+/, '');
    return { id: r.code, name: short, full: r.name_ar, en: r.name_en, lat: r.center[0], lon: r.center[1], x: r1(x), y: r1(y), lx: r1(lp[0]), ly: r1(lp[1]), d, n: members.length, adj: new Set() };
  });
  /* جوار المناطق من جوار محافظاتها + جسور عند الحاجة */
  units.forEach((u, i) => { for (const j of adj[i]) if (units[j].region !== u.region) { const a = regions.find(r => r.id === u.region), b = regions.find(r => r.id === units[j].region); a.adj.add(b.id); b.adj.add(a.id); } });
  for (let guard = 0; guard < 20; guard++) {
    const seen = new Set(); const st = [regions[0].id]; seen.add(regions[0].id);
    while (st.length) { const x = st.pop(); for (const y of regions.find(r => r.id === x).adj) if (!seen.has(y)) { seen.add(y); st.push(y); } }
    if (seen.size === regions.length) break;
    let best = Infinity, pair = null;
    for (const a of regions) for (const b of regions) { if (seen.has(a.id) === seen.has(b.id)) continue; const d = haversine(a.lat, a.lon, b.lat, b.lon); if (d < best) { best = d; pair = [a, b]; } }
    pair[0].adj.add(pair[1].id); pair[1].adj.add(pair[0].id); log(`- جسر مناطق: ${pair[0].name} ↔ ${pair[1].name}`);
  }
  log(`- المناطق: ${regions.map(r => `${r.name} (${r.n}: ${[...r.adj].length} جار)`).join(' · ')}`);

  /* ═══ ٧. تحقق Haversine على مسافة معروفة ═══ */
  const riy = units.find(u => u.en === 'Riyadh'), jed = units.find(u => u.en === 'Jiddah');
  const dRJ = haversine(riy.lat, riy.lon, jed.lat, jed.lon);
  log(`- تحقق Haversine: الرياض ↔ جدة = ${dRJ.toFixed(1)} كم (المتوقع ≈ ٨٥٠-٨٧٠)`);
  if (!(dRJ > 800 && dRJ < 900)) throw new Error('مسافة الرياض-جدة خارج النطاق المتوقع — راجع الإسقاط أو الإحداثيات');
  const rR = regions.find(r => r.id === 'RD'), rM = regions.find(r => r.id === 'MQ');
  log(`- منطقة الرياض ↔ منطقة مكة (عاصمة لعاصمة): ${haversine(rR.lat, rR.lon, rM.lat, rM.lon).toFixed(1)} كم`);

  /* ═══ ٨. الكتابة ═══ */
  const out = {
    meta: {
      built: new Date().toISOString().slice(0, 10),
      sources: ['geoBoundaries gbOpen SAU ADM0/ADM1/ADM2 (OpenStreetMap, © OSM contributors, ODbL/CC-BY-SA) — build Dec 2023',
        'saudi-national-address 1.1.0 (SPL National Address: regions, cities, Arabic names)'],
      proj: { lat0: LAT0, lon0: LON0, latTop: LATTOP, kmDeg: KM_DEG },   // بدقة كاملة: الصفحة تُسقط بها نقاط الدوائر
      units: units.length, regions: regions.length, gapUnits: gapAdded, bridges,
    },
    view: [W, H],
    regions: regions.map(r => ({ id: r.id, name: r.name, full: r.full, en: r.en, lat: r.lat, lon: r.lon, x: r.x, y: r.y, lx: r.lx, ly: r.ly, adj: [...r.adj].sort(), d: r.d })),
    units: units.map((u, i) => { const [x, y] = proj([u.lon, u.lat]); return { id: u.id, name: u.ar, en: u.en, r: u.region, lat: +u.lat.toFixed(5), lon: +u.lon.toFixed(5), x: r1(x), y: r1(y), km2: Math.round(u.areaKm2), adj: [...adj[i]].map(j => units[j].id).sort(), d: u.d }; }),
  };
  const line = o => JSON.stringify(o);
  const json = '{\n"meta":' + JSON.stringify(out.meta, null, 1).replace(/\n\s*/g, ' ') + ',\n"view":' + line(out.view) +
    ',\n"regions":[\n' + out.regions.map(line).join(',\n') + '\n],\n"units":[\n' + out.units.map(line).join(',\n') + '\n]\n}\n';
  fs.writeFileSync(OUT_JSON, json);
  log(`- كُتب ${path.relative(process.cwd(), OUT_JSON)} (${(json.length / 1024).toFixed(0)} كيلوبايت)`);
  if (fs.existsSync(HTML)) {
    const html = fs.readFileSync(HTML, 'utf8');
    const A = '/*GEO-DATA-START*/', B = '/*GEO-DATA-END*/';
    const i = html.indexOf(A), j = html.indexOf(B);
    if (i >= 0 && j > i) {
      const injected = html.slice(0, i + A.length) + '\nconst GEO = ' + json.trim() + ';\n' + html.slice(j);
      fs.writeFileSync(HTML, injected);
      log(`- حُقنت البيانات داخل ${path.relative(process.cwd(), HTML)}`);
    } else log(`- لم تُوجد علامتا الحقن في index.html — لم يُعدَّل`);
  }
  /* جدول مراجعة الأسماء */
  log('\n## جدول الوحدات (للمراجعة)');
  log('| # | الاسم | OSM | المنطقة | المقرّ | كم² | جيران |');
  log('|--|--|--|--|--|--|--|');
  units.forEach((u, i) => log(`| ${i + 1} | ${u.ar} | ${u.en} | ${u.region} (${u.regionHow}) | ${u.seatHow} | ${Math.round(u.areaKm2)} | ${adj[i].size} |`));
  fs.writeFileSync(OUT_REPORT, report.join('\n') + '\n');
  console.log(`\nانتهى في ${((Date.now() - t0) / 1000).toFixed(1)} ث — التقرير في ${path.relative(process.cwd(), OUT_REPORT)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
