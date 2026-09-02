# Story Image Agent

وكيل محلي يقرأ قصة تفاعلية مقسّمة إلى Parts، ويُنشئ لكل Part صورة واحدة عبر
واجهة **Gemini على الويب** باستخدام **Playwright** — بدون أي API لتوليد الصور،
وبدون أي تعامل آلي مع كلمات المرور أو CAPTCHA أو حدود الاستخدام.

**الأولوية في التصميم: الاعتمادية > سهولة الاستخدام > السرعة.**

---

## ماذا يفعل بالضبط

1. يقرأ `input/story.txt` ويقسّمه إلى Parts (يدعم `Part` / `Scene` / `Chapter` /
   `الجزء` / `المشهد` / `الفصل`، وأرقامًا عربية أو لاتينية).
2. يستخرج الشخصيات الرئيسية والأماكن والعناصر المهمة.
3. يبني **Character Bible** ثابتًا لكل شخصية: الاسم، العمر التقريبي، الجنس، شكل
   الوجه، الشعر، لون العينين، الملابس، الإكسسوارات، والصفات البصرية الثابتة.
4. يستخدم **Style Bible** واحدًا لكل القصة (من `config/config.json`).
5. يحلّل كل Part (المكان، الوقت، الإضاءة، الجو، الحركة، التعابير، الكاميرا،
   التكوين) ويختار أكثر مقطع بصري في النص ليمثّله.
6. يبني Prompt مفصّلًا لكل Part، ويستخدم **نفس الوصف البصري للشخصية في كل مرة**
   تظهر فيها — هذه هي آلية استمرارية الشخصيات.
7. يفتح Chrome مرئيًا، ينتظر تسجيل دخولك **يدويًا**، ثم يرسل الـPrompts واحدًا
   تلو الآخر، ينتظر انتهاء التوليد، ينزّل الصورة ويتحقق من سلامتها.
8. يحفظ: `output/images/part_001.png` و`output/prompts/part_001.txt` و
   `output/metadata/part_001.json`، ويسجّل التقدم في `output/state.json`.

---

## المتطلبات

- Windows 10/11 (يعمل أيضًا على Linux/macOS).
- Python 3.10 أو أحدث.
- Google Chrome مثبّت (أو استخدم Chromium الذي ينزّله Playwright).
- حساب Google يستطيع استخدام Gemini، وتسجّل دخوله بنفسك.

## التثبيت (Windows)

```bat
cd story-image-agent
setup.bat
```

أو يدويًا:

```bat
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python -m playwright install chromium
```

> `playwright install chromium` مطلوب فقط إذا لم ترغب باستخدام Chrome المثبّت
> لديك. الإعداد الافتراضي `"channel": "chrome"` يشغّل Chrome نفسه.

---

## طريقة التشغيل

ضع قصتك في `input/story.txt` بهذا الشكل (أو ما يشبهه):

```
الجزء 1: الرسالة
النص...

الجزء 2: ماجد
النص...
```

ثم:

```bat
run.bat                              REM قائمة تفاعلية
run.bat --mode analyze               REM تحليل القصة + بناء Character Bible
run.bat --mode prompts               REM كتابة كل الـPrompts بدون متصفح
run.bat --mode test --part 1         REM اختبار Part واحد كاملًا في المتصفح
run.bat --mode generate              REM توليد كل الصور المتبقية
run.bat --mode resume                REM إعادة محاولة الأجزاء الفاشلة/الناقصة
run.bat --mode progress              REM عرض حالة التقدم
run.bat --mode inspect               REM فحص عناصر واجهة Gemini الحالية
run.bat --mode inspect --probe       REM فحص أعمق: يرسل Prompt واحدًا ليفحص حالة الرد
```

على Linux/macOS استبدل `run.bat` بـ `python src/main.py`.

القائمة التفاعلية:

```
1. Analyze story
2. Generate prompts
3. Test Gemini with one Part
4. Generate all images
5. Resume failed/incomplete Parts
6. Show progress
7. Inspect Gemini UI selectors
```

خيارات إضافية مفيدة:

