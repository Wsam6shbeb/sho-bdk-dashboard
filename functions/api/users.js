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
    return { error: json({ error: "تعذّر تسجيل الدخول. تحقق من بياناتك وحاول مجدداً." }, 403) };
  }
  return { user };
}

async function supabaseRequest(env, path) {
  return fetch(env.SUPABASE_URL + path, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json"
    }
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") {
    return json({ error: "طريقة الطلب غير مدعومة." }, 405);
  }

  try {
    const auth = await authorize(request, env);
    if (auth.error) return auth.error;

    const usersResponse = await supabaseRequest(
      env,
      "/rest/v1/users?select=id,full_name,phone,region,is_provider,verification_status,status,created_at,deleted_at&order=created_at.desc&limit=500"
    );
    if (!usersResponse.ok) return json({ error: "تعذّر تحميل قائمة المستخدمين." }, 502);

    const users = await usersResponse.json();
    if (!Array.isArray(users)) return json({ error: "وصلت بيانات مستخدمين غير صالحة." }, 502);
    if (users.length === 0) return json({ users: [], total: 0 });

    const ids = users.map((user) => user.id).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (ids.length === 0) return json({ users: users.map((user) => ({ ...user, provider: null })), total: users.length });

    const profilesResponse = await supabaseRequest(
      env,
      "/rest/v1/provider_profiles?select=user_id,rating_avg,completed_services_count,is_available&user_id=in.(" + ids.join(",") + ")"
    );
    if (!profilesResponse.ok) return json({ error: "تعذّر تحميل تفاصيل مقدّمي الخدمات." }, 502);

    const profiles = await profilesResponse.json();
    const profileByUserId = new Map(profiles.map((profile) => [profile.user_id, profile]));
    const result = users.map((user) => ({
      ...user,
      provider: profileByUserId.get(user.id) || null
    }));

    return json({ users: result, total: result.length });
  } catch {
    return json({ error: "حدث خطأ أثناء تحميل المستخدمين. حاول مجدداً." }, 500);
  }
}
