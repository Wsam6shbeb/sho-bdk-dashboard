import { audit, authorizeAdmin, json } from "../_lib/admin.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function authHeaders(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
    ...extra
  };
}

async function readTarget(env, userId) {
  const response = await fetch(
    env.SUPABASE_URL + "/rest/v1/users?select=id,full_name,is_admin,admin_role,status,deleted_at&id=eq." + userId,
    { headers: authHeaders(env) }
  );
  if (!response.ok) return { error: json({ error: "تعذّر التحقق من الحساب المطلوب." }, 502) };
  const rows = await response.json();
  const target = Array.isArray(rows) ? rows[0] : null;
  if (!target) return { error: json({ error: "الحساب غير موجود." }, 404) };
  return { target };
}

async function getAuthUser(env, userId) {
  const response = await fetch(
    env.SUPABASE_URL + "/auth/v1/admin/users/" + userId,
    { headers: authHeaders(env) }
  );
  if (!response.ok) return { ok: false };
  return { ok: true, user: await response.json() };
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
    const [authResult, factorsResponse] = await Promise.all([
      getAuthUser(env, admin.id),
      fetch(env.SUPABASE_URL + "/auth/v1/admin/users/" + admin.id + "/factors", { headers: authHeaders(env) })
    ]);
    if (!authResult.ok || !factorsResponse.ok) {
      console.error("Admin details lookup failed:", admin.id, factorsResponse.status);
      throw new Error("ADMIN_DETAILS_LOOKUP_FAILED");
    }
    const factorPayload = await factorsResponse.json();
    const factors = Array.isArray(factorPayload) ? factorPayload
      : Array.isArray(factorPayload.factors) ? factorPayload.factors : [];
    const totpFactors = factors.filter((factor) => factor.factor_type === "totp");
    return {
      id: admin.id,
      name: admin.full_name || "",
      email: typeof authResult.user.email === "string" ? authResult.user.email : "",
      role: admin.admin_role,
      status: admin.status || "active",
      createdAt: admin.created_at || null,
      mfaEnabled: totpFactors.some((factor) => factor.status === "verified"),
      mfaFactorCount: totpFactors.length,
      isCurrentAdmin: admin.id === actorId
    };
  }));

  return json({ admins: results });
}

async function searchEligibleUsers(env, request) {
  const url = new URL(request.url);
  const query = String(url.searchParams.get("search") || "")
    .replace(/[^\p{L}\p{N}\s._-]/gu, "")
    .trim()
    .slice(0, 60);
  if (query.length < 2) return json({ users: [] });

  const filter = encodeURIComponent(query);
  const response = await fetch(
    env.SUPABASE_URL +
      "/rest/v1/users?select=id,full_name,status,is_admin,admin_role,deleted_at" +
      "&full_name=ilike.*" + filter + "*" +
      "&is_admin=eq.false&admin_role=is.null&status=eq.active&deleted_at=is.null" +
      "&order=created_at.desc&limit=10",
    { headers: authHeaders(env) }
  );
  if (!response.ok) {
    console.error("Eligible user search failed:", response.status, await response.text());
    return json({ error: "تعذّر البحث عن المستخدمين." }, 502);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) return json({ error: "نتائج البحث غير صالحة." }, 502);

  const users = await Promise.all(rows.filter((row) => UUID_RE.test(row.id)).map(async (row) => {
    const authResult = await getAuthUser(env, row.id);
    if (!authResult.ok) throw new Error("ELIGIBLE_USER_AUTH_LOOKUP_FAILED");
    if (!authResult.user.email || !authResult.user.email_confirmed_at) return null;
    return {
      id: row.id,
      name: row.full_name || "",
      email: authResult.user.email
    };
  }));
  return json({ users: users.filter(Boolean) });
}

