import { authorizeAdmin, json } from "../_lib/admin.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function serviceHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json"
  };
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "طريقة الطلب غير مدعومة." }, 405);
  }

  try {
    const auth = await authorizeAdmin(request, env, { requireOwner: request.method === "POST" });
    if (auth.error) return auth.error;

    if (request.method === "GET") {
      const userId = new URL(request.url).searchParams.get("userId") || "";
      if (!UUID_RE.test(userId)) return json({ error: "معرّف المستخدم غير صالح." }, 400);
      const response = await fetch(
        env.SUPABASE_URL + "/rest/v1/wallets?select=available_balance,currency&user_id=eq." + userId,
        { headers: serviceHeaders(env) }
      );
      if (!response.ok) return json({ error: "تعذّر قراءة رصيد المستخدم." }, 502);
      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length !== 1) return json({ error: "لم يتم العثور على محفظة لهذا المستخدم." }, 404);
      return json({
        balance: Number(rows[0].available_balance),
        currency: rows[0].currency || "SYP",
        adminRole: auth.role
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "بيانات طلب إضافة الرصيد غير صالحة." }, 400);
    }

    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const amount = Number(body.amount);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";

    if (!UUID_RE.test(userId)) return json({ error: "معرّف المستخدم غير صالح." }, 400);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000) {
      return json({ error: "أدخل مبلغاً صحيحاً أكبر من صفر ولا يتجاوز 100000 ليرة." }, 400);
    }
    if (reason.length < 5 || reason.length > 300) {
      return json({ error: "اكتب سبب الإضافة (من 5 إلى 300 حرف)." }, 400);
    }
    if (!UUID_RE.test(requestId)) return json({ error: "معرّف عملية الإضافة غير صالح. أعد المحاولة." }, 400);

    const token = (request.headers.get("Authorization") || "").slice(7);
    const response = await fetch(env.SUPABASE_URL + "/rest/v1/rpc/admin_topup_wallet", {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        p_user: userId,
        p_amount: amount,
        p_reason: reason,
        p_request_id: requestId
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("admin_topup_wallet failed:", response.status, detail);
      if (detail.includes("INVALID_AMOUNT")) return json({ error: "المبلغ غير صالح." }, 400);
      if (detail.includes("AMOUNT_TOO_LARGE")) return json({ error: "المبلغ يتجاوز الحد المسموح للعملية الواحدة." }, 400);
      if (detail.includes("REASON_REQUIRED")) return json({ error: "سبب الإضافة مطلوب (5 أحرف على الأقل)." }, 400);
      if (detail.includes("USER_NOT_ELIGIBLE")) return json({ error: "يمكن إضافة الرصيد للحسابات الفعّالة غير الإدارية فقط." }, 409);
      if (detail.includes("WALLET_NOT_FOUND")) return json({ error: "لم يتم العثور على محفظة المستخدم." }, 404);
      if (detail.includes("OWNER_ONLY") || response.status === 403) return json({ error: "إضافة الرصيد متاحة للمالك فقط." }, 403);
      return json({ error: "تعذّر إضافة الرصيد. لم يتم تأكيد العملية." }, 502);
    }

    const result = await response.json();
    return json({ success: true, ...result });
  } catch (error) {
    console.error("Wallet top-up API failed:", error);
    return json({ error: "حدث خطأ أثناء إضافة الرصيد." }, 500);
  }
}
