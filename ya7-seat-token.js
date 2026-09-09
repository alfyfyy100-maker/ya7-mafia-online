/*!
 * ya7-seat-token.js — جسر توكن المقعد
 * ----------------------------------------------------
 * يخلّي الواجهة القديمة تشتغل مع الـ worker الجديد بدون تعديل كود اللعبة.
 *
 * كيف يشتغل:
 *   ١) يلتقط seatToken / screenToken من رد /room/create ويخزّنه
 *   ٢) يلتقط seatToken من رسالة welcome ويخزّنه
 *   ٣) يضيف token= (و stoken= للشاشة) تلقائيًا لكل اتصال WebSocket
 *
 * التركيب: ضعه قبل </body> مباشرة، وقبل أي <script> فيه كود اللعبة:
 *   <script src="/ya7-seat-token.js"></script>
 *
 * الملفات المطلوبة: khawana, mafia, mawwih
 * (داقش يدير توكنه بنفسه، لكن مساره مدعوم هنا كذلك)
 * (فَطِن انتهت — أُزيل مسارها من الـ regex تحت)
 */
(function () {
  'use strict';

  // ── تخزين يتحمّل وضع التصفح الخاص ──
  var mem = {};
  function put(k, v) {
    mem[k] = v;
    try { localStorage.setItem(k, v); } catch (e) {}
  }
  function get(k) {
    try { var v = localStorage.getItem(k); if (v) return v; } catch (e) {}
    return mem[k] || '';
  }

  // مفتاح فريد لكل لعبة+غرفة (نفس الرمز قد يتكرر بين لعبتين)
  function keyFor(game, code, kind) {
    return 'ya7_' + (kind || 'seat') + '_' + (game || 'mafia') + '_' + String(code).toUpperCase();
  }

  // يستخرج (اللعبة، رمز الغرفة) من أي مسار غرفة
  //   /room/AB12CD/ws         -> ['mafia', 'AB12CD']
  //   /got/room/AB12CD/ws     -> ['got',   'AB12CD']
  //   /daqash/room/AB12CD/ws  -> ['daqash','AB12CD']
  function parseRoomPath(pathname) {
    var m = pathname.match(/^\/(got|mawwih|daqash)?\/?room\/([A-Z0-9]{6})\/ws$/i);
    if (!m) return null;
    return { game: (m[1] || 'mafia').toLowerCase(), code: m[2].toUpperCase() };
  }

  //   /room/create  ->  'mafia'      /daqash/room/create -> 'daqash'
  function parseCreatePath(pathname) {
    var m = pathname.match(/^\/(got|mawwih|daqash)?\/?room\/create$/i);
    if (!m) return null;
    return (m[1] || 'mafia').toLowerCase();
  }

  // ══════════ ١) التقاط التوكن من رد الإنشاء ══════════
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    /* ── التخزين يسبق عودة fetch، لا يلحقها ──
       كان `res.clone().json().then(put)` سلسلةً معلّقةً لا ينتظرها أحد،
       و`return res` يخرج قبل أن تكتمل. فتكمل الصفحة فورًا:
       `await res.json()` ثم `connect()` — والتوكن لم يُخزَّن بعد. قيس
       على الخادم الحيّ ثلاث مرات: التخزين يصل بعد فتح المقبس دائمًا
       (٩١٦ثم٩١٧ · ٩٦٥ثم٩٦٥ · ٩٩٦ثم٩٩٧ مللي) — خسارةٌ دائمة لا سباقٌ
       متذبذب، ولهذا يقع في كل إنشاء.

       فيُفتح المقبس بلا token، ولا يجد الخادمُ مقعدَ المضيف الذي أنشأه
       /room/create للتوّ، وreclaimSeat ترفض استعادته بالاسم (حماية
       الانتحال) ⇒ مقعدٌ ثانٍ باسم اللاعب، والأول «غير متصل»، وتنتقل
       إليه المضافة.

       الدالة async و`await` صريح: لا تُعاد res إلا وقد خُزِّن التوكن.
       والانتظار على مسار الإنشاء وحده — كل طلبٍ آخر يخرج من السطر
       الأول بلا لمسة. */
    window.fetch = async function (input, init) {
      var urlStr = (typeof input === 'string') ? input
                 : (input && input.url) ? input.url : String(input);
      var game = null;
      try { game = parseCreatePath(new URL(urlStr, location.href).pathname); } catch (e) {}

      var p = origFetch.apply(this, arguments);
      if (!game) return p;                  // غير الإنشاء: كما كان تمامًا

      var res = await p;
      try {
        // نقرأ نسخة عشان ما نستهلك الجسم الأصلي على اللعبة
        var data = await res.clone().json();
        if (data && data.roomCode) {
          if (data.seatToken)   put(keyFor(game, data.roomCode, 'seat'),   data.seatToken);
          if (data.screenToken) put(keyFor(game, data.roomCode, 'screen'), data.screenToken);
        }
      } catch (e) {
        /* ردٌّ ليس JSON (٤٠٣ نصّي مثلًا) أو نسخةٌ تعذّرت: لا نُسقط
           fetch على اللعبة — الجسم الأصلي ما زال سليمًا لها. */
      }
      return res;                           // بعد التخزين، لا قبله
    };
  }

  // ══════════ ٢+٣) حقن التوكن في الاتصال، والتقاطه من welcome ══════════
  var NativeWS = window.WebSocket;
  if (typeof NativeWS !== 'function') return;

  function Ya7WebSocket(url, protocols) {
    var finalUrl = String(url);
    var room = null;

    try {
      var u = new URL(finalUrl, location.href);
      room = parseRoomPath(u.pathname);

      if (room) {
        if (u.searchParams.get('screen') === '1' && !u.searchParams.get('stoken')) {
          var st = get(keyFor(room.game, room.code, 'screen'));
          if (st) u.searchParams.set('stoken', st);
        }
        // توكن المقعد
        if (!u.searchParams.get('token')) {
          var t = get(keyFor(room.game, room.code, 'seat'));
          if (t) u.searchParams.set('token', t);
        }
        finalUrl = u.toString();
      }
    } catch (e) {}

    var ws = (arguments.length > 1)
      ? new NativeWS(finalUrl, protocols)
      : new NativeWS(finalUrl);

    // نلتقط welcome بمستمع خاص — ما يتعارض مع مستمعات اللعبة
    if (room) {
      ws.addEventListener('message', function (evt) {
        try {
          var m = JSON.parse(evt.data);
          if (m && m.type === 'welcome' && m.seatToken) {
            put(keyFor(room.game, m.roomCode || room.code, 'seat'), m.seatToken);
          }
        } catch (e) {}
      });
    }

    return ws;
  }

  // نحافظ على الثوابت والنموذج عشان أي كود يفحصها
  Ya7WebSocket.prototype = NativeWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) {
    try { Ya7WebSocket[k] = NativeWS[k]; } catch (e) {}
  });

  window.WebSocket = Ya7WebSocket;
})();
