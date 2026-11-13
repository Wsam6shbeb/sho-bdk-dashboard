// تشغيل: node --test tests/jobs.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../functions/api/jobs.js";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const REPORT_ID = "33333333-3333-4333-8333-333333333333";
const AD_ID = "44444444-4444-4444-8444-444444444444";
const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key"
};

function token() {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return enc({ alg: "HS256" }) + "." + enc({ sub: ADMIN_ID, aal: "aal2" }) + ".sig";
}
const USER_TOKEN = token();

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body))
  };
}

// role: "owner" | "support"; rpcResult/rpcStatus: what the database function returns
function installFetch({ role = "support", rpcResult = {}, rpcStatus = 200 } = {}) {
  const rpcCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/auth/v1/user")) {
      return response({ id: ADMIN_ID, email: "admin@example.com", email_confirmed_at: "2026-01-01" });
    }
    if (value.includes("/rest/v1/users?select=is_admin,admin_role")) {
      return response([{ is_admin: true, admin_role: role, status: "active" }]);
    }
    if (value.includes("/rest/v1/app_settings?select=value")) return response([{ value: true }]);
    if (value.includes("/rest/v1/rpc/")) {
      rpcCalls.push({
        name: value.split("/rpc/")[1],
        headers: init.headers,
        body: init.body ? JSON.parse(init.body) : null
      });
      return response(rpcResult, rpcStatus);
    }
    throw new Error("Unexpected fetch: " + value);
  };
  return rpcCalls;
}

function get(query) {
  return onRequest({
    request: new Request("https://dash.example/api/jobs" + query, {
      headers: { Authorization: "Bearer " + USER_TOKEN }
    }),
    env
  });
}

