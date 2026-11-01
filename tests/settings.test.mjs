// تشغيل: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../functions/api/settings.js";

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service"
};

function token() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return encode({ alg: "HS256" }) + "." + encode({
    sub: "11111111-1111-4111-8111-111111111111",
    aal: "aal2"
  }) + ".signature";
}

test("security settings cannot disable mandatory dashboard MFA", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method || "GET" });
    if (url.includes("/auth/v1/user")) {
      return Response.json({
        id: "11111111-1111-4111-8111-111111111111",
        email: "owner@example.com",
        email_confirmed_at: "2026-01-01T00:00:00Z"
      });
    }
    if (url.includes("/rest/v1/users?")) {
      return Response.json([{ is_admin: true, admin_role: "owner", status: "active" }]);
    }
    if (url.includes("/rest/v1/app_settings?")) {
      return Response.json([{ value: true }]);
    }
    throw new Error("Unexpected request: " + url);
  };

  try {
    const request = new Request("https://dashboard.example.com/api/settings", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ action: "security", requireMfa: false })
    });
    const response = await onRequest({ request, env });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /لا يمكن تعطيله/);
    assert.equal(calls.some((call) => call.method === "PATCH"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
