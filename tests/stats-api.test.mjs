import test from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../functions/api/stats.js";

const env = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "SERVICE-SECRET-KEY" };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const tokenFor = (aal) => "h." + b64({ aal }) + ".s";

const RPC_OK = { meta: { days: 30 }, users: {}, providers: {}, requests: {}, categories: [], regions: [], cells: [], owner: { finance: { commission_total: 1 } } };

// يحاكي Supabase: auth + users + app_settings + rpc.
function setup({ userRow, mfaRows = [{ value: true }], rpc = () => new Response(JSON.stringify(RPC_OK), { status: 200 }), authOk = true, emailConfirmed = true } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith("/auth/v1/user")) return authOk ? new Response(JSON.stringify({ id: "u1", email: "a@b.c", email_confirmed_at: emailConfirmed ? "2026-01-01" : null }), { status: 200 }) : new Response("no", { status: 401 });
    if (u.includes("/rest/v1/users?select=is_admin")) return new Response(JSON.stringify(userRow ? [userRow] : []), { status: 200 });
    if (u.includes("/rest/v1/app_settings")) return new Response(JSON.stringify(mfaRows), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/admin_dashboard_stats")) return rpc(init);
    throw new Error("unexpected fetch " + u);
  };
  return calls;
}
const req = (qs = "", { token = tokenFor("aal2"), method = "GET" } = {}) =>
  new Request("https://d.example/api/stats" + qs, { method, headers: token ? { Authorization: "Bearer " + token } : {} });
const owner = { is_admin: true, admin_role: "owner", status: "active", deleted_at: null };
const support = { is_admin: true, admin_role: "support", status: "active", deleted_at: null };
const rpcBody = (calls) => JSON.parse(calls.find((c) => c.url.endsWith("/rpc/admin_dashboard_stats")).init.body);

test("بدون توكن → 401 ولا استدعاء لقاعدة البيانات", async () => {
  const calls = setup({ userRow: owner });
  const res = await onRequest({ request: req("", { token: "" }), env });
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});
test("توكن غير صالح → 401", async () => {
  setup({ userRow: owner, authOk: false });
  assert.equal((await onRequest({ request: req(), env })).status, 401);
});
test("مستخدم عادي (ليس أدمن) → 403 ولا يُستدعى RPC", async () => {
  const calls = setup({ userRow: { is_admin: false, admin_role: null, status: "active" } });
  const res = await onRequest({ request: req(), env });
  assert.equal(res.status, 403);
  assert.ok(!calls.some((c) => c.url.includes("rpc")));
});
test("أدمن موقوف أو محذوف → 403", async () => {
  setup({ userRow: { ...owner, status: "suspended" } });
  assert.equal((await onRequest({ request: req(), env })).status, 403);
  setup({ userRow: { ...owner, deleted_at: "2026-01-01" } });
  assert.equal((await onRequest({ request: req(), env })).status, 403);
});
test("جلسة aal1 → 401 MFA_REQUIRED", async () => {
  setup({ userRow: owner });
  const res = await onRequest({ request: req("", { token: tokenFor("aal1") }), env });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "MFA_REQUIRED");
});
test("إعداد MFA غير مفعّل → 503 (لا تخفيض للمصادقة)", async () => {
  setup({ userRow: owner, mfaRows: [{ value: false }] });
  assert.equal((await onRequest({ request: req(), env })).status, 503);
});
test("طريقة غير GET → 405", async () => {
  setup({ userRow: owner });
  assert.equal((await onRequest({ request: req("", { method: "POST" }), env })).status, 405);
});
test("المالك: يُطلب الجزء المالي ويُعاد", async () => {
  const calls = setup({ userRow: owner });
  const res = await onRequest({ request: req("?days=90&staleHours=72"), env });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.role, "owner");
  assert.deepEqual(rpcBody(calls), { p_days: 90, p_stale_hours: 72, p_include_owner: true });
  assert.ok(body.stats.owner);
});
test("الدعم: لا يُطلب الجزء المالي ويُحذف من الرد حتى لو أعادته قاعدة البيانات", async () => {
  const calls = setup({ userRow: support });
  const res = await onRequest({ request: req(), env });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.role, "support");
  assert.equal(rpcBody(calls).p_include_owner, false);
  assert.equal("owner" in body.stats, false);
});
test("الافتراضيات: 30 يوماً و48 ساعة", async () => {
  const calls = setup({ userRow: owner });
  await onRequest({ request: req(), env });
  const b = rpcBody(calls);
  assert.equal(b.p_days, 30);
  assert.equal(b.p_stale_hours, 48);
});
test("كل الفترات المسموحة تُقبل", async () => {
  for (const d of [0, 7, 30, 90, 365]) {
    setup({ userRow: owner });
    assert.equal((await onRequest({ request: req("?days=" + d), env })).status, 200, "days=" + d);
  }
});
test("مدخلات غير صالحة → 400 دون استدعاء RPC", async () => {
  for (const qs of ["?days=45", "?days=abc", "?days=-1", "?staleHours=0", "?staleHours=721", "?staleHours=1.5", "?staleHours=x", "?days=30%3B%20drop"]) {
    const calls = setup({ userRow: owner });
    const res = await onRequest({ request: req(qs), env });
    assert.equal(res.status, 400, qs);
    assert.ok(!calls.some((c) => c.url.includes("rpc")), qs);
  }
});
test("خطأ SQL من قاعدة البيانات لا يصل للمتصفح", async () => {
  setup({ userRow: owner, rpc: () => new Response('{"code":"42703","message":"column ps.foo does not exist","details":"secret detail"}', { status: 400 }) });
  const res = await onRequest({ request: req(), env });
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.ok(!/42703|column|foo|secret|admin_dashboard_stats|migration|sql/i.test(text), text);
});
test("دالة غير موجودة (404) → رسالة عامة فقط", async () => {
  setup({ userRow: owner, rpc: () => new Response('{"message":"Could not find the function public.admin_dashboard_stats"}', { status: 404 }) });
  const res = await onRequest({ request: req(), env });
  assert.equal(res.status, 502);
  assert.ok(!/admin_dashboard_stats|function/i.test(await res.text()));
});
test("رد غير JSON أو بشكل غير متوقع → 502", async () => {
  setup({ userRow: owner, rpc: () => new Response("<html>", { status: 200 }) });
  assert.equal((await onRequest({ request: req(), env })).status, 502);
  setup({ userRow: owner, rpc: () => new Response(JSON.stringify({ hello: 1 }), { status: 200 }) });
  assert.equal((await onRequest({ request: req(), env })).status, 502);
  setup({ userRow: owner, rpc: () => new Response("[]", { status: 200 }) });
  assert.equal((await onRequest({ request: req(), env })).status, 502);
});
test("مهلة/انقطاع الاتصال → 504 برسالة عامة", async () => {
  setup({ userRow: owner, rpc: () => { const e = new Error("boom"); e.name = "TimeoutError"; throw e; } });
  const res = await onRequest({ request: req(), env });
  assert.equal(res.status, 504);
  assert.ok(!/boom/.test(await res.text()));
});
test("مفتاح Service Role لا يظهر في أي رد ولا يُرسل إلا لقاعدة البيانات", async () => {
  const calls = setup({ userRow: owner });
  const res = await onRequest({ request: req(), env });
  assert.ok(!(await res.text()).includes("SERVICE-SECRET-KEY"));
  for (const c of calls) assert.ok(c.url.startsWith(env.SUPABASE_URL), c.url);
});
test("الرد غير قابل للتخزين المؤقت", async () => {
  setup({ userRow: owner });
  const res = await onRequest({ request: req(), env });
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});