| الخيار | المعنى |
|---|---|
| `--part N` | معالجة Part محدد (يمكن تكرارها: `--part 1 --part 4`) |
| `--limit N` | حدّ أقصى لعدد الـParts في هذه الجلسة |
| `--start N` | البدء من Part رقم N |
| `--force` | إعادة توليد أجزاء مكتملة مسبقًا |
| `--rebuild-bible` | إعادة بناء أوصاف الشخصيات من النص (يحذف الأوصاف التلقائية القديمة ويُبقي التي علّمتها `"manual": true`) |
| `--same-chat` | إبقاء محادثة واحدة بدل محادثة جديدة لكل Part |
| `--probe` | مع `--mode inspect`: يرسل Prompt تجريبيًا واحدًا لفحص عناصر حالة الرد |
| `--reset` | مسح ملف التقدم قبل التشغيل |
| `--story PATH` / `--config PATH` | ملف قصة أو إعدادات بديل |

---

## تسجيل الدخول (يدوي بالكامل)

- يفتح الوكيل نافذة Chrome **مرئية** ويذهب إلى Gemini.
- إذا لم تكن مسجّلًا، يتوقف ويطبع تعليمات وينتظر (حتى 10 دقائق افتراضيًا) إلى أن
  يرى مربع الكتابة، ثم يكمل تلقائيًا.
- **لا** يُدخل الوكيل أي كلمة مرور، و**لا** يتعامل مع CAPTCHA. إذا ظهر تحقق
  أمني، يتوقف ويطلب منك حلّه يدويًا، ثم تستأنف بـ `--mode resume`.
- تُحفظ الجلسة في مجلد ملف تعريف محلي `.browser_profile/` حتى لا تسجّل الدخول في
  كل مرة. هذا المجلد **مستثنى من Git** ولا يجب مشاركته — إنه يحتوي جلستك.
- الـlogs تمرّ عبر مُنقٍّ (`RedactingFilter`) يمسح أي Cookies أو Tokens قبل
  كتابتها، فلا تُطبع بيانات الدخول أبدًا.

---

## الإعدادات — `config/config.json`

أهم المفاتيح:

- `paths` — مواقع الملفات والمخرجات.
- `browser` — `channel` (`chrome` أو `msedge`)، `headless`، `gemini_url`،
  و`executable_path` إن أردت تحديد مسار متصفح بنفسك.
- `timeouts` — `login_wait_ms`, `generation_ms`, `generation_poll_ms`,
  `generation_settle_ms` (مدة ثبات الصورة قبل اعتبارها نهائية), `download_ms`.
- `retry` — `max_retries` وتزايد الانتظار (`initial_backoff_s`,
  `backoff_multiplier`, `max_backoff_s`).
- `pacing` — `delay_between_parts_s`، و`on_rate_limit`: `pause` (انتظار
  `rate_limit_cooldown_s` ثم إعادة المحاولة) أو `stop` (إيقاف آمن).
- `style_bible` — الأسلوب البصري الموحّد لكل الصور (عدّله كما تشاء).
- `prompt` — طول المقطع المقتبس، عدد الشخصيات في الـPrompt، وقسم السلبيات.

### Character Bible — `output/character_bible.json`

يُنشأ تلقائيًا بعد `--mode analyze`. الأوصاف **حتمية**: نفس الاسم ينتج عنه دائمًا
نفس الوجه والشعر والملابس، في كل Part وفي كل تشغيل.

عدّل أي حقل يدويًا (الاسم، العمر، الملابس…) — الوكيل **لا يستبدل** إدخالًا
موجودًا. أضف `"manual": true` لأي شخصية تريد حمايتها حتى من `--rebuild-bible`.

---

## عندما تتغيّر واجهة Gemini

كل عناصر الواجهة في ملف واحد: **`config/selectors.json`**. لا يوجد selector واحد
داخل كود Python. كل مفتاح فيه قائمة مرشّحين مرتّبة؛ يجرّبها الوكيل بالترتيب
ويستخدم أول عنصر مرئي فعليًا (role و aria-label والنص قبل CSS الهشّ، عربي
وإنجليزي معًا).

### مهم: العنصر المفقود ليس بالضرورة معطوبًا

كثير من العناصر **لا توجد أصلًا في صفحة فارغة**:

| المفتاح | متى يوجد فعلًا |
|---|---|
| `prompt_input`, `logged_in_marker`, `new_chat_button` | دائمًا |
| `send_button` | **فقط بعد كتابة نص** في مربع الإدخال |
| `stop_button`, `loading_indicator` | **فقط أثناء** توليد الرد |
| `response_container`, `generated_image`, `image_download_button`, `response_complete_marker`, `image_more_options_button` | **فقط بعد** ظهور رد على الشاشة |