function post(body) {
  return onRequest({
    request: new Request("https://dash.example/api/jobs", {
      method: "POST",
      headers: { Authorization: "Bearer " + USER_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }),
    env
  });
}

test("requires a signed-in admin", async () => {
  installFetch();
  const res = await onRequest({ request: new Request("https://dash.example/api/jobs"), env });
  assert.equal(res.status, 401);
});

test("rejects other HTTP methods", async () => {
  installFetch();
  const res = await onRequest({ request: new Request("https://dash.example/api/jobs", { method: "DELETE" }), env });
  assert.equal(res.status, 405);
});

test("support can list jobs; the admin's own token (not the service key) goes to the database", async () => {
  const calls = installFetch({ role: "support", rpcResult: { total: 0, items: [] } });
  const res = await get("?view=jobs&status=hidden&q=%D9%85%D8%AD%D8%A7%D8%B3%D8%A8&limit=10&offset=20");
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.role, "support");
  assert.deepEqual(payload.data, { total: 0, items: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "admin_list_jobs");
  assert.deepEqual(calls[0].body, { p_status: "hidden", p_q: "محاسب", p_limit: 10, p_offset: 20 });
  assert.equal(calls[0].headers.Authorization, "Bearer " + USER_TOKEN);
  assert.equal(calls[0].headers.apikey, "anon-key");
});

test("support can read ads, words, settings, stats and reports", async () => {
  const calls = installFetch({ role: "support", rpcResult: [] });
  for (const view of ["ads", "words", "settings", "stats", "reports"]) {
    const res = await get("?view=" + view);
    assert.equal(res.status, 200, view);
  }
  assert.deepEqual(
    calls.map((call) => call.name),
    ["admin_list_job_ads", "admin_list_job_blocked_words", "admin_get_jobs_settings", "admin_jobs_stats", "admin_list_job_reports"]
  );
});

test("reports default to open and accept 'all'", async () => {
  const calls = installFetch({ rpcResult: { total: 0, items: [] } });
  await get("?view=reports");
  await get("?view=reports&status=all");
  assert.equal(calls[0].body.p_status, "open");
  assert.equal(calls[1].body.p_status, null);
});

test("invalid filters and views are rejected without touching the database", async () => {
  const calls = installFetch();
  assert.equal((await get("?view=jobs&status=bogus")).status, 400);
  assert.equal((await get("?view=reports&status=bogus")).status, 400);
  assert.equal((await get("?view=nope")).status, 400);
  assert.equal(calls.length, 0);
});

test("limit is clamped to 100", async () => {
  const calls = installFetch({ rpcResult: { total: 0, items: [] } });
  await get("?view=jobs&limit=5000");
  assert.equal(calls[0].body.p_limit, 100);
});

test("support can hide, restore and delete jobs and resolve reports", async () => {
  const calls = installFetch({ role: "support", rpcResult: { ok: true } });
  assert.equal((await post({ action: "set_job_status", jobId: JOB_ID, status: "hidden", reason: "مخالف" })).status, 200);
  assert.equal((await post({ action: "set_job_status", jobId: JOB_ID, status: "active" })).status, 200);
  assert.equal((await post({ action: "delete_job", jobId: JOB_ID, reason: "سبام" })).status, 200);
  assert.equal((await post({ action: "resolve_report", reportId: REPORT_ID, resolution: "hide_job", note: "احتيال" })).status, 200);
  assert.deepEqual(
    calls.map((call) => call.name),
    ["admin_set_job_status", "admin_set_job_status", "admin_delete_job", "admin_resolve_job_report"]
  );
  assert.deepEqual(calls[0].body, { p_job_id: JOB_ID, p_status: "hidden", p_reason: "مخالف" });
  assert.deepEqual(calls[3].body, { p_report_id: REPORT_ID, p_action: "hide_job", p_note: "احتيال" });
});

test("support cannot manage ads, blocked words or settings", async () => {
  const calls = installFetch({ role: "support" });
  const attempts = [
    { action: "save_ad", title: "x", imageUrl: "https://a.co/i.png" },
    { action: "delete_ad", id: AD_ID },
    { action: "add_word", word: "كلمة" },
    { action: "delete_word", id: AD_ID },
    { action: "save_settings", enabled: true }
  ];
  for (const attempt of attempts) {
    const res = await post(attempt);
    assert.equal(res.status, 403, attempt.action);
  }
  assert.equal(calls.length, 0);
});

test("validates job actions before calling the database", async () => {
  const calls = installFetch({ role: "owner" });
  assert.equal((await post({ action: "set_job_status", jobId: "not-a-uuid", status: "hidden" })).status, 400);
  assert.equal((await post({ action: "set_job_status", jobId: JOB_ID, status: "deleted" })).status, 400);
  assert.equal((await post({ action: "delete_job", jobId: "x" })).status, 400);
  assert.equal((await post({ action: "resolve_report", reportId: REPORT_ID, resolution: "ban_user" })).status, 400);
  assert.equal((await post({ action: "unknown" })).status, 400);
  assert.equal(calls.length, 0);
});

test("owner saves an ad with validated fields", async () => {
  const calls = installFetch({ role: "owner", rpcResult: { id: AD_ID } });
  const res = await post({
    action: "save_ad",
    title: "  عرض خاص ",
    imageUrl: "https://example.com/a.png",
    linkUrl: "https://example.com",
    isActive: true,
    startsAt: "2026-12-01T00:00:00Z",
    endsAt: "2026-12-31T00:00:00Z",
    priority: 5
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls[0].body, {
    p_title: "عرض خاص",
    p_image_url: "https://example.com/a.png",
    p_link_url: "https://example.com",
    p_is_active: true,
    p_starts_at: "2026-12-01T00:00:00.000Z",
    p_ends_at: "2026-12-31T00:00:00.000Z",
    p_priority: 5,
    p_id: null
  });
});

test("owner ad validation: https image, http(s) link, dates and priority", async () => {
  const calls = installFetch({ role: "owner" });
  const base = { action: "save_ad", title: "x", imageUrl: "https://a.co/i.png" };
  assert.equal((await post({ ...base, imageUrl: "http://a.co/i.png" })).status, 400);
  assert.equal((await post({ ...base, title: "   " })).status, 400);
  assert.equal((await post({ ...base, linkUrl: "javascript:alert(1)" })).status, 400);
  assert.equal((await post({ ...base, startsAt: "2026-12-31T00:00:00Z", endsAt: "2026-12-01T00:00:00Z" })).status, 400);
  assert.equal((await post({ ...base, startsAt: "garbage" })).status, 400);
  assert.equal((await post({ ...base, priority: 5000 })).status, 400);
  assert.equal((await post({ ...base, id: "not-a-uuid" })).status, 400);
  assert.equal(calls.length, 0);
});

test("owner settings: only provided values are sent and ranges are enforced", async () => {
  const calls = installFetch({ role: "owner", rpcResult: { jobs_enabled: true } });
  const ok = await post({ action: "save_settings", enabled: true, adEveryN: 4, reportThreshold: 0 });
  assert.equal(ok.status, 200);
  assert.deepEqual(calls[0].body, { p_enabled: true, p_ad_every_n: 4, p_report_threshold: 0 });

  assert.equal((await post({ action: "save_settings", adEveryN: 1 })).status, 400);
  assert.equal((await post({ action: "save_settings", maxActive: 0 })).status, 400);
  assert.equal((await post({ action: "save_settings", expiryDays: 400 })).status, 400);
  assert.equal((await post({ action: "save_settings", enabled: "yes" })).status, 400);
  assert.equal((await post({ action: "save_settings" })).status, 400);
  assert.equal(calls.length, 1);
});

test("owner manages blocked words", async () => {
  const calls = installFetch({ role: "owner", rpcResult: { id: AD_ID } });
  assert.equal((await post({ action: "add_word", word: "ا" })).status, 400);
  assert.equal((await post({ action: "add_word", word: "كلمة", wholeWord: true })).status, 200);
  assert.deepEqual(calls[0].body, { p_word: "كلمة", p_whole_word: true });
  assert.equal((await post({ action: "delete_word", id: AD_ID })).status, 200);
});

test("maps database error codes to clear Arabic messages", async () => {
  installFetch({ role: "owner", rpcResult: { message: "WORD_EXISTS" }, rpcStatus: 400 });
  const exists = await post({ action: "add_word", word: "كلمة" });
  assert.equal(exists.status, 409);

  installFetch({ role: "support", rpcResult: { message: "JOB_NOT_FOUND" }, rpcStatus: 400 });
  const missing = await post({ action: "delete_job", jobId: JOB_ID });
  assert.equal(missing.status, 404);

  installFetch({ role: "support", rpcResult: { message: "MFA_REQUIRED" }, rpcStatus: 400 });
  const mfa = await post({ action: "delete_job", jobId: JOB_ID });
  assert.equal(mfa.status, 401);
  assert.equal((await mfa.json()).code, "MFA_REQUIRED");

  installFetch({ role: "support", rpcResult: { message: "boom" }, rpcStatus: 500 });
  const generic = await post({ action: "delete_job", jobId: JOB_ID });
  assert.equal(generic.status, 502);
});

test("rejects malformed JSON bodies", async () => {
  installFetch({ role: "owner" });
  const res = await onRequest({
    request: new Request("https://dash.example/api/jobs", {
      method: "POST",
      headers: { Authorization: "Bearer " + USER_TOKEN },
      body: "not json"
    }),
    env
  });
  assert.equal(res.status, 400);
});
