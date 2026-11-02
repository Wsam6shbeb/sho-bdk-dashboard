// تشغيل: node --test tests/admins.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../functions/api/admins.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const SUPPORT_ID = "22222222-2222-4222-8222-222222222222";
const FACTOR_ID = "33333333-3333-4333-8333-333333333333";
const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service"
};

function token(aal = "aal2") {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return enc({ alg: "HS256" }) + "." + enc({ sub: OWNER_ID, aal }) + ".sig";
}
function response(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function setupFetch({ targetRole = "support", targetIsAdmin = true, targetStatus = "active", targetDeletedAt = null, authEmailConfirmed = true, factorRows = [{ id: FACTOR_ID, factor_type: "totp", status: "verified" }], deleteStatus = 200, auditOk = true } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    calls.push({ url: u, method, body: init.body });
    if (u.endsWith("/auth/v1/user")) return response({ id: OWNER_ID, email: "owner@example.com", email_confirmed_at: "2026-01-01" });
    if (u.includes("/rest/v1/users?select=is_admin,admin_role")) return response([{ is_admin: true, admin_role: "owner", status: "active" }]);
    if (u.includes("/rest/v1/app_settings")) return response([{ value: true }]);
    if (u.includes("/rest/v1/users?select=id,full_name,is_admin,admin_role,status,deleted_at")) {
      return response([{ id: SUPPORT_ID, full_name: "Support", is_admin: targetIsAdmin, admin_role: targetRole, status: targetStatus, deleted_at: targetDeletedAt }]);
    }
    if (u.includes("/rest/v1/users?select=id,full_name,status,is_admin,admin_role,deleted_at")) {
      return response([{ id: SUPPORT_ID, full_name: "Support", is_admin: false, admin_role: null, status: "active", deleted_at: null }]);
    }
    if (u.includes("/rest/v1/users?select=id,full_name")) {
      return response([{ id: OWNER_ID, full_name: "Owner", is_admin: true, admin_role: "owner", status: "active" }, { id: SUPPORT_ID, full_name: "Support", is_admin: true, admin_role: "support", status: "active" }]);
    }
    if (u.endsWith("/auth/v1/admin/users/" + OWNER_ID + "/factors")) return response([]);
    if (u.endsWith("/auth/v1/admin/users/" + OWNER_ID)) return response({ id: OWNER_ID, email: "owner@example.com", email_confirmed_at: "2026-01-01" });
    if (u.endsWith("/auth/v1/admin/users/" + SUPPORT_ID)) return response({ id: SUPPORT_ID, email: "support@example.com", email_confirmed_at: authEmailConfirmed ? "2026-01-01" : null });
    if (u.endsWith("/auth/v1/admin/users/" + SUPPORT_ID + "/factors")) return response(factorRows);
    if (u.endsWith("/auth/v1/admin/users/" + SUPPORT_ID + "/factors/" + FACTOR_ID) && method === "DELETE") return response({}, deleteStatus);
    if (u.includes("/rest/v1/users?id=eq." + SUPPORT_ID) && method === "PATCH") {
      const body = JSON.parse(init.body || "{}");
      return response([{ id: SUPPORT_ID, ...body }]);
    }
    if (u.includes("/rest/v1/audit_log")) return response({}, auditOk ? 201 : 500);
    throw new Error("unexpected fetch: " + method + " " + u);
  };
  return calls;
}
function call(method, body) {
  return onRequest({
    request: new Request("https://dash.example/api/admins", {
      method,
      headers: { Authorization: "Bearer " + token(), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    }),
    env
  });
}

test("GET lists owner and support admins with MFA status", async () => {
  setupFetch();
  const result = await call("GET");
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.admins.length, 2);
  assert.equal(body.admins[0].role, "owner");
  assert.equal(body.admins[0].email, "owner@example.com");
  assert.equal(body.admins[1].role, "support");
  assert.equal(body.admins[1].mfaEnabled, true);
});


test("search returns only eligible non-admin users", async () => {
  setupFetch();
  const request = new Request("https://dash.example/api/admins?search=Support", {
    headers: { Authorization: "Bearer " + token() }
  });
  const result = await onRequest({ request, env });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.users.length, 1);
  assert.equal(body.users[0].email, "support@example.com");
});

