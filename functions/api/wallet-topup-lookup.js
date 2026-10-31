import { authorizeAdmin, json } from "../_lib/admin.js";

const CODE_RE = /^SHB-[A-F0-9]{10}$/i;

function serviceHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json"
  };
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return json({ error: "طريقة الطلب غير مدعومة." }, 405);

  try {
    const auth = await authorizeAdmin(request, env, { requireOwner: true });
    if (auth.error) return auth.error;

    const code = (new URL(request.url).searchParams.get("code") || "").trim().toUpperCase();
    if (!CODE_RE.test(code)) return json({ error: "رمز الشحن غير صالح." }, 400);

    const userResponse = await fetch(
      env.SUPABASE_URL + "/rest/v1/users?select=id,full_name,phone,topup_code,status,deleted_at,is_admin&topup_code=eq." + encodeURIComponent(code) + "&limit=1",
      { headers: serviceHeaders(env) }
    );
    if (!userResponse.ok) return json({ error: "تعذّر البحث عن المستخدم." }, 502);
    const users = await userResponse.json();
    if (!Array.isArray(users) || users.length !== 1) return json({ error: "لم نعثر على مستخدم بهذا الرمز." }, 404);

    const user = users[0];
    if (user.status !== "active" || user.deleted_at || user.is_admin) {
      return json({ error: "هذا الحساب غير مؤهل لاستقبال الرصيد." }, 409);
    }

    const walletResponse = await fetch(
      env.SUPABASE_URL + "/rest/v1/wallets?select=available_balance,currency&user_id=eq." + user.id + "&limit=1",
      { headers: serviceHeaders(env) }
    );
    if (!walletResponse.ok) return json({ error: "تعذّر قراءة محفظة المستخدم." }, 502);
    const wallets = await walletResponse.json();
    if (!Array.isArray(wallets) || wallets.length !== 1) {
      return json({ error: "لم يتم العثور على محفظة لهذا المستخدم." }, 404);
    }

    return json({
      user: {
        id: user.id,
        name: user.full_name || "",
        phone: user.phone || "",
        topupCode: user.topup_code
      },
      balance: Number(wallets[0].available_balance),
      currency: wallets[0].currency || "SYP"
    });
  } catch (error) {
    console.error("Top-up code lookup failed:", error);
    return json({ error: "حدث خطأ أثناء البحث عن رمز الشحن." }, 500);
  }
}
