import { authorizeAdmin, json } from "../_lib/admin.js";

// إدارة قسم فرص العمل من لوحة التحكم.
// - القراءة (GET): للمالك والدعم.
// - الإشراف على الوظائف والبلاغات (إخفاء/استعادة/حذف/قرار في بلاغ): للمالك والدعم.
// - الإعلانات والكلمات المحظورة والإعدادات (كتابة): للمالك فقط.
// كل الاستدعاءات تمرّر توكن المدير نفسه إلى دوال قاعدة البيانات (مثل إضافة الرصيد)، فتعيد القاعدة
// التحقق من الدور والتحقق بخطوتين وتسجّل الفعل في audit_log؛ فلا نستعمل مفتاح الخدمة هنا إطلاقاً.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UPSTREAM_TIMEOUT_MS = 15000;

const JOB_STATUS_FILTERS = new Set(["active", "expired", "closed", "hidden"]);
const JOB_NEW_STATUSES = new Set(["active", "hidden", "closed"]);
const REPORT_FILTERS = new Set(["open", "resolved", "dismissed"]);
const REPORT_ACTIONS = new Set(["hide_job", "delete_job", "dismiss"]);

// إجراءات الكتابة التي لا يملكها إلا المالك.
const OWNER_ONLY_ACTIONS = new Set(["save_ad", "delete_ad", "add_word", "delete_word", "save_settings"]);

// رسائل أخطاء قاعدة البيانات: [الرمز، حالة HTTP، الرسالة للمستخدم]
const DB_ERRORS = [
  ["MFA_REQUIRED", 401, "يلزم التحقق بخطوتين."],
  ["OWNER_ONLY", 403, "هذا الإجراء مخصص للمالك فقط."],
  ["FORBIDDEN", 403, "لا تملك صلاحية هذا الإجراء."],
  ["JOB_NOT_FOUND", 404, "الوظيفة غير موجودة (ربما حُذفت)."],
  ["REPORT_NOT_FOUND", 404, "البلاغ غير موجود."],
  ["AD_NOT_FOUND", 404, "الإعلان غير موجود."],
  ["WORD_NOT_FOUND", 404, "الكلمة غير موجودة."],
  ["ALREADY_RESOLVED", 409, "تمت معالجة هذا البلاغ مسبقاً."],
  ["WORD_EXISTS", 409, "هذه الكلمة (أو ما يشبهها) مضافة مسبقاً."],
  ["WORD_TOO_SHORT", 400, "الكلمة قصيرة جداً (حرفان على الأقل)."],
  ["INVALID_IMAGE_URL", 400, "رابط الصورة يجب أن يبدأ بـ https://"],
  ["INVALID_LINK_URL", 400, "رابط الإعلان يجب أن يبدأ بـ http:// أو https://"],
  ["INVALID_TITLE", 400, "عنوان الإعلان من 1 إلى 80 حرفاً."],
  ["INVALID_DATES", 400, "تاريخ النهاية يجب أن يكون بعد تاريخ البداية."],
  ["INVALID_PRIORITY", 400, "الأولوية بين -1000 و1000."],
  ["INVALID_SETTING", 400, "قيمة إعداد خارج الحدود المسموحة."],
  ["INVALID_STATUS", 400, "حالة غير صالحة."],
  ["INVALID_ACTION", 400, "إجراء غير صالح."]
];

function bearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

