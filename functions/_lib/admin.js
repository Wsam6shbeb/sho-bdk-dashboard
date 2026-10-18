// ===============================================================
// مكتبة مشتركة لدوال الإدارة (لا تُعرَّض كمسار لأنها لا تصدّر onRequest):
//  - authorizeAdmin: التحقق من الجلسة + صلاحية الأدمن من قاعدة البيانات + التحقق بخطوتين (اختياري)
//  - audit: تسجيل كل فعل إداري في جدول audit_log
//  - readSettings: قراءة قيم app_settings (لتسجيل القيم القديمة قبل التغيير)
// ===============================================================

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function serviceHeaders(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
    ...extra
  };
}

// قراءة claims من JWT (التوكن نفسه تم التحقق منه سابقاً عبر /auth/v1/user)
export function jwtClaims(token) {
  try {
    const payload = token.split(".")[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return {};
  }
}

const DENIED = () => json({ error: "تعذّر تسجيل الدخول. تحقق من بياناتك وحاول مجدداً." }, 403);

export async function authorizeAdmin(request, env, { requireOwner = false } = {}) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return { error: json({ error: "يلزم تسجيل الدخول أولاً." }, 401) };

  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return { error: json({ error: "إعدادات الربط الآمن غير مكتملة في Cloudflare." }, 503) };
  }

  const response = await fetch(env.SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + token }
  });
  if (!response.ok) return { error: json({ error: "جلسة الدخول غير صالحة. سجّل الدخول مجدداً." }, 401) };

  const user = await response.json();
  // الإيميل لازم يكون مؤكَّداً (حماية من تسجيل حساب بإيميل المدير بدون تحقق)
  if (!user?.id || !user.email || !user.email_confirmed_at) return { error: DENIED() };

  // حساب المالك الأساسي محدد سراً عبر ADMIN_EMAIL، ولا يجوز أن تؤدي حالة سجل التطبيق
  // أو حذفه أو تعديل is_admin إلى قفل المالك خارج لوحة التحكم.
  const isPrimaryOwner = Boolean(
    env.ADMIN_EMAIL && user.email.toLowerCase() === env.ADMIN_EMAIL.trim().toLowerCase()
  );
  let role = isPrimaryOwner ? "owner" : null;

  if (!isPrimaryOwner) {
    const rowsResponse = await fetch(
      env.SUPABASE_URL + "/rest/v1/users?select=is_admin,admin_role,status,deleted_at&id=eq." + encodeURIComponent(user.id),
      { headers: serviceHeaders(env) }
    );
    if (rowsResponse.ok) {
      const rows = await rowsResponse.json();
      const row = Array.isArray(rows) ? rows[0] || null : null;
      if (row && row.is_admin === true && !row.deleted_at && (row.status == null || row.status === "active")) {
        role = row.admin_role === "support" ? "support" : "owner";
      }
    }
  }
  if (!role) return { error: DENIED() };

  // التحقق بخطوتين: يُفرض فقط عندما يُفعَّل الإعداد dashboard_require_mfa (بعد أن يسجّل المدير جهازه)
  const aal = jwtClaims(token).aal || "aal1";
  const mfaResponse = await fetch(
    env.SUPABASE_URL + "/rest/v1/app_settings?select=value&key=eq.dashboard_require_mfa",
    { headers: serviceHeaders(env) }
  );
  if (!mfaResponse.ok) {
    console.error("MFA setting lookup failed:", mfaResponse.status, await mfaResponse.text());
    return { error: json({ error: "تعذّر التحقق من إعدادات الأمان. حاول مجدداً." }, 503) };
  }
  let mfaRows;
  try {
    mfaRows = await mfaResponse.json();
  } catch (error) {
    console.error("MFA setting response was invalid:", error);
    return { error: json({ error: "تعذّر التحقق من إعدادات الأمان. حاول مجدداً." }, 503) };
  }
  if (!Array.isArray(mfaRows)) {
    return { error: json({ error: "تعذّر التحقق من إعدادات الأمان. حاول مجدداً." }, 503) };
  }
  if (mfaRows[0]?.value === true && aal !== "aal2") {
    return { error: json({ error: "يلزم التحقق بخطوتين.", code: "MFA_REQUIRED" }, 401) };
  }

  if (requireOwner && role !== "owner") {
    return { error: json({ error: "هذا الإجراء مخصص للمالك فقط." }, 403) };
  }
  return { user, role, aal };
}

// تسجيل فعل إداري. لا يوقف العملية إذا فشل التسجيل، لكنه يسجّل الخطأ في سجلات الخادم.
export async function audit(env, actorId, action, entityType, entityId, metadata = {}) {
  try {
    const response = await fetch(env.SUPABASE_URL + "/rest/v1/audit_log", {
      method: "POST",
      headers: serviceHeaders(env, { Prefer: "return=minimal" }),
      body: JSON.stringify({
        actor_id: actorId,
        action,
        entity_type: entityType,
        entity_id: entityId || null,
        metadata
      })
    });
    if (!response.ok) {
      console.error("audit_log insert failed:", response.status, await response.text());
      return false;
    }
    return true;
  } catch (error) {
    console.error("audit_log insert error:", error);
    return false;
  }
}

export async function readSettings(env, keys) {
  try {
    const response = await fetch(
      env.SUPABASE_URL + "/rest/v1/app_settings?select=key,value&key=in.(" + keys.join(",") + ")",
      { headers: serviceHeaders(env) }
    );
    if (!response.ok) return {};
    const rows = await response.json();
    return Object.fromEntries((Array.isArray(rows) ? rows : []).map((row) => [row.key, row.value]));
  } catch {
    return {};
  }
}

// الفرق بين قيم قديمة وجديدة (للتسجيل في audit_log): { key: { from, to } }
export function changes(before, after) {
  const out = {};
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(value)) {
      out[key] = { from: before[key] ?? null, to: value };
    }
  }
  return out;
}
