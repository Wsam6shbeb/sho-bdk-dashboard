import test from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../functions/api/stats-services.js";

const env = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "SERVICE-SECRET-KEY" };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const tokenFor = (aal) => "h." + b64({ aal }) + ".s";

const RPC_OK = { meta: { days: 30 }, filters: { regions: [] }, coverage: {}, scope: {}, demand: [], supply: [] };

function setup({ userRow, mfaRows = [{ value: true }], rpc = () => new Response(JSON.stringify(RPC_OK), { status: 200 }), authOk = true } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith("/auth/v1/user")) return authOk ? new Response(JSON.stringify({ id: "u1", email: "a@b.c", email_confirmed_at: "2026-01-01" }), { status: 200 }) : new Response("no", { status: 401 });
    if (u.includes("/rest/v1/users?select=is_admin")) return new Response(JSON.stringify(userRow ? [userRow] : []), { status: 200 });
    if (u.includes("/rest/v1/app_settings")) return new Response(JSON.stringify(mfaRows), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/admin_services_stats")) return rpc(init);
    throw new Error("unexpected fetch " + u);
  };
  return calls;
}
const req = (qs = "", { token = tokenFor("aal2"), method = "GET" } = {}) =>
  new Request("https://d.example/api/stats-services" + qs, { method, headers: token ? { Authorization: "Bearer " + token } : {} });
const owner = { is_admin: true, admin_role: "owner", status: "active", deleted_at: null };
const support = { is_admin: true, admin_role: "support", status: "active", deleted_at: null };
const rpcBody = (calls) => JSON.parse(calls.find((c) => c.url.endsWith("/rpc/admin_services_stats")).init.body);
const rpcCalled = (calls) => calls.some((c) => c.url.includes("rpc"));

