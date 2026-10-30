import { audit, authorizeAdmin, changes, json, readSettings } from "../_lib/admin.js";

const BUCKET = "payment-assets";
const MAX_IMAGE_SIZE = 3 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
};

function serviceHeaders(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
    ...extra
  };
}

function publicUrl(env, path) {
  if (!path) return "";
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return env.SUPABASE_URL + "/storage/v1/object/public/" + BUCKET + "/" + encoded;
}

async function readPaymentSettings(env) {
  const response = await fetch(
    env.SUPABASE_URL + "/rest/v1/app_settings?select=key,value&key=in.(sham_cash_account_code,sham_cash_qr_path,manual_topup_enabled)",
    { headers: serviceHeaders(env) }
  );
  if (!response.ok) throw new Error("PAYMENT_SETTINGS_READ_FAILED");
  const rows = await response.json();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

async function deleteObject(env, path) {
  if (!path) return;
  const response = await fetch(env.SUPABASE_URL + "/storage/v1/object/" + BUCKET, {
    method: "DELETE",
    headers: serviceHeaders(env),
    body: JSON.stringify({ prefixes: [path] })
  });
  if (!response.ok) console.error("Payment QR cleanup failed:", response.status, await response.text());
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "طريقة الطلب غير مدعومة." }, 405);
  }

  try {
    const auth = await authorizeAdmin(request, env, { requireOwner: request.method === "POST" });
    if (auth.error) return auth.error;

    if (request.method === "GET") {
      const values = await readPaymentSettings(env);
      const accountCode = typeof values.sham_cash_account_code === "string" ? values.sham_cash_account_code : "";
      const qrPath = typeof values.sham_cash_qr_path === "string" ? values.sham_cash_qr_path : "";
      return json({
        accountCode,
        qrPath,
        qrUrl: publicUrl(env, qrPath),
        enabled: values.manual_topup_enabled === true,
        adminRole: auth.role
      });
    }

    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ error: "بيانات النموذج غير صالحة." }, 400);
    }

    const accountCode = String(form.get("accountCode") || "").trim();
    const enabled = form.get("enabled") === "true";
    const removeQr = form.get("removeQr") === "true";
    const file = form.get("qrImage");

    if (accountCode.length > 100 || /[\u0000-\u001f\u007f]/.test(accountCode)) {
      return json({ error: "رمز حساب شام كاش غير صالح." }, 400);
    }

    const before = await readPaymentSettings(env);
    let qrPath = typeof before.sham_cash_qr_path === "string" ? before.sham_cash_qr_path : "";
    let uploadedPath = "";

    if (removeQr) qrPath = "";

    if (file && typeof file !== "string" && file.size > 0) {
      const extension = MIME_EXTENSIONS[file.type];
      if (!extension) return json({ error: "ارفع صورة بصيغة JPG أو PNG أو WEBP فقط." }, 400);
      if (file.size > MAX_IMAGE_SIZE) return json({ error: "حجم الصورة يجب ألا يتجاوز 3 ميغابايت." }, 400);

      uploadedPath = "sham-cash/" + crypto.randomUUID() + "." + extension;
      const uploadResponse = await fetch(
        env.SUPABASE_URL + "/storage/v1/object/" + BUCKET + "/" + uploadedPath,
        {
          method: "POST",
          headers: serviceHeaders(env, {
            "Content-Type": file.type,
            "x-upsert": "false",
            "Cache-Control": "3600"
          }),
          body: await file.arrayBuffer()
        }
      );
      if (!uploadResponse.ok) {
        console.error("Sham Cash QR upload failed:", uploadResponse.status, await uploadResponse.text());
        return json({ error: "تعذّر رفع صورة حساب شام كاش." }, 502);
      }
      qrPath = uploadedPath;
    }

    if (enabled && (!accountCode || !qrPath)) {
      if (uploadedPath) await deleteObject(env, uploadedPath);
      return json({ error: "لا يمكن تفعيل الشحن قبل إدخال رمز الحساب ورفع صورة أو QR." }, 400);
    }

    const values = [
      { key: "sham_cash_account_code", value: accountCode },
      { key: "sham_cash_qr_path", value: qrPath },
      { key: "manual_topup_enabled", value: enabled }
    ];
    const saveResponse = await fetch(
      env.SUPABASE_URL + "/rest/v1/app_settings?on_conflict=key",
      {
        method: "POST",
        headers: serviceHeaders(env, {
          Prefer: "resolution=merge-duplicates,return=representation"
        }),
        body: JSON.stringify(values)
      }
    );
    if (!saveResponse.ok) {
      if (uploadedPath) await deleteObject(env, uploadedPath);
      console.error("Sham Cash settings save failed:", saveResponse.status, await saveResponse.text());
      return json({ error: "تعذّر حفظ إعدادات شام كاش في قاعدة البيانات." }, 502);
    }
    const savedRows = await saveResponse.json();
    if (!Array.isArray(savedRows) || savedRows.length !== values.length) {
      if (uploadedPath) await deleteObject(env, uploadedPath);
      return json({ error: "لم يتأكد النظام من حفظ كل إعدادات شام كاش." }, 502);
    }

    if (before.sham_cash_qr_path && before.sham_cash_qr_path !== qrPath) {
      await deleteObject(env, before.sham_cash_qr_path);
    }

    await audit(env, auth.user.id, "admin_update_settings", "app_settings", null, {
      section: "sham-cash",
      changes: changes(before, {
        sham_cash_account_code: accountCode,
        sham_cash_qr_path: qrPath,
        manual_topup_enabled: enabled
      })
    });

    return json({
      success: true,
      accountCode,
      qrPath,
      qrUrl: publicUrl(env, qrPath),
      enabled
    });
  } catch (error) {
    console.error("Payment settings API failed:", error);
    return json({ error: "حدث خطأ أثناء حفظ إعدادات شام كاش." }, 500);
  }
}
