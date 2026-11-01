// تشغيل: node --test tests/support-permissions.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { onRequest as verificationsRequest } from "../functions/api/verifications.js";
import { onRequest as walletTopupRequest } from "../functions/api/wallet-topup.js";
import { onRequest as walletLookupRequest } from "../functions/api/wallet-topup-lookup.js";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const VERIFICATION_ID = "33333333-3333-4333-8333-333333333333";
const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service"
};

function token() {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return enc({ alg: "HS256" }) + "." + enc({ sub: ADMIN_ID, aal: "aal2" }) + ".sig";
}

function response(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    json: async () => body,
    text: async () => typeof body === "string" ? body : JSON.stringify(body)
  };
}

function installSupportFetch() {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    const method = init.method || "GET";
    calls.push({ url: value, method, body: init.body });
    if (value.endsWith("/auth/v1/user")) {
      return response({ id: ADMIN_ID, email: "support@example.com", email_confirmed_at: "2026-01-01" });
    }
    if (value.includes("/rest/v1/users?select=is_admin,admin_role")) {
      return response([{ is_admin: true, admin_role: "support", status: "active" }]);
    }
    if (value.includes("/rest/v1/app_settings?select=value")) {
      return response([{ value: true }]);
    }
    if (value.includes("/rest/v1/verifications?select=id,user_id,status")) {
      return response([]);
    }
    if (value.includes("/rest/v1/rpc/decide_verification")) {
      return response({ id: VERIFICATION_ID, status: "approved" });
    }
    if (value.includes("/rest/v1/users?select=id,full_name,phone,topup_code")) {\n      return response([{ id: USER_ID, full_name: "مستخدم تجريبي", phone: "09XXXXXXXX", topup_code: "SHB-ABCDEF1234", status: "active", deleted_at: null, is_admin: false }]);\n    }\n    if (value.includes("/rest/v1/wallets?select=available_balance")) {
      return response([{ available_balance: 1250, currency: "SYP" }]);
    }
    if (value.includes("/rest/v1/rpc/admin_topup_wallet")) {
      return response({ balance_after: 1500, already_processed: false });
    }
    throw new Error("Unexpected upstream request: " + method + " " + value);
  };
  return calls;
}

function makeRequest(method, path, body) {
  return new Request("https://dashboard.example" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token(),
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

test("support can load the verification queue", async () => {
  installSupportFetch();
  const result = await verificationsRequest({
    request: makeRequest("GET", "/api/verifications"),
    env
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { items: [] });
});

test("support can submit a verification decision through the protected API", async () => {
  const calls = installSupportFetch();
  const result = await verificationsRequest({
    request: makeRequest("POST", "/api/verifications", {
      id: VERIFICATION_ID,
      decision: "approved",
      reason: ""
    }),
    env
  });
  assert.equal(result.status, 200);
  assert.equal(calls.some((call) => call.url.includes("/rest/v1/rpc/decide_verification")), true);
});


test("support can look up a wallet by its top-up code", async () => {
  installSupportFetch();
  const result = await walletLookupRequest({
    request: makeRequest("GET", "/api/wallet-topup-lookup?code=SHB-ABCDEF1234"),
    env
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).user.id, USER_ID);
});

test("support can read a wallet and submit a manual top-up", async () => {
  const calls = installSupportFetch();
  const read = await walletTopupRequest({
    request: makeRequest("GET", "/api/wallet-topup?userId=" + USER_ID),
    env
  });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).balance, 1250);

  const write = await walletTopupRequest({
    request: makeRequest("POST", "/api/wallet-topup", {
      userId: USER_ID,
      amount: 250,
      reason: "تأكيد حوالة شام كاش",
      requestId: "44444444-4444-4444-8444-444444444444",
      shamCashTransactionId: "SHAM-12345",
      thankYouMessage: "شكراً"
    }),
    env
  });
  assert.equal(write.status, 200);
  assert.equal(calls.some((call) => call.url.includes("/rest/v1/rpc/admin_topup_wallet")), true);
});
