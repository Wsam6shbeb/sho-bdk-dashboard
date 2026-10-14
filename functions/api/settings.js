function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

async function authorize(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return { error: json({ error: "يلزم تسجيل الدخول أولاً." }, 401) };

  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY ||
      !env.SUPABASE_SERVICE_ROLE_KEY || !env.ADMIN_EMAIL) {
    return { error: json({ error: "إعدادات الربط الآمن غير مكتملة في Cloudflare." }, 503) };
  }

  const response = await fetch(env.SUPABASE_URL + "/auth/v1/user", {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: "Bearer " + token
    }
  });

  if (!response.ok) return { error: json({ error: "جلسة الدخول غير صالحة. سجّل الدخول مجدداً." }, 401) };

  const user = await response.json();
  if (!user.email || user.email.toLowerCase() !== env.ADMIN_EMAIL.trim().toLowerCase()) {
    return { error: json({ error: "هذا الحساب غير مخوّل لإدارة التطبيق." }, 403) };
  }

  return { user };
}

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
    const auth = await authorize(request, env);
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
      const allKeys = keys + ",support_email,support_phone," + appKeys.join(",");
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
        commission: values.commission_default,
        isFlat: values.commission_min === values.commission_max &&
          values.commission_max === values.commission_default,
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

    if (body?.action === "support") {
      const email = typeof body.supportEmail === "string" ? body.supportEmail.trim() : "";
      const phone = typeof body.supportPhone === "string" ? body.supportPhone.trim() : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        return json({ error: "أدخل إيميل دعم صحيحاً." }, 400);
      }
      if (phone.length > 40) return json({ error: "رقم الهاتف طويل جداً." }, 400);

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
        if (!response.ok) return json({ error: "تعذّر حفظ معلومات الدعم في قاعدة البيانات." }, 502);
        const updated = await response.json();
        if (!Array.isArray(updated) || updated.length !== 1 || updated[0].key !== key) {
          return json({ error: "لم يتم تأكيد حفظ معلومات الدعم. حدّث الصفحة وتحقق من القيم." }, 500);
        }
      }
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

      return json({ success: true, settings });
    }

    const amount = Number(body?.commission);
    if (!Number.isInteger(amount) || amount < 50 || amount > 1000) {
      return json({ error: "العمولة يجب أن تكون رقماً صحيحاً بين 50 و1000 ليرة سورية جديدة." }, 400);
    }

    // One SQL update through PostgREST keeps all three flat-commission settings in sync.
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

    return json({ success: true, commission: amount });
  } catch {
    return json({ error: "حدث خطأ غير متوقع أثناء الاتصال. لم يتم تأكيد الحفظ." }, 500);
  }
}
