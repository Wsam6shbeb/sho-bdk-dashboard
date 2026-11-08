import { authorizeAdmin, json } from "../_lib/admin.js";

// إحصائيات لوحة التحكم (قراءة فقط).
// - التحقق من الجلسة والدور والتحقق بخطوتين يتم بالكامل في authorizeAdmin الموجود (لا نظام صلاحيات جديد).
// - المالك والدعم يريان الإحصائيات التشغيلية؛ الجزء المالي وسجل أخطاء Gemini للمالك فقط ويُحسب على الخادم،
//   ونحذفه من الرد أيضاً إن لم يكن الدور مالكاً (طبقة حماية ثانية).
// - لا تُرسل للمتصفح أي تفاصيل خطأ من قاعدة البيانات أو الخادم؛ تُسجَّل في سجلات الخادم فقط.
const ALLOWED_DAYS = [0, 7, 30, 90, 365];
const REQUIRED_KEYS = ["meta", "users", "providers", "requests", "categories", "regions", "cells"];
const UPSTREAM_TIMEOUT_MS = 20000;

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return json({ error: "طريقة الطلب غير مدعومة." }, 405);

  try {
    const auth = await authorizeAdmin(request, env);
    if (auth.error) return auth.error;

    const params = new URL(request.url).searchParams;
    const daysRaw = params.get("days");
    const staleRaw = params.get("staleHours");
    const days = daysRaw === null ? 30 : Number(daysRaw);
    const staleHours = staleRaw === null ? 48 : Number(staleRaw);
    if (!ALLOWED_DAYS.includes(days)) return json({ error: "الفترة الزمنية غير صالحة." }, 400);
    if (!Number.isInteger(staleHours) || staleHours < 1 || staleHours > 720) {
      return json({ error: "مهلة اعتبار الطلب غير محسوم غير صالحة." }, 400);
    }

    const isOwner = auth.role === "owner";
    let response;
    try {
      response = await fetch(env.SUPABASE_URL + "/rest/v1/rpc/admin_dashboard_stats", {
        method: "POST",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ p_days: days, p_stale_hours: staleHours, p_include_owner: isOwner }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      });
    } catch (error) {
      console.error("admin_dashboard_stats request failed:", error && error.name);
      return json({ error: "انتهت مهلة حساب الإحصائيات. حاول مجدداً." }, 504);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error("admin_dashboard_stats failed:", response.status, detail.slice(0, 500));
      return json({ error: "تعذّر حساب الإحصائيات حالياً. حاول مجدداً لاحقاً." }, 502);
    }

    let stats;
    try {
      stats = await response.json();
    } catch {
      console.error("admin_dashboard_stats returned a non-JSON body");
      return json({ error: "تعذّر حساب الإحصائيات حالياً. حاول مجدداً لاحقاً." }, 502);
    }
    if (!stats || typeof stats !== "object" || Array.isArray(stats) || REQUIRED_KEYS.some((key) => !(key in stats))) {
      console.error("admin_dashboard_stats returned an unexpected shape");
      return json({ error: "تعذّر حساب الإحصائيات حالياً. حاول مجدداً لاحقاً." }, 502);
    }

    if (!isOwner) delete stats.owner;
    return json({ role: auth.role, stats });
  } catch (error) {
    console.error("Stats API error:", error && error.name);
    return json({ error: "حدث خطأ أثناء تحميل الإحصائيات. حاول مجدداً." }, 500);
  }
}
