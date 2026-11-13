import { authorizeAdmin, json } from "../_lib/admin.js";

// إحصائيات «الخدمات» (ما يُطلب وما يُعرض بالاسم الفعلي) مع فلتر محافظة ثم منطقة. قراءة فقط.
// - التحقق من الجلسة والدور والتحقق بخطوتين يتم بالكامل في authorizeAdmin الموجود.
// - الدعم والمالك يريان القسم نفسه (لا بيانات مالية فيه).
// - القيم تُمرَّر لقاعدة البيانات كمعاملات JSON (لا تُلصق في أي استعلام)، وتُفحص هنا قبل ذلك.
// - لا تُرسل للمتصفح أي تفاصيل خطأ؛ تُسجَّل في سجلات الخادم فقط.
const ALLOWED_DAYS = [0, 7, 30, 90, 365];
const REGIONS = [
  "دمشق", "حلب", "حمص", "حماه", "اللاذقية", "طرطوس", "إدلب", "درعا", "السويداء",
  "القنيطرة", "دير الزور", "الرقة", "الحسكة", "اونلاين"
];
const MAX_AREA_LENGTH = 60;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const REQUIRED_KEYS = ["meta", "filters", "coverage", "scope", "demand", "supply"];
const UPSTREAM_TIMEOUT_MS = 20000;

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return json({ error: "طريقة الطلب غير مدعومة." }, 405);

  try {
    const auth = await authorizeAdmin(request, env);
    if (auth.error) return auth.error;

    const params = new URL(request.url).searchParams;
    const daysRaw = params.get("days");
    const days = daysRaw === null ? 30 : Number(daysRaw);
    if (!ALLOWED_DAYS.includes(days)) return json({ error: "الفترة الزمنية غير صالحة." }, 400);

    const regionRaw = (params.get("region") || "").trim();
    const areaRaw = (params.get("area") || "").trim();
    if (regionRaw && !REGIONS.includes(regionRaw)) return json({ error: "المحافظة غير صالحة." }, 400);
    if (areaRaw) {
      if (!regionRaw) return json({ error: "اختر المحافظة قبل المنطقة." }, 400);
      if (areaRaw.length > MAX_AREA_LENGTH || CONTROL_CHARS.test(areaRaw)) return json({ error: "المنطقة غير صالحة." }, 400);
    }

    let response;
    try {
      response = await fetch(env.SUPABASE_URL + "/rest/v1/rpc/admin_services_stats", {
        method: "POST",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ p_days: days, p_region: regionRaw || null, p_area: areaRaw || null }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      });
    } catch (error) {
      console.error("admin_services_stats request failed:", error && error.name);
      return json({ error: "انتهت مهلة حساب الإحصائيات. حاول مجدداً." }, 504);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error("admin_services_stats failed:", response.status, detail.slice(0, 500));
      return json({ error: "تعذّر حساب إحصائيات الخدمات حالياً. حاول مجدداً لاحقاً." }, 502);
    }

    let services;
    try {
      services = await response.json();
    } catch {
      console.error("admin_services_stats returned a non-JSON body");
      return json({ error: "تعذّر حساب إحصائيات الخدمات حالياً. حاول مجدداً لاحقاً." }, 502);
    }
    if (!services || typeof services !== "object" || Array.isArray(services) || REQUIRED_KEYS.some((key) => !(key in services))) {
      console.error("admin_services_stats returned an unexpected shape");
      return json({ error: "تعذّر حساب إحصائيات الخدمات حالياً. حاول مجدداً لاحقاً." }, 502);
    }

    return json({ role: auth.role, services });
  } catch (error) {
    console.error("Stats services API error:", error && error.name);
    return json({ error: "حدث خطأ أثناء تحميل إحصائيات الخدمات. حاول مجدداً." }, 500);
  }
}
