function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Support settings are unavailable" }, 503);
  }

  try {
    const response = await fetch(
      env.SUPABASE_URL + "/rest/v1/app_settings?select=key,value&key=in.(support_email,support_phone)",
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY
        }
      }
    );
    if (!response.ok) return json({ error: "Support settings are unavailable" }, 502);

    const rows = await response.json();
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return json({
      supportEmail: typeof values.support_email === "string" ? values.support_email : "shobdkhelpcenter@gmail.com",
      supportPhone: typeof values.support_phone === "string" ? values.support_phone : ""
    });
  } catch {
    return json({ error: "Support settings are unavailable" }, 500);
  }
}
