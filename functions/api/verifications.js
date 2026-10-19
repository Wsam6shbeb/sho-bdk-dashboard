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

    const lookup = await rest(env, "/rest/v1/verifications?select=id,user_id,status&id=eq." + encodeURIComponent(id) + "&limit=1");
    if (!lookup.ok) return json({ error: "تعذّر التحقق من طلب التوثيق." }, 502);
    const matches = await lookup.json();
    const target = matches[0];
    if (!target) return json({ error: "طلب التوثيق غير موجود." }, 404);
    if (target.status !== "pending") return json({ error: "تمت مراجعة هذا الطلب مسبقاً؛ حدّث القائمة." }, 409);

    const now = new Date().toISOString();
    const update = await rest(env, "/rest/v1/verifications?id=eq." + encodeURIComponent(id) + "&status=eq.pending", {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        status,
        rejection_reason: status === "rejected" ? rejectionReason : null,
        reviewed_by: auth.user.id,
        reviewed_at: now
      })
    });
    if (!update.ok) {
      console.error("Verification decision failed:", update.status, await update.text());
      return json({ error: "تعذّر حفظ قرار المراجعة." }, 502);
    }
    const updatedRows = await update.json();
    if (!updatedRows.length) return json({ error: "تمت مراجعة هذا الطلب من جلسة أخرى؛ حدّث القائمة." }, 409);

    const userUpdate = await rest(
      env,
      "/rest/v1/users?id=eq." + encodeURIComponent(target.user_id),
      { method: "PATCH", body: JSON.stringify({ verification_status: status }) }
    );
    if (!userUpdate.ok) {
      console.error("User verification status sync failed:", userUpdate.status, await userUpdate.text());
      return json({ error: "حُفظ قرار الطلب لكن تعذّر تحديث حالة المستخدم؛ يلزم إصلاح المزامنة قبل المتابعة." }, 502);
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
