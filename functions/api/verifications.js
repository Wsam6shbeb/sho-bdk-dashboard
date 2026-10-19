import { audit, authorizeAdmin, json } from "../_lib/admin.js";

const BUCKET = "verification-documents";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function rest(env, path, options = {}) {
  return fetch(env.SUPABASE_URL + path, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
}

async function signedPhoto(env, path) {
  if (typeof path !== "string" || !path) return null;
  const safePath = path.split("/").map(encodeURIComponent).join("/");
  const response = await rest(env, "/storage/v1/object/sign/" + BUCKET + "/" + safePath, {
    method: "POST",
    body: JSON.stringify({ expiresIn: 300 })
  });
  if (!response.ok) {
    console.error("Verification signed URL failed:", response.status, await response.text());
    return null;
  }
  const data = await response.json();
  const signed = data.signedURL || data.signedUrl;
  if (!signed) return null;
  return signed.startsWith("http") ? signed : env.SUPABASE_URL + "/storage/v1" + (signed.startsWith("/") ? signed : "/" + signed);
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET" && request.method !== "PATCH") {
    return json({ error: "طريقة الطلب غير مدعومة." }, 405);
  }

  try {
    // صور الهوية والسيلفي بيانات شديدة الحساسية؛ الوصول والمراجعة للمالك فقط.
    const auth = await authorizeAdmin(request, env, { requireOwner: true });
    if (auth.error) return auth.error;

    if (request.method === "GET") {
      const response = await rest(
        env,
        "/rest/v1/verifications?select=id,user_id,id_document_url,selfie_url,status,rejection_reason,created_at,reviewed_at&status=eq.pending&order=created_at.desc&limit=100"
      );
      if (!response.ok) {
        console.error("Verification list failed:", response.status, await response.text());
        return json({ error: "تعذّر تحميل طلبات التوثيق." }, 502);
      }
      const rows = await response.json();
      const userIds = [...new Set(rows.map((row) => row.user_id).filter(Boolean))];
      let users = {};
      if (userIds.length) {
        const userResponse = await rest(
          env,
          "/rest/v1/users?select=id,full_name,phone,region&id=in.(" + userIds.join(",") + ")"
        );
        if (userResponse.ok) {
          users = Object.fromEntries((await userResponse.json()).map((user) => [user.id, user]));
        }
      }

      const entries = await Promise.all(rows.map(async (row) => ({
        id: row.id,
        user_id: row.user_id,
        status: row.status,
        rejection_reason: row.rejection_reason,
        created_at: row.created_at,
        reviewed_at: row.reviewed_at,
        user: users[row.user_id] || null,
        id_photo_url: await signedPhoto(env, row.id_document_url),
        selfie_url: await signedPhoto(env, row.selfie_url)
      })));
      return json({ entries });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "بيانات الطلب غير صالحة." }, 400);
    }
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const status = body.status;
    const rejectionReason = typeof body.rejectionReason === "string" ? body.rejectionReason.trim().slice(0, 500) : "";
    if (!UUID.test(id)) return json({ error: "معرّف طلب التوثيق غير صالح." }, 400);
    if (status !== "approved" && status !== "rejected") {
      return json({ error: "القرار يجب أن يكون قبولاً أو رفضاً." }, 400);
    }
    if (status === "rejected" && !rejectionReason) {
      return json({ error: "اكتب سبب الرفض قبل حفظ القرار." }, 400);
    }

    // Update the request and public.users status inside one Postgres transaction.
    const decision = await rest(env, "/rest/v1/rpc/review_verification_request", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        p_verification_id: id,
        p_status: status,
        p_rejection_reason: status === "rejected" ? rejectionReason : null,
        p_reviewed_by: auth.user.id
      })
    });
    if (!decision.ok) {
      const detail = await decision.text();
      console.error("Atomic verification decision failed:", decision.status, detail);
      if (decision.status === 404 || detail.includes("P0002") || detail.includes("not found or already reviewed")) {
        return json({ error: "الطلب غير موجود أو تمت مراجعته مسبقاً؛ حدّث القائمة." }, 409);
      }
      if (detail.includes("A rejection reason is required")) {
        return json({ error: "اكتب سبب الرفض قبل حفظ القرار." }, 400);
      }
      return json({ error: "تعذّر حفظ قرار التوثيق وتحديث حالة المستخدم. لم يُحفظ أي جزء من القرار." }, 502);
    }

    await audit(env, auth.user.id, status === "approved" ? "admin_approve_verification" : "admin_reject_verification", "verification", id, {
      user_id: target.user_id,
      rejection_reason: status === "rejected" ? rejectionReason : null
    });
    return json({ success: true, id, status });
  } catch (error) {
    console.error("Verification API failed:", error);
    return json({ error: "حدث خطأ غير متوقع أثناء معالجة طلب التوثيق." }, 500);
  }
}
