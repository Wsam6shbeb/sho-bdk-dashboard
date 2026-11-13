// تشغيل: node --test tests/jobs-ui.test.mjs
// فحوص ساكنة تضمن أن صفحة فرص العمل متصلة صحيحاً بالـ HTML وبالتنقل وبسجل التدقيق وبالـ CSP.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../jobs.js", import.meta.url), "utf8");
const appJs = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const headers = readFileSync(new URL("../_headers", import.meta.url), "utf8");

test("every element id used by jobs.js exists in index.html", () => {
  const ids = new Set([...script.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]));
  assert.ok(ids.size > 30, "expected jobs.js to reference many elements");
  for (const id of ids) {
    assert.ok(html.includes('id="' + id + '"'), "missing #" + id + " in index.html");
  }
});

test("tabs in the markup match the panels jobs.js controls", () => {
  const tabs = [...html.matchAll(/data-jobs-tab="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ["jobs", "reports", "ads", "words", "settings"]);
  for (const tab of tabs) assert.ok(html.includes('id="jobs-tab-' + tab + '"'), tab);
});

test("jobs page is wired into navigation, assets and audit labels", () => {
  assert.match(html, /data-page="jobs"/);
  assert.match(html, /id="jobs-page"/);
  assert.match(html, /href="\.\/jobs\.css/);
  assert.match(html, /src="\.\/jobs\.js/);
  assert.match(appJs, /jobs: \{ title: "فرص العمل", id: "jobs-page" \}/);
  for (const action of [
    "admin_set_job_status", "admin_delete_job", "admin_resolve_job_report", "admin_create_job_ad",
    "admin_update_job_ad", "admin_delete_job_ad", "admin_add_job_blocked_word",
    "admin_delete_job_blocked_word", "admin_set_jobs_settings"
  ]) {
    assert.ok(appJs.includes(action + ":"), "missing audit label for " + action);
  }
});

test("jobs.js stays compatible with the strict CSP (no innerHTML, no inline styles or handlers)", () => {
  const code = script.replace(/^\s*\/\/.*$/gm, ""); // comments may mention these words
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  assert.doesNotMatch(code, /setAttribute\(\s*["']style["']|\.style\.cssText|\.onclick\s*=/);
  const section = html.slice(html.indexOf('id="jobs-page"'), html.indexOf('id="settings-page"'));
  assert.doesNotMatch(section, /\sstyle=|\sonclick=|<script/);
  assert.match(headers, /script-src 'self'/);
});

test("write controls are disabled for non-owners in jobs.js", () => {
  assert.match(script, /OWNER_TABS = \["ads", "words", "settings"\]/);
  assert.match(script, /adminState\.role === "owner"/);
});
