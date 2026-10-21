import { authorizeAdmin, json } from "../_lib/admin.js";

// مراجعة طلبات التوثيق (للمالك فقط). الصور تُقرأ من bucket خاص بمفتاح الخادم،
// وتُمرَّر للمتصفح من نفس الأصل بدون روابط عامة، وكل فتح لصورة يُسجَّل في audit_log.

const BUCKET = "verification-docs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(["pending", "approved", "rejected"]);

function serviceHeaders(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
    ...extra
  };
}

async function rest(env, path, init = {}) {
  return fetch(env.SUPABASE_URL + "/rest/v1/" + path, {
    method: init.method || "GET",
    headers: serviceHeaders(env, { "Content-Type": "application/json", ...(init.headers || {}) }),
    body: init.body
  });
}

async function logAudit(env, actorId, action, entityId, metadata) {
  // تسجيل مباشر في audit_log؛ فشله لا يجب أن يمرّر الصورة بدون أثر.
  const response = await rest(env, "audit_log", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      actor_id: actorId,
      action,
      entity_type: "verification",
      entity_id: entityId,
      metadata
    })
  });
  return response.ok;
}

async function listVerifications(env, url) {
  const status = url.searchParams.get("status") || "pending";
  const filter = status === "all" ? "" : STATUSES.has(status) ? "&status=eq." + status : null;
  if (filter === null) return json({ error: "حالة غير صالحة." }, 400);

  const response = await rest(
    env,
    "verifications?select=id,user_id,status,rejection_reason,created_at,reviewed_at" +
      filter + "&order=created_at.asc&limit=100"
  );
  if (!response.ok) {
    console.error("Verifications list failed:", response.status, await response.text());
    return json({ error: "تعذّر تحميل طلبات التوثيق." }, 502);
  }
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length === 0) return json({ items: [] });

  const ids = [...new Set(rows.map((row) => row.user_id))].filter((id) => UUID_RE.test(id));
  const usersResponse = await rest(
    env,
    "users?select=id,full_name,phone,region&id=in.(" + ids.join(",") + ")"
  );
  const users = usersResponse.ok ? await usersResponse.json() : [];
  const byId = new Map((Array.isArray(users) ? users : []).map((user) => [user.id, user]));

  return json({
    items: rows.map((row) => ({ ...row, user: byId.get(row.user_id) || null }))
  });
}

async function getVerification(env, id) {
  const response = await rest(
    env,
    "verifications?select=id,user_id,status,rejection_reason,created_at,reviewed_at,id_document_url,selfie_url&id=eq." + id
  );
  if (!response.ok) return { error: json({ error: "تعذّر تحميل الطلب." }, 502) };
  const rows = await response.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return { error: json({ error: "الطلب غير موجود." }, 404) };
  return { row };
}

async function streamFile(env, auth, id, which) {
  if (which !== "id" && which !== "selfie") return json({ error: "نوع الملف غير صالح." }, 400);
  const found = await getVerification(env, id);
  if (found.error) return found.error;

  const path = which === "id" ? found.row.id_document_url : found.row.selfie_url;
  if (!path || path.includes("..") || !path.startsWith(found.row.user_id + "/")) {
    return json({ error: "مسار الملف غير صالح." }, 400);
  }

  const logged = await logAudit(env, auth.user.id, "admin_view_verification_file", id, { file: which });
  if (!logged) return json({ error: "تعذّر تسجيل الوصول إلى الصورة، لم تُعرض." }, 502);

  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const upstream = await fetch(env.SUPABASE_URL + "/storage/v1/object/" + BUCKET + "/" + encodedPath, {
    headers: serviceHeaders(env)
  });
  if (!upstream.ok) return json({ error: "تعذّر قراءة الصورة." }, upstream.status === 404 ? 404 : 502);

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("content-type") || "image/jpeg",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

async function detail(env, id) {
  const found = await getVerification(env, id);
  if (found.error) return found.error;
  const { id_document_url, selfie_url, ...safe } = found.row;
  const userResponse = await rest(
    env,
    "users?select=id,full_name,phone,region,created_at,is_provider,status&id=eq." + found.row.user_id
  );
  const users = userResponse.ok ? await userResponse.json() : [];
  return json({ verification: safe, user: Array.isArray(users) ? users[0] || null : null });
}

async function decide(env, auth, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "بيانات الطلب غير صالحة." }, 400);
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const decision = body.decision;
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";

  if (!UUID_RE.test(id)) return json({ error: "معرّف الطلب غير صالح." }, 400);
  if (decision !== "approved" && decision !== "rejected") {
    return json({ error: "القرار المسموح: قبول أو رفض." }, 400);
  }
  if (decision === "rejected" && !reason) return json({ error: "اكتب سبب الرفض." }, 400);

  const response = await rest(env, "rpc/decide_verification", {
    method: "POST",
    body: JSON.stringify({ p_id: id, p_decision: decision, p_reason: reason || null, p_admin: auth.user.id })
  });
  if (!response.ok) {
    const text = await response.text();
    if (text.includes("ALREADY_DECIDED")) return json({ error: "تم اتخاذ قرار بهذا الطلب مسبقاً." }, 409);
    if (text.includes("VERIFICATION_NOT_FOUND")) return json({ error: "الطلب غير موجود." }, 404);
    if (text.includes("REASON_REQUIRED")) return json({ error: "اكتب سبب الرفض." }, 400);
    console.error("decide_verification failed:", response.status, text);
    return json({ error: "تعذّر حفظ القرار." }, 502);
  }
  return json({
    success: true,
    status: decision,
    message: decision === "approved" ? "تم توثيق الحساب." : "تم رفض الطلب."
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "طريقة الطلب غير مدعومة." }, 405);
  }
  try {
    // كل العمليات للمالك فقط: الصور حساسة.
    const auth = await authorizeAdmin(request, env, { requireOwner: true });
    if (auth.error) return auth.error;

    if (request.method === "POST") return await decide(env, auth, request);

    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) return await listVerifications(env, url);
    if (!UUID_RE.test(id)) return json({ error: "معرّف الطلب غير صالح." }, 400);
    const file = url.searchParams.get("file");
    return file ? await streamFile(env, auth, id, file) : await detail(env, id);
  } catch {
    return json({ error: "حدث خطأ أثناء معالجة الطلب. حاول مجدداً." }, 500);
  }
}
