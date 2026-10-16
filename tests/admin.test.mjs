// تشغيل: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { authorizeAdmin, changes, jwtClaims, audit } from "../functions/_lib/admin.js";

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service"
};

function token(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return enc({ alg: "HS256" }) + "." + enc(claims) + ".sig";
}

// Mock for the three upstream calls the authorizer makes.
function mockFetch({ user, dbRow, mfaRequired = false, userOk = true }) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const u = String(url);
    if (u.includes("/auth/v1/user")) {
      return { ok: userOk, status: userOk ? 200 : 401, json: async () => user, text: async () => "" };
    }
    if (u.includes("/rest/v1/users")) {
      return { ok: true, status: 200, json: async () => (dbRow ? [dbRow] : []), text: async () => "" };
    }
    if (u.includes("/rest/v1/app_settings")) {
      return { ok: true, status: 200, json: async () => [{ value: mfaRequired }], text: async () => "" };
    }
    throw new Error("unexpected fetch " + u);
  };
  return calls;
}

const req = (tok) => ({ headers: { get: (h) => (h === "Authorization" ? (tok ? "Bearer " + tok : "") : null) } });
const goodUser = { id: "11111111-1111-4111-8111-111111111111", email: "a@b.co", email_confirmed_at: "2026-01-01" };

test("no token -> 401", async () => {
  mockFetch({ user: goodUser });
  const r = await authorizeAdmin(req(""), env);
  assert.equal(r.error.status, 401);
});

test("invalid session -> 401", async () => {
  mockFetch({ user: goodUser, userOk: false });
  const r = await authorizeAdmin(req(token({})), env);
  assert.equal(r.error.status, 401);
});

test("unconfirmed email is rejected even if is_admin", async () => {
  mockFetch({ user: { ...goodUser, email_confirmed_at: null }, dbRow: { is_admin: true, status: "active" } });
  const r = await authorizeAdmin(req(token({})), env);
  assert.equal(r.error.status, 403);
});

test("normal user -> 403", async () => {
  mockFetch({ user: goodUser, dbRow: { is_admin: false, status: "active" } });
  const r = await authorizeAdmin(req(token({})), env);
  assert.equal(r.error.status, 403);
});

test("is_admin owner passes; NULL role = owner", async () => {
  mockFetch({ user: goodUser, dbRow: { is_admin: true, admin_role: null, status: "active" } });
  const r = await authorizeAdmin(req(token({})), env, { requireOwner: true });
  assert.equal(r.role, "owner");
});

test("support role can read but not write", async () => {
  mockFetch({ user: goodUser, dbRow: { is_admin: true, admin_role: "support", status: "active" } });
  const read = await authorizeAdmin(req(token({})), env);
  assert.equal(read.role, "support");
  const write = await authorizeAdmin(req(token({})), env, { requireOwner: true });
  assert.equal(write.error.status, 403);
});

test("suspended or deleted admin is rejected", async () => {
  mockFetch({ user: goodUser, dbRow: { is_admin: true, status: "suspended" } });
  assert.equal((await authorizeAdmin(req(token({})), env)).error.status, 403);
  mockFetch({ user: goodUser, dbRow: { is_admin: true, status: "active", deleted_at: "2026-01-01" } });
  assert.equal((await authorizeAdmin(req(token({})), env)).error.status, 403);
});

test("legacy ADMIN_EMAIL fallback works only when configured and matches", async () => {
  mockFetch({ user: goodUser, dbRow: null });
  assert.equal((await authorizeAdmin(req(token({})), env)).error.status, 403);
  const withLegacy = { ...env, ADMIN_EMAIL: " A@B.co " };
  const r = await authorizeAdmin(req(token({})), withLegacy);
  assert.equal(r.role, "owner");
});

test("MFA required: aal1 is refused with a code, aal2 passes", async () => {
  mockFetch({ user: goodUser, dbRow: { is_admin: true, status: "active" }, mfaRequired: true });
  const low = await authorizeAdmin(req(token({ aal: "aal1" })), env);
  assert.equal(low.error.status, 401);
  assert.equal((await low.error.json()).code, "MFA_REQUIRED");
  const high = await authorizeAdmin(req(token({ aal: "aal2" })), env);
  assert.equal(high.role, "owner");
});

test("MFA not required: aal1 passes", async () => {
  mockFetch({ user: goodUser, dbRow: { is_admin: true, status: "active" }, mfaRequired: false });
  const r = await authorizeAdmin(req(token({ aal: "aal1" })), env);
  assert.equal(r.role, "owner");
});

test("changes() reports only differences", () => {
  assert.deepEqual(changes({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 }), { b: { from: 2, to: 3 }, c: { from: null, to: 4 } });
});

test("jwtClaims tolerates garbage", () => {
  assert.deepEqual(jwtClaims("not-a-jwt"), {});
  assert.equal(jwtClaims(token({ aal: "aal2" })).aal, "aal2");
});

test("audit() posts to audit_log and never throws", async () => {
  let body;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).endsWith("/rest/v1/audit_log"));
    body = JSON.parse(init.body);
    return { ok: true, status: 201, text: async () => "" };
  };
  assert.equal(await audit(env, "u1", "x", "user", "id1", { k: 1 }), true);
  assert.equal(body.action, "x");
  assert.equal(body.entity_id, "id1");
  globalThis.fetch = async () => {
    throw new Error("network");
  };
  assert.equal(await audit(env, "u1", "x", "user", null), false);
});
