import { audit, authorizeAdmin, json } from "../_lib/admin.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function authHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json"
  };
}

async function listAdmins(env, actorId) {
  const response = await fetch(
    env.SUPABASE_URL + "/rest/v1/users?select=id,full_name,admin_role,status,created_at,is_admin,deleted_at&is_admin=eq.true&deleted_at=is.null&order=created_at.asc",
    { headers: authHeaders(env) }
  );
  if (!response.ok) {
    console.error("Admin list failed:", response.status, await response.text());
    return json({ error: "تعذّر تحميل قائمة المدراء." }, 502);
  }

  const rows = await response.json();
  if (!Array.isArray(rows)) return json({ error: "بيانات المدراء غير صالحة." }, 502);
  const admins = rows.filter((row) => row && UUID_RE.test(row.id) &&
    row.is_admin === true && (row.admin_role === "owner" || row.admin_role === "support"));

  const results = await Promise.all(admins.map(async (admin) => {
    const [userResponse, factorsResponse] = await Promise.all([
      fetch(env.SUPABASE_URL + "/auth/v1/admin/users/" + admin.id, { headers: authHeaders(env) }),
      fetch(env.SUPABASE_URL + "/auth/v1/admin/users/" + admin.id + "/factors", { headers: authHeaders(env) })
    ]);
    if (!userResponse.ok || !factorsResponse.ok) {
      console.error("Admin details lookup failed:", admin.id, userResponse.status, factorsResponse.status);
      throw new Error("ADMIN_DETAILS_LOOKUP_FAILED");
    }
    const authUser = await userResponse.json();
    const factorPayload = await factorsResponse.json();
    const factors = Array.isArray(factorPayload.factors) ? factorPayload.factors : [];
    const totpFactors = factors.filter((factor) => factor.factor_type === "totp");
    return {
      id: admin.id,
      name: admin.full_name || "",
      email: typeof authUser.email === "string" ? authUser.email : "",
      role: admin.admin_role,
      status: admin.status || "active",
      createdAt: admin.created_at || null,
      mfaEnabled: totpFactors.some((factor) => factor.status === "verified"),
      mfaFactorCount: totpFactors.length,
      isCurrentAdmin: admin.id === actorId
    };
  }));

  try {
    return json({ admins: results });
  } catch {
    return json({ error: "تعذّر تحميل تفاصيل حسابات الإدارة." }, 502);
  }
}

async function resetSupportMfa(env, auth, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "بيانات الطلب غير صالحة." }, 400);
  }

  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!UUID_RE.test(userId)) return json({ error: "معرّف المدير غير صالح." }, 400);
  if (userId === auth.user.id) return json({ error: "لا يمكن إعادة ضبط مصادقتك من هذه الصفحة." }, 403);

  const targetResponse = await fetch(
    env.SUPABASE_URL + "/rest/v1/users?select=id,is_admin,admin_role,status,deleted_at&id=eq." + userId,
    { headers: authHeaders(env) }
  );
  if (!targetResponse.ok) return json({ error: "تعذّر التحقق من حساب المدير المطلوب." }, 502);
  const targets = await targetResponse.json();
  const target = Array.isArray(targets) ? targets[0] : null;
  if (!target || target.is_admin !== true || target.admin_role !== "support" || target.deleted_at ||
      (target.status != null && target.status !== "active")) {
    return json({ error: "إعادة الضبط متاحة لحساب دعم فعّال فقط." }, 403);
  }

  const factorsResponse = await fetch(
    env.SUPABASE_URL + "/auth/v1/admin/users/" + userId + "/factors",
    { headers: authHeaders(env) }
  );
  if (!factorsResponse.ok) {
    console.error("Support MFA factors lookup failed:", factorsResponse.status, await factorsResponse.text());
    return json({ error: "تعذّر قراءة عوامل المصادقة. لم يتم إجراء أي تغيير." }, 502);
  }
  const factorPayload = await factorsResponse.json();
  const factors = Array.isArray(factorPayload.factors) ? factorPayload.factors : [];
  const totpFactors = factors.filter((factor) => factor.factor_type === "totp" && UUID_RE.test(factor.id));
  if (totpFactors.length === 0) return json({ error: "لا يوجد تطبيق مصادقة مسجّل لهذا الحساب." }, 409);

  // سجّل المحاولة قبل تنفيذ الحذف حتى لا تتم عملية حساسة بلا أثر تدقيقي.
  const logged = await audit(env, auth.user.id, "admin_reset_mfa", "admin", userId, {
    target_role: "support",
    factor_count: totpFactors.length,
    factor_types: ["totp"]
  });
  if (!logged) return json({ error: "تعذّر تسجيل العملية في سجل التدقيق؛ لم يتم تغيير المصادقة." }, 502);

  const deleted = [];
  for (const factor of totpFactors) {
    const response = await fetch(
      env.SUPABASE_URL + "/auth/v1/admin/users/" + userId + "/factors/" + factor.id,
      { method: "DELETE", headers: authHeaders(env) }
    );
    if (!response.ok) {
      console.error("Support MFA factor deletion failed:", response.status, await response.text());
      return json({
        error: deleted.length
          ? "تم حذف بعض عوامل المصادقة فقط. لا تحاول تكرار العملية قبل مراجعة سجل التدقيق."
          : "تعذّر حذف عامل المصادقة. لم يتم تأكيد إعادة الضبط."
      }, 502);
    }
    deleted.push(factor.id);
  }

  return json({
    success: true,
    deletedFactors: deleted.length,
    message: "تمت إعادة ضبط المصادقة الثنائية. سيحتاج المدير إلى تسجيل الدخول مجدداً وربط تطبيق مصادقة جديد."
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "طريقة الطلب غير مدعومة." }, 405);
  }
  try {
    const auth = await authorizeAdmin(request, env, { requireOwner: true });
    if (auth.error) return auth.error;
    if (request.method === "GET") return await listAdmins(env, auth.user.id);
    return await resetSupportMfa(env, auth, request);
  } catch (error) {
    console.error("Admin management endpoint failed:", error);
    return json({ error: "حدث خطأ أثناء إدارة حسابات المدراء." }, 500);
  }
}
