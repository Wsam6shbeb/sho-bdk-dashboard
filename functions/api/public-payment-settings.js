import { json } from "../_lib/admin.js";

function serviceHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json"
  };
}

// Public endpoint: exposes only the payment details intended for customers.
export async function onRequest({ request, env }) {
  if (request.method !== "GET") {
    return json({ error: "طريقة الطلب غير مدعومة." }, 405);
  }

  try {
    const keys = ["sham_cash_account_code", "sham_cash_qr_path", "manual_topup_enabled"];
    const query = "key=in.(" + keys.join(",") + ")";
    const response = await fetch(
      env.SUPABASE_URL + "/rest/v1/app_settings?select=key,value&" + query,
      { headers: serviceHeaders(env) }
    );

    if (!response.ok) {
      console.error("Public payment settings read failed:", response.status, await response.text());
      return json({ error: "تعذّر تحميل بيانات الشحن." }, 502);
    }

    const rows = await response.json();
    const values = Object.fromEntries(
      (Array.isArray(rows) ? rows : []).map((row) => [row.key, row.value])
    );
    const accountCode = typeof values.sham_cash_account_code === "string"
      ? values.sham_cash_account_code.trim()
      : "";
    const qrPath = typeof values.sham_cash_qr_path === "string"
      ? values.sham_cash_qr_path.trim()
      : "";
    const enabled = values.manual_topup_enabled === true || values.manual_topup_enabled === "true";

    let qrUrl = "";
    if (qrPath && env.SUPABASE_URL) {
      qrUrl = env.SUPABASE_URL.replace(/\/$/, "") + "/storage/v1/object/public/payment-assets/" +
        qrPath.split("/").map(encodeURIComponent).join("/");
    }

    return json({ accountCode, qrUrl, enabled });
  } catch (error) {
    console.error("Public payment settings API failed:", error);
    return json({ error: "حدث خطأ أثناء تحميل بيانات الشحن." }, 500);
  }
}
