// قراءة أخطاء التطبيق التشغيلية بعد استنفاد محاولات Gemini؛ المالك فقط.
import { authorizeAdmin, json } from "../_lib/admin.js";

async function rest(env, path) {
  return fetch(env.SUPABASE_URL + path, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY
    }
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return json({ error: "طريقة الطلب غير مدعومة." }, 405);

  try {
    const auth = await authorizeAdmin(request, env, { requireOwner: true });
    if (auth.error) return auth.error;

    const response = await rest(
      env,
      "/rest/v1/app_error_log?select=id,operation,error_code,http_status,attempt_count,platform,created_at&order=created_at.desc&limit=200"
    );
    if (!response.ok) return json({ error: "تعذّرت قراءة أخطاء التطبيق." }, 502);
    const entries = await response.json();
    return json({ entries: Array.isArray(entries) ? entries : [] });
  } catch (error) {
    console.error("app errors endpoint failed:", error);
    return json({ error: "حدث خطأ غير متوقع أثناء قراءة أخطاء التطبيق." }, 500);
  }
}
