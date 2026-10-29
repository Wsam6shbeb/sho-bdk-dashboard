// تشغيل: node --test tests/users.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { onRequest, buildUserFilter } from "../functions/api/users.js";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  ADMIN_EMAIL: "owner@example.com"
};

function token(claims = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return enc({ alg: "HS256" }) + "." + enc(claims) + ".sig";
}

function headers(h) {
  return { get: (k) => h[k.toLowerCase()] ?? null };
}

// A tiny router over the upstream calls the API makes.
function installFetch({ targetRow, targetEmail = "someone@example.com", authAdminOk = true, deleteRpcError = null } = {}) {
  const log = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    log.push({ url: u, method, body: init.body });
    const res = (body, status = 200, h = {}) => ({
      ok: status < 400, status, headers: headers(h), json: async () => body, text: async () => JSON.stringify(body)
    });
    if (u.endsWith("/auth/v1/user")) return res({ id: ADMIN_ID, email: "owner@example.com", email_confirmed_at: "2026-01-01" });
    if (u.includes("/rest/v1/users?select=is_admin,admin_role")) return res([{ is_admin: true, admin_role: "owner", status: "active" }]);
    if (u.includes("/rest/v1/app_settings")) return res([{ value: false }]);
    if (u.includes("/auth/v1/admin/users/" + TARGET_ID) && method === "GET") {
      return authAdminOk ? res({ id: TARGET_ID, email: targetEmail }) : res({}, 500);
    }
    if (u.includes("/auth/v1/admin/users/" + TARGET_ID) && method === "PUT") return res({});
    if (u.includes("/rest/v1/rpc/admin_delete_user") && method === "POST") {
      return deleteRpcError ? res({ message: deleteRpcError }, 400) : res(null, 204);
    }
    if (u.includes("/rest/v1/users?select=id,status,is_admin,deleted_at")) return res(targetRow ? [targetRow] : []);
    if (u.includes("/rest/v1/users?id=eq." + TARGET_ID) && method === "PATCH") return res([{ id: TARGET_ID, status: "suspended" }]);
    if (u.includes("/rest/v1/audit_log")) return res({}, 201);
    if (u.includes("/rest/v1/provider_profiles")) return res([]);
    if (u.includes("/rest/v1/users?select=id") && method === "HEAD") {
      const n = u.includes("is_provider=eq.true") ? 40 : u.includes("status=eq.active") ? 110 : 130;
      return res({}, 200, { "content-range": "*/" + n });
    }
    if (u.includes("/rest/v1/users?select=id,full_name")) {
      return res([{ id: TARGET_ID, full_name: "Test", rating_count: 0, rating_avg: 5 }], 200, { "content-range": "25-49/57" });
    }
    throw new Error("unexpected fetch: " + method + " " + u);
  };
  return log;
}