test("بدون توكن → 401 ولا استدعاء لقاعدة البيانات", async () => {
  const calls = setup({ userRow: owner });
  const res = await onRequest({ request: req("", { token: "" }), env });
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});
test("مستخدم عادي → 403 ولا يُستدعى RPC", async () => {
  const calls = setup({ userRow: { is_admin: false, admin_role: null, status: "active" } });
  assert.equal((await onRequest({ request: req(), env })).status, 403);
  assert.ok(!rpcCalled(calls));
});
test("جلسة aal1 → 401 MFA_REQUIRED", async () => {
  setup({ userRow: owner });
  const res = await onRequest({ request: req("", { token: tokenFor("aal1") }), env });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "MFA_REQUIRED");
});
test("طريقة غير GET → 405", async () => {
  setup({ userRow: owner });
  assert.equal((await onRequest({ request: req("", { method: "POST" }), env })).status, 405);
});
test("المالك والدعم كلاهما يرى القسم، والقيم الافتراضية: 30 يوماً بلا فلاتر", async () => {
  for (const [row, role] of [[owner, "owner"], [support, "support"]]) {
    const calls = setup({ userRow: row });
    const res = await onRequest({ request: req(), env });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.role, role);
    assert.deepEqual(rpcBody(calls), { p_days: 30, p_region: null, p_area: null });
  }
});
test("الفلاتر تُمرَّر كمعاملات JSON (محافظة ثم منطقة)", async () => {
  const calls = setup({ userRow: owner });
  const q = "?days=90&region=" + encodeURIComponent("اللاذقية") + "&area=" + encodeURIComponent("سقوبين");
  assert.equal((await onRequest({ request: req(q), env })).status, 200);
  assert.deepEqual(rpcBody(calls), { p_days: 90, p_region: "اللاذقية", p_area: "سقوبين" });
});
test("«غير محدد المنطقة» و«اونلاين» مقبولان", async () => {
  const calls = setup({ userRow: owner });
  assert.equal((await onRequest({ request: req("?region=" + encodeURIComponent("اللاذقية") + "&area=__none__"), env })).status, 200);
  assert.equal(rpcBody(calls).p_area, "__none__");
  setup({ userRow: owner });
  assert.equal((await onRequest({ request: req("?region=" + encodeURIComponent("اونلاين")), env })).status, 200);
});
test("كل الفترات المسموحة تُقبل", async () => {
  for (const d of [0, 7, 30, 90, 365]) {
    setup({ userRow: owner });
    assert.equal((await onRequest({ request: req("?days=" + d), env })).status, 200, "days=" + d);
  }
});
test("مدخلات غير صالحة → 400 دون استدعاء RPC", async () => {
  const lat = encodeURIComponent("اللاذقية");
  const cases = [
    "?days=45", "?days=abc", "?days=-1",
    "?region=" + encodeURIComponent("ماريانا"),
    "?region=" + encodeURIComponent("اللاذقية; drop table users"),
    "?area=" + encodeURIComponent("سقوبين"),                          // منطقة بلا محافظة
    "?region=" + lat + "&area=" + encodeURIComponent("س".repeat(61)),   // أطول من 60
    "?region=" + lat + "&area=" + encodeURIComponent("a\u0000b"),       // محرف تحكم
    "?region=" + lat + "&area=" + encodeURIComponent("a\nb")
  ];
  for (const qs of cases) {
    const calls = setup({ userRow: owner });
    const res = await onRequest({ request: req(qs), env });
    assert.equal(res.status, 400, qs);
    assert.ok(!rpcCalled(calls), qs);
  }
});
test("نص يشبه حقن SQL يُمرَّر كقيمة عادية فقط (JSON) ولا يظهر في عنوان الطلب", async () => {
  const calls = setup({ userRow: owner });
  const evil = "x'; drop table users; --";
  const res = await onRequest({ request: req("?region=" + encodeURIComponent("اللاذقية") + "&area=" + encodeURIComponent(evil)), env });
  assert.equal(res.status, 200);
  assert.equal(rpcBody(calls).p_area, evil);
  const rpcCall = calls.find((c) => c.url.includes("rpc"));
  assert.equal(rpcCall.url, "https://x.supabase.co/rest/v1/rpc/admin_services_stats");
});
test("خطأ من قاعدة البيانات لا يصل للمتصفح", async () => {
  setup({ userRow: owner, rpc: () => new Response('{"code":"42883","message":"function admin_stats_service_group(text) does not exist","details":"secret detail"}', { status: 404 }) });
  const res = await onRequest({ request: req(), env });
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.ok(!/42883|function|admin_stats|secret|does not exist|sql/i.test(text), text);
});
test("رد غير JSON أو بشكل غير متوقع → 502", async () => {
  setup({ userRow: owner, rpc: () => new Response("<html>", { status: 200 }) });
  assert.equal((await onRequest({ request: req(), env })).status, 502);
  setup({ userRow: owner, rpc: () => new Response(JSON.stringify({ hello: 1 }), { status: 200 }) });
  assert.equal((await onRequest({ request: req(), env })).status, 502);
  setup({ userRow: owner, rpc: () => new Response("[]", { status: 200 }) });
  assert.equal((await onRequest({ request: req(), env })).status, 502);
});
test("مهلة/انقطاع → 504 برسالة عامة", async () => {
  setup({ userRow: owner, rpc: () => { const e = new Error("boom"); e.name = "TimeoutError"; throw e; } });
  const res = await onRequest({ request: req(), env });
  assert.equal(res.status, 504);
  assert.ok(!/boom/.test(await res.text()));
});
test("مفتاح Service Role لا يظهر في أي رد ولا يُرسل إلا لقاعدة البيانات، والرد غير قابل للتخزين", async () => {
  const calls = setup({ userRow: owner });
  const res = await onRequest({ request: req(), env });
  assert.ok(!(await res.text()).includes("SERVICE-SECRET-KEY"));
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  for (const c of calls) assert.ok(c.url.startsWith(env.SUPABASE_URL), c.url);
});