async function resetSupportMfa(env, auth, userId) {
  if (userId === auth.user.id) return json({ error: "لا يمكن إعادة ضبط مصادقتك من هذه الصفحة." }, 403);
  const lookup = await readTarget(env, userId);
  if (lookup.error) return lookup.error;
  const target = lookup.target;
  if (target.is_admin !== true || target.admin_role !== "support" || target.deleted_at ||
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
  const factors = Array.isArray(factorPayload) ? factorPayload
    : Array.isArray(factorPayload.factors) ? factorPayload.factors : [];
  const totpFactors = factors.filter((factor) => factor.factor_type === "totp" && UUID_RE.test(factor.id));
  if (totpFactors.length === 0) return json({ error: "لا يوجد تطبيق مصادقة مسجّل لهذا الحساب." }, 409);

  const logged = await audit(env, auth.user.id, "admin_reset_mfa_requested", "admin", userId, {
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
      await audit(env, auth.user.id, "admin_reset_mfa_partial", "admin", userId, {
        deleted_factor_count: deleted.length,
        requested_factor_count: totpFactors.length
      });
      return json({
        error: deleted.length
          ? "تم حذف بعض عوامل المصادقة فقط. لا تحاول تكرار العملية قبل مراجعة سجل التدقيق."
          : "تعذّر حذف عامل المصادقة. لم يتم تأكيد إعادة الضبط."
      }, 502);
    }
    deleted.push(factor.id);
  }

  const completionLogged = await audit(env, auth.user.id, "admin_reset_mfa_completed", "admin", userId, {
    deleted_factor_count: deleted.length
  });
  return json({
    success: true,
    deletedFactors: deleted.length,
    auditWarning: !completionLogged,
    message: completionLogged
      ? "تمت إعادة ضبط المصادقة الثنائية. سيحتاج المدير إلى تسجيل الدخول مجدداً وربط تطبيق مصادقة جديد."
      : "تمت إعادة ضبط المصادقة، لكن تعذّر تسجيل تأكيد العملية. راجع سجل الخادم قبل أي إجراء آخر."
  });
}

async function changeSupportAccess(env, auth, userId, action) {
  if (userId === auth.user.id) return json({ error: "لا يمكنك تغيير صلاحيات حسابك الحالي من هذه الصفحة." }, 403);
  const lookup = await readTarget(env, userId);
  if (lookup.error) return lookup.error;
  const target = lookup.target;

  if (target.deleted_at || target.status !== "active") {
    return json({ error: "يمكن إدارة حسابات المستخدمين الفعّالة فقط." }, 409);
  }
  if (target.admin_role === "owner" || (target.is_admin === true && target.admin_role !== "support")) {
    return json({ error: "حساب المالك محمي ولا يمكن تغيير صلاحياته من هذه الصفحة." }, 403);
  }

  let next;
  let auditAction;
  if (action === "promote_support") {
    if (target.is_admin === true) return json({ error: "هذا الحساب مدير بالفعل." }, 409);
    const authResult = await getAuthUser(env, userId);
    if (!authResult.ok) return json({ error: "تعذّر التحقق من حساب تسجيل الدخول." }, 502);
    if (!authResult.user.email || !authResult.user.email_confirmed_at) {
      return json({ error: "لا يمكن إضافة حساب لا يملك بريداً إلكترونياً مؤكداً." }, 409);
    }
    next = { is_admin: true, admin_role: "support" };
    auditAction = "admin_promote_support";
  } else if (action === "remove_support") {
    if (target.is_admin !== true || target.admin_role !== "support") {
      return json({ error: "الحساب ليس مدير دعم." }, 409);
    }
    next = { is_admin: false, admin_role: null };
    auditAction = "admin_remove_support";
  } else {
    return json({ error: "الإجراء غير معروف." }, 400);
  }

  const logged = await audit(env, auth.user.id, auditAction + "_requested", "admin", userId, {
    previous_is_admin: target.is_admin === true,
    previous_role: target.admin_role || null,
    next_is_admin: next.is_admin,
    next_role: next.admin_role
  });
  if (!logged) return json({ error: "تعذّر تسجيل العملية في سجل التدقيق؛ لم يتم تغيير الصلاحيات." }, 502);

  const updateFilter = action === "promote_support"
    ? "&is_admin=eq.false&status=eq.active&deleted_at=is.null"
    : "&is_admin=eq.true&admin_role=eq.support&status=eq.active&deleted_at=is.null";
  const updateResponse = await fetch(
    env.SUPABASE_URL + "/rest/v1/users?id=eq." + userId + updateFilter,
    {
      method: "PATCH",
      headers: authHeaders(env, { Prefer: "return=representation" }),
      body: JSON.stringify(next)
    }
  );
  if (!updateResponse.ok) {
    console.error("Support role update failed:", updateResponse.status, await updateResponse.text());
    return json({ error: "تعذّر حفظ الصلاحيات. لم يتم تأكيد التغيير." }, 502);
  }
  const updatedRows = await updateResponse.json();
  if (!Array.isArray(updatedRows) || updatedRows.length !== 1) {
    return json({ error: "لم يتغير الحساب. حدّث القائمة وتحقق من حالته." }, 409);
  }

  const completionLogged = await audit(env, auth.user.id, auditAction + "_completed", "admin", userId, {
    previous_role: target.admin_role || null,
    next_role: next.admin_role
  });
  return json({
    success: true,
    auditWarning: !completionLogged,
    message: action === "promote_support"
      ? "تمت إضافة المستخدم مدير دعم. يجب أن يفعّل المصادقة الثنائية قبل دخول لوحة التحكم."
      : "تمت إزالة صلاحيات الإدارة. بقي حساب المستخدم وبياناته كما هي."
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "طريقة الطلب غير مدعومة." }, 405);
  }
  try {
    const auth = await authorizeAdmin(request, env, { requireOwner: true });
    if (auth.error) return auth.error;

    if (request.method === "GET") {
      const url = new URL(request.url);
      if (url.searchParams.has("search")) return await searchEligibleUsers(env, request);
      return await listAdmins(env, auth.user.id);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "بيانات الطلب غير صالحة." }, 400);
    }
    const action = typeof body.action === "string" ? body.action : "";
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    if (!UUID_RE.test(userId)) return json({ error: "معرّف الحساب غير صالح." }, 400);

    if (action === "reset_mfa") return await resetSupportMfa(env, auth, userId);
    if (action === "promote_support" || action === "remove_support") {
      return await changeSupportAccess(env, auth, userId, action);
    }
    return json({ error: "الإجراء غير معروف." }, 400);
  } catch (error) {
    console.error("Admin management endpoint failed:", error);
    return json({ error: "حدث خطأ أثناء إدارة حسابات المدراء." }, 500);
  }
}