const call = (method, path, body) =>
  onRequest({
    request: new Request("https://dash.example" + path, {
      method,
      headers: { Authorization: "Bearer " + token(), "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    }),
    env
  });

test("GET pages from the server with filter, offset and a global summary", async () => {
  const log = installFetch();
  const response = await call("GET", "/api/users?page=2&pageSize=25&filter=providers&q=%D8%B3");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.page, 2);
  assert.equal(body.pageSize, 25);
  assert.equal(body.total, 57);
  assert.deepEqual(body.summary, { total: 130, providers: 40, active: 110 });
  const listCall = log.find((c) => c.url.includes("select=id,full_name"));
  assert.match(listCall.url, /offset=25/);
  assert.match(listCall.url, /limit=25/);
  assert.match(listCall.url, /is_provider=eq\.true/);
  assert.match(listCall.url, /ilike/);
  assert.match(listCall.url, /rating_count/);
});

test("page size is clamped and page never goes below 1", async () => {
  const log = installFetch();
  await call("GET", "/api/users?page=-4&pageSize=100000");
  const listCall = log.find((c) => c.url.includes("select=id,full_name"));
  assert.match(listCall.url, /limit=100&/);
  assert.match(listCall.url, /offset=0/);
});

test("buildUserFilter: strips query-breaking characters and normalizes phone searches", () => {
  assert.equal(buildUserFilter("", "all"), "");
  assert.ok(!/[,()*]/.test(decodeURIComponent(buildUserFilter("a,b)(x*", "all")).replace(/or=\(.*\)/, "")));
  assert.match(decodeURIComponent(buildUserFilter("0912345678", "all")), /phone\.ilike\.\*912345678\*/);
  assert.match(decodeURIComponent(buildUserFilter("+963 912 345", "all")), /phone\.ilike\.\*912345\*/);
  assert.match(buildUserFilter("x", "inactive"), /and=\(or\(status\.neq\.active/);
});

test("PATCH refuses the primary owner even when is_admin is not set (e-mail comes from Auth)", async () => {
  installFetch({ targetRow: { id: TARGET_ID, status: "active", is_admin: false }, targetEmail: "Owner@Example.com" });
  const response = await call("PATCH", "/api/users", { userId: TARGET_ID, status: "suspended" });
  assert.equal(response.status, 403);
});

test("PATCH fails closed if the owner check cannot be performed", async () => {
  installFetch({ targetRow: { id: TARGET_ID, status: "active", is_admin: false }, authAdminOk: false });
  const response = await call("PATCH", "/api/users", { userId: TARGET_ID, status: "suspended" });
  assert.equal(response.status, 502);
});

test("PATCH suspends a normal user and writes an audit entry", async () => {
  const log = installFetch({ targetRow: { id: TARGET_ID, status: "active", is_admin: false } });
  const response = await call("PATCH", "/api/users", { userId: TARGET_ID, status: "suspended" });
  assert.equal(response.status, 200);
  const audited = log.find((c) => c.url.includes("/rest/v1/audit_log"));
  assert.ok(audited, "audit_log write expected");
  assert.equal(JSON.parse(audited.body).action, "admin_set_user_status");
});


test("DELETE anonymizes a normal user through the protected RPC and writes an audit entry", async () => {
  const log = installFetch({ targetRow: { id: TARGET_ID, status: "active", is_admin: false, deleted_at: null } });
  const response = await call("DELETE", "/api/users", { userId: TARGET_ID });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "deleted");
  const rpc = log.find((c) => c.url.includes("/rest/v1/rpc/admin_delete_user"));
  assert.ok(rpc, "admin deletion RPC expected");
  assert.equal(rpc.method, "POST");
  assert.deepEqual(JSON.parse(rpc.body), { p_user_id: TARGET_ID });
  const audited = log.find((c) => c.url.includes("/rest/v1/audit_log"));
  assert.ok(audited, "audit_log write expected");
  assert.equal(JSON.parse(audited.body).action, "admin_delete_user");
});

test("DELETE refuses the primary owner even if its public row is not marked admin", async () => {
  installFetch({
    targetRow: { id: TARGET_ID, status: "active", is_admin: false, deleted_at: null },
    targetEmail: "Owner@Example.com"
  });
  const response = await call("DELETE", "/api/users", { userId: TARGET_ID });
  assert.equal(response.status, 403);
});

test("DELETE refuses accounts with active work", async () => {
  installFetch({
    targetRow: { id: TARGET_ID, status: "active", is_admin: false, deleted_at: null },
    deleteRpcError: "ACTIVE_WORK_IN_PROGRESS"
  });
  const response = await call("DELETE", "/api/users", { userId: TARGET_ID });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /قيد التنفيذ/);
});

test("DELETE refuses an already deleted account without calling the RPC", async () => {
  const log = installFetch({
    targetRow: { id: TARGET_ID, status: "deleted", is_admin: false, deleted_at: "2026-10-01T00:00:00Z" }
  });
  const response = await call("DELETE", "/api/users", { userId: TARGET_ID });
  assert.equal(response.status, 409);
  assert.equal(log.some((c) => c.url.includes("/rest/v1/rpc/admin_delete_user")), false);
});
