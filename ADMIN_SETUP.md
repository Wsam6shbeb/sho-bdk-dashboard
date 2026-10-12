# إعداد الربط الآمن للوحة الإدارة

هذه الخطوات مطلوبة قبل دمج التعديلات أو استخدام زر حفظ العمولة.

## 1. أضف متغيرات Cloudflare Pages

افتح Cloudflare Dashboard → Workers & Pages → مشروع `sho-bdk-dashboard` → Settings → Variables and Secrets.

أضف القيم التالية لبيئتي **Production** و **Preview**:

- `SUPABASE_URL`: رابط مشروع Supabase، مثل `https://cmflpnweojteblxrpzgq.supabase.co`
- `SUPABASE_ANON_KEY`: مفتاح anon العام القديم من إعدادات API Keys في Supabase (يُستخدم للتحقق من جلسة الدخول).
- `SUPABASE_SERVICE_ROLE_KEY`: مفتاح `service_role` السري من إعدادات API Keys القديمة. ضعه كـ **Secret**، ولا تضعه في ملفات الموقع أو GitHub أو ترسله في المحادثات.
- `ADMIN_EMAIL`: البريد الإلكتروني لحساب المدير الموجود مسبقاً في Supabase Auth.

لا تستخدم المفتاح السري الجديد بدلاً من `service_role` في هذا الإصدار من endpoint؛ الكود يستخدم مفتاح الخدمة بصيغة JWT في ترويسة Authorization.

بعد حفظ المتغيرات، أعد نشر آخر نسخة من Cloudflare Pages حتى تعمل دالة `/api/settings`.

## تسجيل الدخول عبر Google

- فعّل مزوّد Google من Supabase → Authentication → Sign In / Providers، وأدخل إعدادات OAuth المطلوبة من Google Cloud.
- في Supabase → Authentication → URL Configuration، أضف عنوان لوحة التحكم إلى Redirect URLs:
  - `https://sho-bdk-dashboard.pages.dev/`
- زر Google يعيد المستخدم إلى لوحة التحكم، ثم يتحقق الخادم من أن البريد يطابق `ADMIN_EMAIL`. لا يمنح مجرد تسجيل الدخول عبر Google صلاحية المدير.

## 2. اختبر من دون تغيير العمولة

1. افتح رابط Preview للفرع أو رابط الموقع بعد النشر.
2. سجّل الدخول بالبريد وكلمة المرور لحساب المدير.
3. افتح قسم العمولة وتأكد أن القيمة المقروءة هي 50.
4. لا تضغط حفظ أثناء الاختبار الأول.

إذا ظهرت رسالة أن إعدادات الربط غير مكتملة، تحقق من المتغيرات الأربعة أعلاه. لا تغيّر سياسات RLS أو دوال الاتفاقات لمعالجة مشكلة إعدادات النشر.

## 3. سلوك الحفظ

عند الضغط على حفظ، يتحقق الخادم من جلسة Supabase ومن تطابق البريد مع `ADMIN_EMAIL`. ثم يحدّث `commission_min` و`commission_max` و`commission_default` إلى الرقم نفسه، بين 50 و1000، بحيث تبقى العمولة ثابتة. لا يتم تعديل الاتفاقات القديمة.

لا تدمج الفرع في `main` قبل إكمال إعداد المتغيرات ومراجعة Preview.