لذلك `--mode inspect` يفحص الصفحة على مراحل ويُظهر:

- `OK` — تطابق فعلي.
- `n/a` — العنصر لا يمكن أن يوجد في هذه الحالة؛ أعد الفحص بـ`--probe`.
- `opt` — عنصر اختياري وللوكيل بديل عنه.
- `MISS` — تطابق مفقود فعلًا يستحق الإصلاح.

`--mode inspect --probe` يرسل Prompt واحدًا حقيقيًا (يستهلك توليدًا واحدًا)
ويفحص أيضًا حالتَي "أثناء التوليد" و"بعد الرد".

### طبقة احتياطية: التعرّف على الشكل لا على الاسم

إذا لم يتطابق أي مرشّح، لا يستسلم الوكيل: يفحص DOM بالشكل بدل الاسم —

- **زر الإرسال**: زر مرئي مفعّل نصّه/تسميته تدل على الإرسال، وإلا أقرب زر مرئي
  إلى مربع الإدخال؛ وإن لم يوجد، يرسل بـ`Enter`.
- **الصورة الناتجة**: أكبر صورة (‏‎≥200×200‎‏) **ظهرت بعد** إرسال الـPrompt ولم
  تكن موجودة قبله، مع استبعاد الأيقونات والصور الرمزية.
- **زر التنزيل**: أقرب رابط/زر تنزيل إلى الصورة؛ وإن لم يوجد تُنزَّل الصورة من
  مصدرها مباشرة عبر الجلسة نفسها.
- **نص الرد**: إذا لم يتطابق `response_container` يُقرأ نص الصفحة نفسه، حتى تبقى
  رسائل تجاوز الحد والرفض مكتشَفة.

هذه الطبقة مُختبَرة: يوجد اختبار يشغّل واجهة **مُعاد تسميتها بالكامل** لا يتطابق
معها أي selector، ومع ذلك يُرسل الوكيل الـPrompt وينزّل الصورة بنجاح.

### إن ظهر `MISS` حقيقي

`--mode inspect` يحفظ تقريرًا كاملًا في
`output/logs/diagnostics/selector_report.json`، ويتضمن **لقطة من DOM الحقيقي**:
كل زر مرئي مع `aria-label` و`title` والنص والأيقونة والفئات، وكل العناصر
المخصّصة (custom elements)، وكل الصور بأحجامها الحقيقية، ومربعات الإدخال.

أرسل لي هذا الملف وسأكتب لك المرشّحين الدقيقين، أو أضفهم بنفسك في
`selectors.json` — بدون لمس كود Python.

كما يحفظ الوكيل لقطة شاشة ونسخة HTML في `output/logs/diagnostics/` عند أي فشل.

## الانتظار وإعادة المحاولة والاستكمال

- **الانتظار**: لا يعتمد على `sleep` عشوائي. ينتظر اختفاء زر الإيقاف، ظهور عنصر
  صورة داخل آخر رد، **وثبات مصدر الصورة** لمدة `generation_settle_ms` (لأن
  Gemini يعرض معاينة منخفضة الدقة قبل الصورة النهائية).
- **إعادة المحاولة**: حتى `max_retries` مع انتظار متزايد، ثم يُسجَّل الجزء في
  `output/failed_parts.json` وينتقل الوكيل إلى Part التالي بدل التوقف.
- **الحدود**: عند رسالة "وصلت إلى الحد" أو "حاول لاحقًا" لا يحاول الوكيل تجاوز
  الحد إطلاقًا؛ يسجّل الحالة وينتظر `rate_limit_cooldown_s` أو يتوقف حسب إعدادك.
- **الاستكمال**: بعد كل Part يُحدَّث `output/state.json`. إذا توقف البرنامج عند
  الجزء 5، فالتشغيل التالي يبدأ من 5 لا من 1. الأمر `--mode resume` يعيد محاولة
  الفاشل والناقص فقط.

---

## المخرجات

```
output/
├── images/     part_001.png ...
├── prompts/    part_001.txt ...
├── metadata/   part_001.json   (الحالة، الـPrompt، تحليل المشهد، الشخصيات المستخدمة،
│                                الأسلوب، حجم الصورة وطريقة تنزيلها، زمن التوليد)
├── logs/       agent.log + diagnostics/
├── state.json          الأجزاء المكتملة
├── failed_parts.json   الأجزاء الفاشلة وأسبابها
└── character_bible.json
```