async function callRpc(env, token, name, body = {}) {
  let response;
  try {
    response = await fetch(env.SUPABASE_URL + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    console.error(name + " request failed:", error && error.name);
    return { error: json({ error: "انتهت مهلة الاتصال بقاعدة البيانات. حاول مجدداً." }, 504) };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(name + " failed:", response.status, detail.slice(0, 500));
    const known = DB_ERRORS.find(([code]) => detail.includes(code));
    if (known) {
      const payload = { error: known[2] };
      if (known[0] === "MFA_REQUIRED") payload.code = "MFA_REQUIRED";
      return { error: json(payload, known[1]) };
    }
    if (response.status === 401 || response.status === 403) {
      return { error: json({ error: "لا تملك صلاحية هذا الإجراء." }, 403) };
    }
    return { error: json({ error: "تعذّر إتمام العملية. حاول مجدداً." }, 502) };
  }

  try {
    return { data: await response.json() };
  } catch {
    console.error(name + " returned a non-JSON body");
    return { error: json({ error: "ردّ غير متوقع من قاعدة البيانات." }, 502) };
  }
}

function clampInt(raw, fallback, min, max) {
  const value = raw === null || raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function text(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validId(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function isoOrNull(value) {
  if (value === null || value === undefined || value === "") return { value: null };
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return { invalid: true };
  return { value: new Date(value).toISOString() };
}

// ---------- GET ----------
async function handleGet(env, token, url) {
  const view = url.searchParams.get("view") || "jobs";
  const limit = clampInt(url.searchParams.get("limit"), 30, 1, 100);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 100000);

  switch (view) {
    case "stats":
      return callRpc(env, token, "admin_jobs_stats");
    case "jobs": {
      const status = url.searchParams.get("status") || "";
      if (status && !JOB_STATUS_FILTERS.has(status)) return { error: json({ error: "حالة غير صالحة." }, 400) };
      return callRpc(env, token, "admin_list_jobs", {
        p_status: status || null,
        p_q: text(url.searchParams.get("q"), 100) || null,
        p_limit: limit,
        p_offset: offset
      });
    }
    case "reports": {
      const status = url.searchParams.get("status") || "open";
      if (status !== "all" && !REPORT_FILTERS.has(status)) return { error: json({ error: "حالة غير صالحة." }, 400) };
      return callRpc(env, token, "admin_list_job_reports", {
        p_status: status === "all" ? null : status,
        p_limit: limit,
        p_offset: offset
      });
    }
    case "ads":
      return callRpc(env, token, "admin_list_job_ads");
    case "words":
      return callRpc(env, token, "admin_list_job_blocked_words");
    case "settings":
      return callRpc(env, token, "admin_get_jobs_settings");
    default:
      return { error: json({ error: "عرض غير معروف." }, 400) };
  }
}

// ---------- POST ----------
async function handlePost(env, token, body) {
  const bad = (message) => ({ error: json({ error: message }, 400) });

  switch (body.action) {
    case "set_job_status": {
      if (!validId(body.jobId)) return bad("معرّف الوظيفة غير صالح.");
      if (!JOB_NEW_STATUSES.has(body.status)) return bad("حالة غير صالحة.");
      return callRpc(env, token, "admin_set_job_status", {
        p_job_id: body.jobId,
        p_status: body.status,
        p_reason: text(body.reason, 200) || null
      });
    }
    case "delete_job": {
      if (!validId(body.jobId)) return bad("معرّف الوظيفة غير صالح.");
      return callRpc(env, token, "admin_delete_job", {
        p_job_id: body.jobId,
        p_reason: text(body.reason, 200) || null
      });
    }
    case "resolve_report": {
      if (!validId(body.reportId)) return bad("معرّف البلاغ غير صالح.");
      if (!REPORT_ACTIONS.has(body.resolution)) return bad("قرار غير صالح.");
      return callRpc(env, token, "admin_resolve_job_report", {
        p_report_id: body.reportId,
        p_action: body.resolution,
        p_note: text(body.note, 200) || null
      });
    }
    case "save_ad": {
      const title = text(body.title, 80);
      const imageUrl = text(body.imageUrl, 500);
      const linkUrl = text(body.linkUrl, 500);
      if (!title) return bad("عنوان الإعلان مطلوب.");
      if (!/^https:\/\/\S+$/i.test(imageUrl)) return bad("رابط الصورة يجب أن يبدأ بـ https://");
      if (linkUrl && !/^https?:\/\/\S+$/i.test(linkUrl)) return bad("رابط الإعلان يجب أن يبدأ بـ http:// أو https://");
      if (body.id !== undefined && body.id !== null && body.id !== "" && !validId(body.id)) return bad("معرّف الإعلان غير صالح.");
      const startsAt = isoOrNull(body.startsAt);
      const endsAt = isoOrNull(body.endsAt);
      if (startsAt.invalid || endsAt.invalid) return bad("تاريخ غير صالح.");
      if (startsAt.value && endsAt.value && Date.parse(endsAt.value) <= Date.parse(startsAt.value)) {
        return bad("تاريخ النهاية يجب أن يكون بعد تاريخ البداية.");
      }
      const priority = body.priority === undefined || body.priority === "" ? 0 : Number(body.priority);
      if (!Number.isInteger(priority) || priority < -1000 || priority > 1000) return bad("الأولوية بين -1000 و1000.");
      return callRpc(env, token, "admin_upsert_job_ad", {
        p_title: title,
        p_image_url: imageUrl,
        p_link_url: linkUrl || null,
        p_is_active: body.isActive !== false,
        p_starts_at: startsAt.value,
        p_ends_at: endsAt.value,
        p_priority: priority,
        p_id: body.id || null
      });
    }
    case "delete_ad": {
      if (!validId(body.id)) return bad("معرّف الإعلان غير صالح.");
      return callRpc(env, token, "admin_delete_job_ad", { p_id: body.id });
    }
    case "add_word": {
      const word = text(body.word, 60);
      if (word.length < 2) return bad("الكلمة قصيرة جداً (حرفان على الأقل).");
      return callRpc(env, token, "admin_add_job_blocked_word", {
        p_word: word,
        p_whole_word: body.wholeWord === true
      });
    }
    case "delete_word": {
      if (!validId(body.id)) return bad("معرّف الكلمة غير صالح.");
      return callRpc(env, token, "admin_delete_job_blocked_word", { p_id: body.id });
    }
    case "save_settings": {
      const params = {};
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") return bad("قيمة التشغيل غير صالحة.");
        params.p_enabled = body.enabled;
      }
      const ranges = [
        ["adEveryN", "p_ad_every_n", 2, 20, "عدد الوظائف بين كل إعلان من 2 إلى 20."],
        ["maxActive", "p_max_active", 1, 50, "الحد الأقصى للوظائف الفعّالة من 1 إلى 50."],
        ["expiryDays", "p_expiry_days", 1, 365, "مدة الوظيفة من 1 إلى 365 يوماً."],
        ["reportThreshold", "p_report_threshold", 0, 50, "عتبة الإخفاء بالبلاغات من 0 إلى 50."]
      ];
      for (const [field, param, min, max, message] of ranges) {
        if (body[field] === undefined) continue;
        const value = Number(body[field]);
        if (!Number.isInteger(value) || value < min || value > max) return bad(message);
        params[param] = value;
      }
      if (Object.keys(params).length === 0) return bad("لا توجد قيم للحفظ.");
      return callRpc(env, token, "admin_set_jobs_settings", params);
    }
    default:
      return bad("إجراء غير معروف.");
  }
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "طريقة الطلب غير مدعومة." }, 405);
  }

  try {
    const auth = await authorizeAdmin(request, env);
    if (auth.error) return auth.error;
    const token = bearerToken(request);

    if (request.method === "GET") {
      const result = await handleGet(env, token, new URL(request.url));
      if (result.error) return result.error;
      return json({ role: auth.role, data: result.data });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "البيانات المرسلة غير صالحة." }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "البيانات المرسلة غير صالحة." }, 400);
    }
    if (OWNER_ONLY_ACTIONS.has(body.action) && auth.role !== "owner") {
      return json({ error: "هذا الإجراء مخصص للمالك فقط." }, 403);
    }

    const result = await handlePost(env, token, body);
    if (result.error) return result.error;
    return json({ success: true, result: result.data });
  } catch (error) {
    console.error("Jobs API error:", error);
    return json({ error: "حدث خطأ غير متوقع. حاول مجدداً." }, 500);
  }
}
