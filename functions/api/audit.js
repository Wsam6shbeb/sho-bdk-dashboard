// قراءة سجل التدقيق (للقراءة فقط): آخر 200 إجراء إداري مع اسم المنفّذ.
import { authorizeAdmin, json } from "../_lib/admin.js";

async function rest(env, path) {
  return fetch(env.SUPABASE_URL + path, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY }
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return json({ error: "طريقة الطلب غير مدعومة." }, 405);

  try {
    const auth = await authorizeAdmin(request, env);
    if (auth.error) return auth.error;

    const response = await rest(
      env,
      "/rest/v1/audit_log?select=id,actor_id,action,entity_type,entity_id,metadata,created_at&order=created_at.desc&limit=200"
    );
    if (!response.ok) return json({ error: "تعذّر قراءة سجل التدقيق." }, 502);
    const entries = await response.json();

    // أسماء المنفّذين (للعرض فقط)
    const actorIds = [...new Set(entries.map((e) => e.actor_id).filter(Boolean))];
    let names = {};
    if (actorIds.length > 0) {
      const users = await rest(env, "/rest/v1/users?select=id,full_name&id=in.(" + actorIds.join(",") + ")");
      if (users.ok) {
        names = Object.fromEntries((await users.json()).map((u) => [u.id, u.full_name || ""]));
      }
    }

    return json({
      entries: entries.map((e) => ({ ...e, actor_name: names[e.actor_id] || null }))
    });
  } catch (error) {
    console.error("audit endpoint failed:", error);
    return json({ error: "حدث خطأ غير متوقع أثناء قراءة سجل التدقيق." }, 500);
  }
}