---

## البنية

```
story-image-agent/
├── input/story.txt
├── config/{config.json, selectors.json}
├── src/
│   ├── main.py                CLI + القائمة التفاعلية
│   ├── agent.py               تنسيق المسار كاملًا (تقدّم، إعادة محاولة، Checkpoint)
│   ├── config.py              تحميل الإعدادات والمسارات
│   ├── story_parser.py        تقسيم القصة إلى Parts
│   ├── character_manager.py   Character Bible + الأماكن والعناصر
│   ├── prompt_generator.py    تحليل المشهد وبناء الـPrompt
│   ├── gemini_browser.py      كل التعامل مع Playwright وواجهة Gemini
│   ├── image_downloader.py    تنزيل الصورة والتحقق منها
│   ├── checkpoint_manager.py  الحفظ والاستكمال
│   └── logger.py              logging + إخفاء البيانات الحساسة
├── tests/                     اختبارات + صفحة محاكاة لواجهة الدردشة
├── requirements.txt
├── setup.bat / run.bat
└── README.md
```

---

## الاختبارات

```bat
python -m pytest -q
```

تشمل: تحليل القصة (عربي/إنجليزي، أرقام عربية، fallback بدون عناوين)، ثبات
Character Bible، بناء الـPrompt، الحفظ والاستكمال، التحقق من الصور، وإخفاء
البيانات الحساسة في الـlogs.

كما تشمل اختبارات متصفح حقيقية (`tests/test_gemini_browser.py`) تعمل على صفحة
محاكاة محلية `tests/mock_gemini.html` مبنية على **نفس** `config/selectors.json`:
إرسال Prompt، انتظار ثبات الصورة، التنزيل، واكتشاف رسائل الحد والرفض. لتشغيلها
دون متصفح: `python -m pytest -q -m "not slow"`.

**ملاحظة صريحة**: هذه الاختبارات تتحقق من منطق الوكيل، لا من ثبات واجهة Gemini
الحقيقية. لم تُفحص صفحة Gemini الحيّة أثناء بناء المشروع (يتطلب ذلك تسجيل دخولك
أنت على جهازك)، لذلك بُني النظام على ثلاث طبقات: قوائم مرشّحين مركزة في ملف
واحد، ثم طبقة تعرّف على الشكل (heuristics)، ثم تقرير DOM حقيقي تُشتق منه
المرشّحات الدقيقة. أول شيء تفعله على جهازك:

```bat
run.bat --mode inspect --probe
run.bat --mode test --part 1
```

إن ظهر `MISS` حقيقي لأي مفتاح، أضف مرشّحًا مطابقًا لما تراه في
`selector_report.json` داخل `config/selectors.json` وأعد المحاولة.

---

## مشاكل شائعة

| العرض | الحل |
|---|---|
| `Could not find UI element 'prompt_input'` | شغّل `--mode inspect` وأضف مرشّحًا في `selectors.json` |
| `MISS` لعناصر الرد في فحص بلا `--probe` | طبيعي — تلك العناصر لا توجد قبل ظهور رد؛ أعد الفحص بـ`--probe` |
| توقّف عند "MANUAL SIGN-IN REQUIRED" | سجّل الدخول في النافذة المفتوحة؛ يكمل تلقائيًا |
| `No finished image appeared` | ارفع `timeouts.generation_ms`، وراجع اللقطة في `output/logs/diagnostics/` |
| ظهور CAPTCHA | حلّه يدويًا ثم `--mode resume` |
| رسالة تجاوز الحد | انتظر؛ الوكيل لا يتجاوز الحدود إطلاقًا |
| صورة بصيغة غير PNG | ثبّت `Pillow` ليحوّلها تلقائيًا |
| Chrome لا يفتح | غيّر `browser.channel` إلى `chromium` أو حدّد `browser.executable_path` |

---

## حدود وأخلاقيات

- لا يُخزَّن أي كلمة مرور، ولا تُطبع Cookies أو Tokens.
- لا يوجد أي تجاوز لـCAPTCHA أو أنظمة الحماية أو حدود الاستخدام.
- التزم بشروط استخدام Google؛ الأتمتة قد تكون مقيّدة، والاستخدام على مسؤوليتك.
