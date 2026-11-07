import test from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../functions/api/app-errors.js";

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service"
};

function token(claims = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return encode({ alg: "HS256" }) + "." + encode({ aal: "aal2", ...claims }) + ".sig";
}

function request({ jwt = token(), method = "GET" } = {}) {
  const headers = jwt ? { Authorization: "Bearer " + jwt } : {};
  return new Request("https://dashboard.test/api/app-errors", { method, headers });
}

function mockAdmin(role = "owner", entries = [], isAdmin = true) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.includes("/auth/v1/user")) {
      return Response.json({ id: "11111111-1111-4111-8111-111111111111", email: "owner@example.test", email_confirmed_at: "2026-01-01" });
    }
    if (value.includes("/rest/v1/users")) {
      return Response.json([{ is_admin: isAdmin, admin_role: role, status: "active" }]);
    }
    if (value.includes("/rest/v1/app_settings")) {
      return Response.json([{ value: true }]);
    }
    if (value.includes("/rest/v1/app_error_log")) {
      return Response.json(entries);
    }
    throw new Error("Unexpected fetch: " + value);
  };
  return calls;
}

test("owner can read only operational error fields", async () => {
  const calls = mockAdmin("owner", [{
    id: 1,
    operation: "analyze_service_request",
    error_code: "GEMINI_RATE_LIMITED",
    http_status: 429,
    attempt_count: 4,
    platform: "android",
    created_at: "2026-11-07T10:00:00Z"
  }]);

  const response = await onRequest({ request: request(), env });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].operation, "analyze_service_request");
  const query = calls.find((url) => url.includes("/rest/v1/app_error_log"));
  assert.ok(query.includes("select=id,operation,error_code,http_status,attempt_count,platform,created_at"));
  assert.equal(query.includes("user_id"), false);
});

test("support role cannot read the application error log", async () => {
  const calls = mockAdmin("support");
  const response = await onRequest({ request: request(), env });
  assert.equal(response.status, 403);
  assert.equal(calls.some((url) => url.includes("/rest/v1/app_error_log")), false);
});

test("requests without an access token are rejected before any privileged lookup", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    throw new Error("Fetch must not be called without a token");
  };

  const response = await onRequest({ request: request({ jwt: null }), env });
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test("aal1 sessions cannot read the application error log", async () => {
  const calls = mockAdmin("owner");
  const response = await onRequest({ request: request({ jwt: token({ aal: "aal1" }) }), env });
  assert.equal(response.status, 401);
  assert.equal(calls.some((url) => url.includes("/rest/v1/app_error_log")), false);
});

test("authenticated non-admin users cannot read the application error log", async () => {
  const calls = mockAdmin("owner", [], false);
  const response = await onRequest({ request: request(), env });
  assert.equal(response.status, 403);
  assert.equal(calls.some((url) => url.includes("/rest/v1/app_error_log")), false);
});

test("non-GET methods are rejected", async () => {
  const response = await onRequest({ request: request({ method: "POST" }), env });
  assert.equal(response.status, 405);
});