test("promotes an active normal user to support and audits the change", async () => {
  const calls = setupFetch({ targetIsAdmin: false, targetRole: null });
  const result = await onRequest({
    request: new Request("https://dash.example/api/admins", {
      method: "POST",
      headers: { Authorization: "Bearer " + token(), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "promote_support", userId: SUPPORT_ID })
    }),
    env
  });
  assert.equal(result.status, 200);
  assert.ok(calls.some((item) => item.method === "PATCH" &&
    item.url.includes("is_admin=eq.false") &&
    JSON.parse(item.body).is_admin === true &&
    JSON.parse(item.body).admin_role === "support"));
  assert.ok(calls.some((item) => item.url.includes("/rest/v1/audit_log") &&
    JSON.parse(item.body).action === "admin_promote_support_completed"));
});

test("removes support role without deleting the account", async () => {
  const calls = setupFetch();
  const result = await onRequest({
    request: new Request("https://dash.example/api/admins", {
      method: "POST",
      headers: { Authorization: "Bearer " + token(), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove_support", userId: SUPPORT_ID })
    }),
    env
  });
  assert.equal(result.status, 200);
  assert.ok(calls.some((item) => item.method === "PATCH" &&
    item.url.includes("admin_role=eq.support") &&
    JSON.parse(item.body).is_admin === false &&
    JSON.parse(item.body).admin_role === null));
  assert.ok(calls.some((item) => item.url.includes("/rest/v1/audit_log") &&
    JSON.parse(item.body).action === "admin_remove_support_completed"));
});


test("does not promote a user whose email is not confirmed", async () => {
  const calls = setupFetch({ targetIsAdmin: false, targetRole: null, authEmailConfirmed: false });
  const result = await onRequest({
    request: new Request("https://dash.example/api/admins", {
      method: "POST",
      headers: { Authorization: "Bearer " + token(), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "promote_support", userId: SUPPORT_ID })
    }),
    env
  });
  assert.equal(result.status, 409);
  assert.equal(calls.some((item) => item.method === "PATCH"), false);
});

test("does not promote a user if audit logging fails", async () => {
  const calls = setupFetch({ targetIsAdmin: false, targetRole: null, auditOk: false });
  const result = await onRequest({
    request: new Request("https://dash.example/api/admins", {
      method: "POST",
      headers: { Authorization: "Bearer " + token(), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "promote_support", userId: SUPPORT_ID })
    }),
    env
  });
  assert.equal(result.status, 502);
  assert.equal(calls.some((item) => item.method === "PATCH"), false);
});

test("does not change an owner account's role", async () => {
  setupFetch({ targetRole: "owner", targetIsAdmin: true });
  const result = await onRequest({
    request: new Request("https://dash.example/api/admins", {
      method: "POST",
      headers: { Authorization: "Bearer " + token(), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove_support", userId: SUPPORT_ID })
    }),
    env
  });
  assert.equal(result.status, 403);
});

test("MFA reset is owner-only and cannot be called by support", async () => {
  setupFetch();
  // Authorizer reads the owner role from the mock; a support caller is tested by changing that row.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/rest/v1/users?select=is_admin,admin_role")) {
      return response([{ is_admin: true, admin_role: "support", status: "active" }]);
    }
    return originalFetch(url, init);
  };
  const result = await call("POST", { action: "reset_mfa", userId: SUPPORT_ID });
  assert.equal(result.status, 403);
});

test("resets only a support user's TOTP factor and records the action", async () => {
  const calls = setupFetch();
  const result = await call("POST", { action: "reset_mfa", userId: SUPPORT_ID });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).deletedFactors, 1);
  assert.ok(calls.some((item) => item.method === "DELETE" && item.url.endsWith("/factors/" + FACTOR_ID)));
  const audit = calls.find((item) => item.url.includes("/rest/v1/audit_log"));
  assert.equal(JSON.parse(audit.body).action, "admin_reset_mfa_requested");
  assert.ok(calls.some((item) => item.url.includes("/rest/v1/audit_log") &&
    JSON.parse(item.body).action === "admin_reset_mfa_completed"));
});

test("does not reset an owner account", async () => {
  setupFetch({ targetRole: "owner" });
  const result = await call("POST", { action: "reset_mfa", userId: SUPPORT_ID });
  assert.equal(result.status, 403);
});

test("does not reset an account without a TOTP factor", async () => {
  setupFetch({ factorRows: [] });
  const result = await call("POST", { action: "reset_mfa", userId: SUPPORT_ID });
  assert.equal(result.status, 409);
});

test("does not delete a factor if audit logging fails", async () => {
  const calls = setupFetch({ auditOk: false });
  const result = await call("POST", { action: "reset_mfa", userId: SUPPORT_ID });
  assert.equal(result.status, 502);
  assert.equal(calls.some((item) => item.method === "DELETE"), false);
});

test("rejects malformed user IDs", async () => {
  setupFetch();
  const result = await call("POST", { userId: "not-a-uuid" });
  assert.equal(result.status, 400);
});
