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
      const response = await supabaseRequest(
        env,
        "/rest/v1/app_settings?select=key,value&key=in.(" + keys + ")"
      );
      if (!response.ok) return json({ error: "تعذّر قراءة إعداد العمولة من قاعدة البيانات." }, 502);

      const rows = await response.json();
      const values = Object.fromEntries(rows.map((row) => [row.key, Number(row.value)]));
      if (![values.commission_min, values.commission_max, values.commission_default].every(Number.isFinite)) {
        return json({ error: "إعدادات العمولة في قاعدة البيانات ناقصة أو غير صالحة." }, 500);
      }

      return json({
        commission: values.commission_default,
        isFlat: values.commission_min === values.commission_max &&
          values.commission_max === values.commission_default
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "البيانات المرسلة غير صالحة." }, 400);
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
