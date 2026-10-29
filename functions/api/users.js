import { audit, authorizeAdmin, json } from "../_lib/admin.js";

async function supabaseRequest(env, path, init = {}) {
  return fetch(env.SUPABASE_URL + path, {
    method: init.method || "GET",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });
}

// الإيميل غير موجود في جدول public.users؛ نجلبه من Auth (للتحقق من المالك الأساسي).
async function getAuthEmail(env, userId) {
  const response = await fetch(env.SUPABASE_URL + "/auth/v1/admin/users/" + userId, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY
    }
  });
  if (!response.ok) return { ok: false, email: null };
  const user = await response.json();
  return { ok: true, email: typeof user.email === "string" ? user.email : null };
}

// عدد الصفوف من ترويسة Content-Range (مثل "0-24/133" أو "*/0")
function totalFromRange(response) {
  const range = response.headers.get("content-range") || "";
  const total = Number(range.split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

async function countUsers(env, filter = "") {
  const response = await supabaseRequest(env, "/rest/v1/users?select=id" + filter, {
    method: "HEAD",
    headers: { Prefer: "count=exact" }
  });
  return response.ok ? totalFromRange(response) : null;
}

// بناء شروط التصفية والبحث بشكل آمن (نحذف أي رمز قد يكسر صيغة PostgREST)
export function buildUserFilter(query, filter) {
  const simple = [];
  const ors = [];

  if (filter === "providers") simple.push("is_provider=eq.true");
  else if (filter === "customers") simple.push("is_provider=eq.false");
  else if (filter === "active") simple.push("status=eq.active", "deleted_at=is.null");
  else if (filter === "inactive") ors.push("or(status.neq.active,deleted_at.not.is.null)");

  const text = String(query || "").replace(/[^\p{L}\p{N}\s+@._-]/gu, "").trim().slice(0, 60);
  if (text) {
    const digits = text.replace(/\D/g, "");
    const mostlyDigits = /^[\d\s+()-]+$/.test(text);
    const needle = digits.replace(/^00963/, "").replace(/^963/, "").replace(/^0+/, "");
    const clauses = [];
    if (!mostlyDigits) {
      const encoded = encodeURIComponent(text);
      clauses.push("full_name.ilike.*" + encoded + "*", "region.ilike.*" + encoded + "*");
    }
    if (digits.length >= 3 && needle.length >= 3) clauses.push("phone.ilike.*" + needle + "*");
    if (clauses.length > 0) ors.push("or(" + clauses.join(",") + ")");
  }

  let extra = simple.join("&");
  if (ors.length === 1) extra += (extra ? "&" : "") + ors[0].replace(/^or/, "or=");
  if (ors.length > 1) extra += (extra ? "&" : "") + "and=(" + ors.join(",") + ")";
  return extra ? "&" + extra : "";
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET" && request.method !== "PATCH" && request.method !== "DELETE") {
    return json({ error: "طريقة الطلب غير مدعومة." }, 405);
  }

  try {
    const auth = await authorizeAdmin(request, env, { requireOwner: request.method === "PATCH" || request.method === "DELETE" });
    if (auth.error) return auth.error;

    if (request.method === "DELETE") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "بيانات الطلب غير صالحة." }, 400);
      }

      const userId = typeof body.userId === "string" ? body.userId.trim() : "";
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
        return json({ error: "معرّف المستخدم غير صالح." }, 400);
      }

      const targetResponse = await supabaseRequest(
        env,
        "/rest/v1/users?select=id,status,is_admin,deleted_at&id=eq." + userId
      );
      if (!targetResponse.ok) {
        console.error("User deletion lookup failed:", targetResponse.status, await targetResponse.text());
        return json({ error: "تعذّر التحقق من الحساب المطلوب." }, 502);
      }
      const targets = await targetResponse.json();
      const target = Array.isArray(targets) ? targets[0] : null;
      if (!target) return json({ error: "المستخدم غير موجود." }, 404);

      let isPrimaryOwner = false;
      if (env.ADMIN_EMAIL) {
        const authUser = await getAuthEmail(env, userId);
        if (!authUser.ok) return json({ error: "تعذّر التحقق من هوية الحساب المطلوب." }, 502);
        isPrimaryOwner = Boolean(
          authUser.email && authUser.email.toLowerCase() === env.ADMIN_EMAIL.trim().toLowerCase()
        );
      }

      if (isPrimaryOwner || target.is_admin || userId === auth.user.id) {
        return json({ error: "لا يمكن حذف حساب المالك الأساسي أو أي حساب مدير." }, 403);
      }
      if (target.deleted_at || target.status === "deleted") {
        return json({ error: "الحساب محذوف مسبقاً." }, 409);
      }

      const deleteResponse = await fetch(
        env.SUPABASE_URL + "/rest/v1/rpc/admin_delete_user",
        {
          method: "POST",
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ p_user_id: userId })
        }
      );

      if (!deleteResponse.ok) {
        const detail = await deleteResponse.text();
        console.error("Admin account deletion failed:", deleteResponse.status, detail);
        if (detail.includes("ACTIVE_WORK_IN_PROGRESS")) {
          return json({ error: "لا يمكن حذف الحساب حالياً لوجود طلب أو اتفاق قيد التنفيذ لهذا المستخدم." }, 409);
        }
        if (detail.includes("USER_ALREADY_DELETED")) {
          return json({ error: "الحساب محذوف مسبقاً." }, 409);
        }
        if (detail.includes("ADMIN_ACCOUNT_PROTECTED")) {
          return json({ error: "لا يمكن حذف حساب مدير." }, 403);
        }
        if (detail.includes("USER_NOT_FOUND")) {
          return json({ error: "المستخدم غير موجود." }, 404);
        }
        return json({ error: "تعذّر حذف الحساب. لم يتم تأكيد اكتمال العملية." }, 502);
      }

      await audit(env, auth.user.id, "admin_delete_user", "user", userId, {
        previous_status: target.status || null
      });

      return json({
        success: true,
        status: "deleted",
        message: "تم حذف الحساب وتعطيل تسجيل الدخول، مع الاحتفاظ بسجلات التوثيق والمعاملات اللازمة."
      });
    }

    if (request.method === "PATCH") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "بيانات الطلب غير صالحة." }, 400);
      }

      const userId = typeof body.userId === "string" ? body.userId.trim() : "";
      const status = body.status;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
        return json({ error: "معرّف المستخدم غير صالح." }, 400);
      }
      if (status !== "active" && status !== "suspended") {
        return json({ error: "الحالة المسموحة هي فعّال أو موقوف فقط." }, 400);
      }

      const targetResponse = await supabaseRequest(
        env,
        "/rest/v1/users?select=id,status,is_admin,deleted_at&id=eq." + userId
      );
      if (!targetResponse.ok) {
        console.error("User status lookup failed:", targetResponse.status, await targetResponse.text());
        return json({ error: "تعذّر التحقق من الحساب المطلوب." }, 502);
      }
      const targets = await targetResponse.json();
      const target = Array.isArray(targets) ? targets[0] : null;
      if (!target) return json({ error: "المستخدم غير موجود." }, 404);
      let isPrimaryOwner = false;
      if (env.ADMIN_EMAIL) {
        const authUser = await getAuthEmail(env, userId);
        if (!authUser.ok) return json({ error: "تعذّر التحقق من هوية الحساب المطلوب." }, 502);
        isPrimaryOwner = Boolean(
          authUser.email && authUser.email.toLowerCase() === env.ADMIN_EMAIL.trim().toLowerCase()
        );
      }
      // احمِ المالك الأساسي حتى لو عُطّلت is_admin أو تغيّرت حالة سجلّه.
      if (isPrimaryOwner || target.is_admin || userId === auth.user.id) {
        return json({ error: "لا يمكن إيقاف حساب المالك الأساسي أو أي حساب مدير." }, 403);
      }
      if (target.deleted_at || target.status === "deleted") {
        return json({ error: "لا يمكن تغيير حالة حساب محذوف." }, 409);
      }
      // Even when the database already has this status, continue below to sync
      // the Supabase Auth ban state. A previous attempt may have updated the row
      // but failed before the Auth ban/unban request completed.
      const updateResponse = await fetch(
        env.SUPABASE_URL + "/rest/v1/users?id=eq." + userId,
        {
          method: "PATCH",
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
            "Content-Type": "application/json",
            Prefer: "return=representation"
          },
          body: JSON.stringify({ status })
        }
      );
      if (!updateResponse.ok) {
        console.error("User status update failed:", updateResponse.status, await updateResponse.text());
        return json({ error: "تعذّر حفظ حالة الحساب في قاعدة البيانات." }, 502);
      }

      await audit(env, auth.user.id, "admin_set_user_status", "user", userId, {
        status,
        previous_status: target.status || null
      });

      // Also ban/unban the Supabase Auth account so suspended users cannot simply re-login.
      const authAdminResponse = await fetch(
        env.SUPABASE_URL + "/auth/v1/admin/users/" + userId,
        {
          method: "PUT",
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ ban_duration: status === "suspended" ? "876000h" : "none" })
        }
      );
      if (!authAdminResponse.ok) {
        console.error("Auth ban update failed:", authAdminResponse.status, await authAdminResponse.text());
        return json({
          success: true,
          status,
          warning: "تم حفظ حالة الحساب، لكن تعذّر تحديث حظر تسجيل الدخول. تحقّق من سجلات الخادم."
        }, 502);
      }

      return json({
        success: true,
        status,
        message: status === "suspended" ? "تم إيقاف الحساب." : "تمت إعادة تفعيل الحساب."
      });
    }

    const url = new URL(request.url);
    const page = Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1));
    const pageSize = Math.min(100, Math.max(10, Math.floor(Number(url.searchParams.get("pageSize")) || 25)));
    const filterParam = url.searchParams.get("filter") || "all";
    const filter = buildUserFilter(url.searchParams.get("q"), filterParam);

    const select = "id,full_name,phone,region,is_provider,is_admin,verification_status,status,created_at,deleted_at,rating_avg,rating_count";
    const usersResponse = await supabaseRequest(
      env,
      "/rest/v1/users?select=" + select + filter +
        "&order=created_at.desc&limit=" + pageSize + "&offset=" + (page - 1) * pageSize,
      { headers: { Prefer: "count=exact" } }
    );
    if (!usersResponse.ok) {
      console.error("Users API upstream failure:", usersResponse.status, await usersResponse.text());
      return json({ error: "تعذّر تحميل قائمة المستخدمين. رمز الخطأ: " + usersResponse.status }, 502);
    }
    const total = totalFromRange(usersResponse);
    const users = await usersResponse.json();
    if (!Array.isArray(users)) return json({ error: "وصلت بيانات مستخدمين غير صالحة." }, 502);

    // ملخص عام (لا يتأثر بالبحث): الإجمالي، مقدمو الخدمة، الفعّالون
    const [allCount, providersCount, activeCount] = await Promise.all([
      countUsers(env),
      countUsers(env, "&is_provider=eq.true"),
      countUsers(env, "&status=eq.active&deleted_at=is.null")
    ]);
    const summary = { total: allCount, providers: providersCount, active: activeCount };

    const ids = users.map((user) => user.id).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (ids.length === 0) return json({ users: [], total, page, pageSize, summary });

    const profilesResponse = await supabaseRequest(
      env,
      "/rest/v1/provider_profiles?select=user_id,rating_avg,rating_count,completed_services_count,is_available&user_id=in.(" + ids.join(",") + ")"
    );
    if (!profilesResponse.ok) return json({ error: "تعذّر تحميل تفاصيل مقدّمي الخدمات." }, 502);

    const profiles = await profilesResponse.json();
    const profileByUserId = new Map(profiles.map((profile) => [profile.user_id, profile]));
    const result = users.map((user) => ({
      ...user,
      provider: profileByUserId.get(user.id) || null
    }));

    return json({ users: result, total, page, pageSize, summary });
  } catch {
    return json({ error: "حدث خطأ أثناء تحميل المستخدمين. حاول مجدداً." }, 500);
  }
}
