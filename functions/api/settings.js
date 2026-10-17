import { audit, authorizeAdmin, changes, json, readSettings } from "../_lib/admin.js";

async function supabaseRequest(env, path, options = {}) {
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

export async function onRequest({ request, env }) {
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "طريقة الطلب غير مدعومة." }, 405);
  }

  try {
    const auth = await authorizeAdmin(request, env, { requireOwner: request.method !== "GET" });
    if (auth.error) return auth.error;

    const keys = "commission_min,commission_max,commission_default";

    if (request.method === "GET") {
      const appKeys = [
        "agreement_approval_timeout_seconds",
        "chat_writable_after_completion_days",
        "currency",
        "launch_region",
        "notification_retention_days",
        "rating_window_hours",
        "signup_bonus_amount",
        "test_topup_enabled"
      ];
      const allKeys = keys + ",support_email,support_phone,dashboard_require_mfa," + appKeys.join(",");
      const response = await supabaseRequest(
        env,
        "/rest/v1/app_settings?select=key,value&key=in.(" + allKeys + ")"
      );
      if (!response.ok) return json({ error: "تعذّر قراءة إعدادات التطبيق من قاعدة البيانات." }, 502);

      const rows = await response.json();
      const rawValues = Object.fromEntries(rows.map((row) => [row.key, row.value]));
      const values = Object.fromEntries(rows.map((row) => [row.key, Number(row.value)]));
      if (![values.commission_min, values.commission_max, values.commission_default].every(Number.isFinite)) {
        return json({ error: "إعدادات العمولة في قاعدة البيانات ناقصة أو غير صالحة." }, 500);
      }

      return json({
        commissionMin: values.commission_min,
        commissionMax: values.commission_max,
        commissionDefault: values.commission_default,
        commission: values.commission_default,
        isFlat: values.commission_min === values.commission_max &&
          values.commission_max === values.commission_default,
        adminRole: auth.role,
        sessionAal: auth.aal,
        dashboardRequireMfa: rawValues.dashboard_require_mfa === true,
        supportEmail: typeof rawValues.support_email === "string" ? rawValues.support_email : "shobdkhelpcenter@gmail.com",
        supportPhone: typeof rawValues.support_phone === "string" ? rawValues.support_phone : "",
        appSettings: Object.fromEntries([
          "agreement_approval_timeout_seconds",
          "chat_writable_after_completion_days",
          "currency",
          "launch_region",
          "notification_retention_days",
          "rating_window_hours",
          "signup_bonus_amount",
          "test_topup_enabled"
        ].map((key) => [key, rawValues[key] ?? null]))
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "البيانات المرسلة غير صالحة." }, 400);
    }

    if (body?.action === "security") {
      // Requiring MFA for everyone is only allowed from a session that already passed MFA (aal2),
      // otherwise the owner could lock themselves out of the dashboard.
      if (typeof body.requireMfa !== "boolean") {
        return json({ error: "قيمة الإعداد غير صالحة." }, 400);
      }
      if (body.requireMfa && auth.aal !== "aal2") {
        return json({ error: "سجّل جهاز التحقق بخطوتين وادخل بجلسة محقَّقة قبل إلزامه." }, 400);
      }
      const securityBefore = await readSettings(env, ["dashboard_require_mfa"]);
      const saved = await supabaseRequest(env, "/rest/v1/app_settings?key=eq.dashboard_require_mfa", {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ value: body.requireMfa })
      });
      const savedRows = saved.ok ? await saved.json() : [];
      if (!saved.ok || !Array.isArray(savedRows) || savedRows.length !== 1) {
        return json({ error: "تعذّر حفظ إعداد الأمان في قاعدة البيانات." }, 502);
      }
      await audit(env, auth.user.id, "admin_update_settings", "app_settings", null, {
        section: "security",
        changes: changes(securityBefore, { dashboard_require_mfa: body.requireMfa })
      });
      return json({ success: true, dashboardRequireMfa: body.requireMfa });
    }

    if (body?.action === "support") {
      const email = typeof body.supportEmail === "string" ? body.supportEmail.trim() : "";
      const phone = typeof body.supportPhone === "string" ? body.supportPhone.trim() : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        return json({ error: "أدخل إيميل دعم صحيحاً." }, 400);
      }
      if (phone.length > 40) return json({ error: "رقم الهاتف طويل جداً." }, 400);

      const supportBefore = await readSettings(env, ["support_email", "support_phone"]);
      for (const [key, value] of [["support_email", email], ["support_phone", phone]]) {
        // Upsert also creates the setting if its row is missing (for example, support_phone).
        const response = await supabaseRequest(
          env,
          "/rest/v1/app_settings?on_conflict=key",
          {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=representation" },
            body: JSON.stringify({ key, value })
          }
        );
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          return json({
            error: "تعذّر حفظ معلومات الدعم في قاعدة البيانات.",
            detail: detail.slice(0, 500)
          }, 502);
        }
        const updated = await response.json();
        if (!Array.isArray(updated) || updated.length !== 1 || updated[0].key !== key) {
          return json({ error: "لم يتم تأكيد حفظ معلومات الدعم. حدّث الصفحة وتحقق من القيم." }, 500);
        }
      }
      await audit(env, auth.user.id, "admin_update_settings", "app_settings", null, {
        section: "support",
        changes: changes(supportBefore, { support_email: email, support_phone: phone })
      });
      return json({ success: true, supportEmail: email, supportPhone: phone });
    }

    if (body?.action === "app-settings") {
      const settings = body.settings;
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
        return json({ error: "إعدادات التطبيق المرسلة غير صالحة." }, 400);
      }

      const rules = {
        agreement_approval_timeout_seconds: (value) => Number.isInteger(value) && value >= 30 && value <= 3600,
        chat_writable_after_completion_days: (value) => Number.isInteger(value) && value >= 0 && value <= 365,
        currency: (value) => typeof value === "string" && /^[A-Z]{3}$/.test(value),
        launch_region: (value) => typeof value === "string" && value.trim().length >= 2 && value.trim().length <= 100,
        notification_retention_days: (value) => Number.isInteger(value) && value >= 1 && value <= 365,
        rating_window_hours: (value) => Number.isInteger(value) && value >= 1 && value <= 720,
        signup_bonus_amount: (value) => Number.isInteger(value) && value >= 0 && value <= 1000000,
        test_topup_enabled: (value) => typeof value === "boolean"
      };
      const entries = Object.entries(settings);
      if (!entries.length || entries.some(([key, value]) => !rules[key] || !rules[key](value))) {
        return json({ error: "توجد قيمة غير صالحة. راجع الحقول وحدودها قبل الحفظ." }, 400);
      }

      const appBefore = await readSettings(env, entries.map(([key]) => key));
      for (const [key, value] of entries) {
        const response = await supabaseRequest(
          env,
          "/rest/v1/app_settings?key=eq." + encodeURIComponent(key),
          {
            method: "PATCH",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({ value: key === "launch_region" ? value.trim() : value })
          }
        );
        if (!response.ok) return json({ error: "تعذّر حفظ الإعداد «" + key + "». قد تكون بعض القيم السابقة قد حُفظت؛ أعد تحميل الإعدادات للتحقق." }, 502);
        const updated = await response.json();
        if (!Array.isArray(updated) || updated.length !== 1) {
          return json({ error: "لم يتم تأكيد حفظ الإعداد «" + key + "». أعد تحميل الإعدادات للتحقق." }, 500);
        }
      }

      await audit(env, auth.user.id, "admin_update_settings", "app_settings", null, {
        section: "app-settings",
        changes: changes(appBefore, Object.fromEntries(entries.map(([key, value]) => [key, key === "launch_region" ? value.trim() : value])))
      });
      return json({ success: true, settings });
    }

    if (body?.action === "commission-settings") {
      const values = {
        commission_min: Number(body.commissionMin),
        commission_max: Number(body.commissionMax),
        commission_default: Number(body.commissionDefault)
      };
      if (!Object.values(values).every(Number.isInteger) ||
          Object.values(values).some(value => value < 50 || value > 1000)) {
        return json({ error: "يجب أن تكون قيم العمولة أعداداً صحيحة بين 50 و1000 ليرة سورية جديدة." }, 400);
      }
      if (values.commission_min > values.commission_max ||
          values.commission_default < values.commission_min ||
          values.commission_default > values.commission_max) {
        return json({ error: "يجب أن يكون الحد الأدنى أقل من أو يساوي الحد الأعلى، والعمولة الافتراضية بينهما." }, 400);
      }

      const commissionBefore = await readSettings(env, Object.keys(values));
      for (const [key, value] of Object.entries(values)) {
        const response = await supabaseRequest(
          env,
          "/rest/v1/app_settings?key=eq." + key,
          {
            method: "PATCH",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({ value })
          }
        );
        if (!response.ok) return json({ error: "تعذّر حفظ إعداد العمولة «" + key + "». أعد تحميل الإعدادات للتحقق." }, 502);
        const rows = await response.json();
        if (!Array.isArray(rows) || rows.length !== 1) {
          return json({ error: "لم يتأكد النظام من حفظ إعداد العمولة «" + key + "». أعد تحميل الإعدادات للتحقق." }, 500);
        }
      }
      await audit(env, auth.user.id, "admin_update_settings", "app_settings", null, {
        section: "commission",
        changes: changes(commissionBefore, values)
      });
      return json({
        success: true,
        commissionMin: values.commission_min,
        commissionMax: values.commission_max,
        commissionDefault: values.commission_default
      });
    }

    // Keep compatibility with older dashboard clients that still submit one flat commission.
    const amount = Number(body?.commission);
    if (!Number.isInteger(amount) || amount < 50 || amount > 1000) {
      return json({ error: "العمولة يجب أن تكون رقماً صحيحاً بين 50 و1000 ليرة سورية جديدة." }, 400);
    }
    const legacyBefore = await readSettings(env, keys.split(","));
    const response = await supabaseRequest(
      env,
      "/rest/v1/app_settings?key=in.(" + keys + ")",
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ value: amount })
      }
    );
    if (!response.ok) return json({ error: "لم يتم حفظ العمولة. لم نغيّر أي إعداد آخر." }, 502);
    const updatedRows = await response.json();
    if (!Array.isArray(updatedRows) || updatedRows.length !== 3) {
      return json({ error: "لم يتأكد النظام من تحديث إعدادات العمولة الثلاثة. افحص الإعدادات قبل إعادة المحاولة." }, 500);
    }
    await audit(env, auth.user.id, "admin_update_settings", "app_settings", null, {
      section: "commission-flat",
      changes: changes(legacyBefore, Object.fromEntries(keys.split(",").map((key) => [key, amount])))
    });
    return json({ success: true, commission: amount });
  } catch {
    return json({ error: "حدث خطأ غير متوقع أثناء الاتصال. لم يتم تأكيد الحفظ." }, 500);
  }
}
