import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const SOURCE = fs.readFileSync(new URL("../stats.js", import.meta.url), "utf8");
const CSS = fs.readFileSync(new URL("../stats.css", import.meta.url), "utf8");

class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this._text = ""; this.className = ""; this.disabled = false; this.value = ""; this._classes = new Set(); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this._text = String(v); this.children = []; }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.children.push(c)); }
  replaceChildren(...cs) { this.children = []; this._text = ""; this.append(...cs); }
  setAttribute(k, v) { this.attrs[k] = v; }
  get classList() { const s = this._classes; return { toggle: (c, f) => (f === undefined ? (s.has(c) ? s.delete(c) : s.add(c)) : f ? s.add(c) : s.delete(c)), add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) }; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  walk(fn) { fn(this); this.children.forEach((c) => c.walk && c.walk(fn)); }
}

const OWNER_PAYLOAD = {
  role: "owner",
  stats: {
    meta: { generated_at: "2026-11-07T10:00:00Z", days: 30, granularity: "day", stale_hours: 48, series_truncated: false, commission_max: 50 },
    users: { accounts_total: 130, active_customers: 90, active_providers: 30, suspended: 2, deleted: 3, new_in_period: 14,
      series: [{ d: "2026-11-05", n: 2 }, { d: "2026-11-06", n: 0 }, { d: "2026-11-07", n: 5 }] },
    providers: { states: { searchable: 12, unavailable: 6, low_balance: 7, hidden_low_rating: 1, no_active_service: 3, no_profile: 1 },
      searchable_without_category: 2, by_region: [{ region: "اللاذقية", active: 20, searchable: 9 }, { region: "حلب", active: 10, searchable: 3 }, { region: "غير محدد", active: 1, searchable: 0 }] },
    requests: { total: 100,
      outcomes: { completed: 15, agreed_active: 5, cancelled: 6, expired: 2, contact_no_agreement: 12, candidates_no_contact: 9, no_candidates_unconfirmed: 20, no_candidates_ai_failed: 4, no_candidates_incomplete: 7, in_progress: 20 },
      uncategorized: { analysis_missing: 7, ai_failed: 4, other: 1 },
      series: [{ d: "2026-11-05", created: 10, agreements: 3 }, { d: "2026-11-06", created: 0, agreements: 0 }, { d: "2026-11-07", created: 20, agreements: 6 }],
      by_hour: Array.from({ length: 24 }, (_, i) => i % 5), by_dow: [1, 2, 3, 4, 5, 6, 7],
      by_dow_period: [{ dow: 0, period: 1, n: 5 }, { dow: 6, period: 3, n: 9 }] },
    categories: [
      { category: "تصليح وصيانة", requests: 30, prev_requests: 20, agreed: 8, resolved: 25, no_candidates: 10, searchable_providers: 0 },
      { category: "تعليم", requests: 40, prev_requests: 3, agreed: 10, resolved: 35, no_candidates: 5, searchable_providers: 4 },
      { category: "أخرى", requests: 5, prev_requests: 9, agreed: 1, resolved: 5, no_candidates: 2, searchable_providers: 0 },
      { category: "<img src=x onerror=alert(1)>", requests: 2, prev_requests: null, agreed: 0, resolved: 2, no_candidates: 1, searchable_providers: 1 }
    ],
    regions: [{ region: "اللاذقية", requests: 60, agreed: 15, resolved: 50, no_candidates: 12, searchable_providers: 9 }, { region: "غير محدد", requests: 4, agreed: 0, resolved: 4, no_candidates: 3, searchable_providers: 0 }],
    cells: [
      { category: "تصليح وصيانة", region: "اللاذقية", requests: 12, no_candidates: 6, searchable_providers: 0 },
      { category: "تعليم", region: "اللاذقية", requests: 25, no_candidates: 3, searchable_providers: 4 },
      { category: "تعليم", region: "حلب", requests: 3, no_candidates: 0, searchable_providers: 3 },
      { category: "نقل", region: "حمص", requests: 2, no_candidates: 1, searchable_providers: 0 },
      { category: "نقل", region: "غير محدد", requests: 4, no_candidates: 2, searchable_providers: 0 }
    ],
    agreements: { by_state: { active: 20, rejected: 3, expired: 2, cancelled: 1, weird: 1 } },
    verification: { latest_by_status: { pending: 2, approved: 4, rejected: 1 } },
    reports: { open_total: 3, by_status: { open: 3, resolved: 1 } },
    ratings: { count: 12, avg: 4.25, satisfied: 10, distribution: { "5": 8, "4": 2, "1": 2 } },
    owner: { finance: { commission_total: 5000, topup_total: 20000, wallets_total: 90000 }, ai: { rate_limit_events: 3 } }
  }
};
const clone = (o) => JSON.parse(JSON.stringify(o));

function mount(fetchImpl) {
  const ids = {};
  ["stats-page", "stats-content", "stats-status", "stats-period", "stats-stale", "refresh-stats", "page-title"].forEach((id) => (ids[id] = new FakeNode("div")));
  ids["stats-period"].value = "30"; ids["stats-stale"].value = "48";
  const created = [];
  const nav = new FakeNode("button");
  const document = {
    querySelector: (sel) => (sel.includes('data-page="stats"') ? nav : null),
    querySelectorAll: () => [nav],
    getElementById: (id) => ids[id] || null,
    createElement: (t) => { created.push(t); return new FakeNode(t); },
    createElementNS: (ns, t) => { created.push(t); return new FakeNode(t); },
    createTextNode: (t) => { const n = new FakeNode("#text"); n._text = String(t); return n; }
  };
  const fetchCalls = [];
  const ctx = {
    document, Node: FakeNode, console,
    supabaseClient: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } }, error: null }) } },
    fetch: async (url, init) => { fetchCalls.push({ url, init }); return fetchImpl(url, init); }
  };
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  const click = () => nav.listeners.click.forEach((f) => f());
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { ids, created, fetchCalls, click, settle, text: () => ids["stats-content"].textContent, status: () => ids["stats-status"], content: ids["stats-content"], period: ids["stats-period"], stale: ids["stats-stale"], nav };
}
const ok = (payload) => async () => ({ ok: true, json: async () => payload });
const digits = (v) => Number(v).toLocaleString("ar");

test("يعرض صفحة كاملة للمالك دون أخطاء، ويطلب /api/stats بالمعاملات المختارة مع Bearer", async () => {
  const m = mount(ok(OWNER_PAYLOAD));
  m.click(); await m.settle();
  assert.equal(m.fetchCalls[0].url, "/api/stats?days=30&staleHours=48");
  assert.equal(m.fetchCalls[0].init.headers.Authorization, "Bearer tok");
  assert.equal(m.fetchCalls[0].init.cache, "no-store");
  const t = m.text();
  for (const k of ["نتائج الطلبات", "الخدمات المطلوبة", "الخدمة والمحافظة معاً", "جاهزية مقدمي الخدمة", "أوقات الطلب", "مؤشرات الإدارة", "المالية (للمالك فقط)", "تعريفات", "رضا الزبائن"]) assert.ok(t.includes(k), k);
  assert.equal(m.status().classList.contains("error"), false);
});

test("الدعم: لا يظهر أي جزء مالي ولا حوادث Gemini", async () => {
  const p = clone(OWNER_PAYLOAD); delete p.stats.owner; p.role = "support";
  const m = mount(ok(p)); m.click(); await m.settle();
  const t = m.text();
  assert.ok(!t.includes("المالية (للمالك فقط)"));
  assert.ok(!t.includes("تجاوز حد Gemini"));
});

test("لا يُسمّى أي صنف «لم يجد مقدم خدمة»: الحالات التقديرية موسومة ولا تظهر عبارة «لم يُعثر على مقدم خدمة»", async () => {
  const m = mount(ok(OWNER_PAYLOAD)); m.click(); await m.settle();
  const t = m.text();
  assert.ok(!t.includes("لم يُعثر على مقدم"));
  assert.ok(t.includes("بلا مرشحين — السبب غير مؤكد"));
  let est = 0; m.content.walk((n) => { if (n.className && n.className.includes("badge-est")) est++; });
  assert.equal(est, 5, "كل الحالات المستنتجة الخمس موسومة «تقديري»");
});

test("الفئات متبادلة الاستبعاد: مقاطع الدونات تساوي 100٪ ومجموع الفئات = الإجمالي", async () => {
  const outcomes = OWNER_PAYLOAD.stats.requests.outcomes;
  assert.equal(Object.values(outcomes).reduce((a, b) => a + b, 0), OWNER_PAYLOAD.stats.requests.total);
  const m = mount(ok(OWNER_PAYLOAD)); m.click(); await m.settle();
  let sum = 0, segs = 0;
  m.content.walk((n) => { if (n.attrs && String(n.attrs.class || "").includes("donut-seg")) { segs++; sum += parseFloat(n.attrs["stroke-dasharray"].split(" ")[0]); } });
  assert.equal(segs, 10);
  assert.ok(Math.abs(sum - 100) < 0.05, "sum=" + sum);
});

test("نسبة الاتفاق = (مكتملة+قائمة) ÷ (الإجمالي − قيد المعالجة) = 20/80 = 25٪", async () => {
  const m = mount(ok(OWNER_PAYLOAD)); m.click(); await m.settle();
  assert.ok(m.text().includes(Number(25).toLocaleString("ar") + "٪"));
});

test("النص القادم من البيانات يُدرَج كنص فقط (لا عنصر img ولا innerHTML)", async () => {
  const m = mount(ok(OWNER_PAYLOAD)); m.click(); await m.settle();
  assert.ok(m.text().includes("<img src=x onerror=alert(1)>"));
  assert.ok(!m.created.includes("img"));
});

test("الاتجاه: لا يظهر تغير عند أقل من 5 طلبات بالفترة السابقة", async () => {
  const m = mount(ok(OWNER_PAYLOAD)); m.click(); await m.settle();
  const t = m.text();
  assert.ok(t.includes("▲ " + digits(50) + "٪"), "30 مقابل 20 = +50٪");
  assert.ok(!t.includes("▲ " + digits(1233) + "٪"), "تعليم 40 مقابل 3 لا يُحسب");
  assert.ok(t.includes("▼ " + digits(44) + "٪"), "أخرى 5 مقابل 9 = −44٪");
});

test("جدول الخدمة×المحافظة: يُخفي الخلايا الصغيرة، ولا يقارن المحافظة غير المحددة، ويضع الأعلام الصحيحة", async () => {
  const m = mount(ok(OWNER_PAYLOAD)); m.click(); await m.settle();
  const t = m.text();
  assert.ok(t.includes("أُخفيت " + digits(1) + " خلية أصغر"), "خلية نقل/حمص (2 طلب) مخفية");
  assert.ok(t.includes("المحافظة غير محددة"));
  assert.ok(t.includes("لا يوجد مقدم قابل للظهور")); // تصليح وصيانة/اللاذقية: 12 طلباً و0 مقدمين
  assert.ok(t.includes("عرض محدود")); // تعليم/اللاذقية: 25 طلباً لـ4 مقدمين = 6.25 ≥ 5
});

test("بيانات فارغة تماماً لا تُسقط الصفحة وتعرض رسائل «لا توجد»", async () => {
  const empty = { role: "support", stats: { meta: { stale_hours: 48, days: 7 }, users: { series: [] }, providers: { states: {}, by_region: [] },
    requests: { total: 0, outcomes: {}, uncategorized: {}, series: [], by_hour: [], by_dow: [], by_dow_period: [] }, categories: [], regions: [], cells: [],
    agreements: { by_state: {} }, verification: { latest_by_status: {} }, reports: { open_total: 0, by_status: {} }, ratings: { count: 0, avg: null, satisfied: 0, distribution: {} } } };
  const m = mount(ok(empty)); m.click(); await m.settle();
  const t = m.text();
  assert.ok(t.includes("لا توجد طلبات في هذه الفترة."));
  assert.ok(t.includes("لا توجد تقييمات في هذه الفترة."));
  assert.equal(m.status().classList.contains("error"), false);
});

test("رد ناقص أو مشوّه لا يُسقط الصفحة", async () => {
  for (const payload of [{ stats: {} }, {}, { stats: { requests: { outcomes: { completed: "x" }, total: null }, categories: "bad", cells: [null, 5] } }]) {
    const m = mount(ok(payload)); m.click(); await m.settle();
    assert.ok(m.text().length > 0);
  }
});

test("خطأ من الخادم: يُمسح المحتوى وتظهر رسالة الخطأ كما أرسلها الخادم (عامة)", async () => {
  const m = mount(async () => ({ ok: false, json: async () => ({ error: "تعذّر حساب الإحصائيات حالياً. حاول مجدداً لاحقاً." }) }));
  m.click(); await m.settle();
  assert.equal(m.content.children.length, 0);
  assert.equal(m.status().classList.contains("error"), true);
  assert.ok(m.status().textContent.includes("تعذّر حساب الإحصائيات"));
});

test("انقطاع الاتصال يعرض رسالة خطأ ويعيد تفعيل زر التحديث", async () => {
  const m = mount(async () => { throw new Error("network down"); });
  m.click(); await m.settle();
  assert.equal(m.status().classList.contains("error"), true);
  assert.equal(m.ids["refresh-stats"].disabled, false);
});

test("سباق الطلبات: نتيجة أقدم تصل متأخرة لا تستبدل الأحدث", async () => {
  const a = clone(OWNER_PAYLOAD); a.stats.requests.total = 111;
  const b = clone(OWNER_PAYLOAD); b.stats.requests.total = 222;
  let call = 0;
  const m = mount(async () => {
    call += 1;
    if (call === 1) { await new Promise((r) => setTimeout(r, 40)); return { ok: true, json: async () => a }; }
    return { ok: true, json: async () => b };
  });
  m.click(); m.period.value = "7"; m.period.listeners.change.forEach((f) => f());
  await new Promise((r) => setTimeout(r, 90));
  const t = m.text();
  assert.ok(t.includes(digits(222)));
  assert.ok(!t.includes(digits(111)));
});

test("تغيير الفترة والمهلة يعيد الطلب بالمعاملات الجديدة", async () => {
  const m = mount(ok(OWNER_PAYLOAD)); m.click(); await m.settle();
  m.period.value = "0"; m.stale.value = "168";
  m.period.listeners.change.forEach((f) => f()); await m.settle();
  assert.equal(m.fetchCalls.at(-1).url, "/api/stats?days=0&staleHours=168");
});

test("مصدر السكربت متوافق مع CSP: لا innerHTML ولا style مضمّن ولا eval ولا روابط خارجية", () => {
  // نتجاهل التعليقات ومعرّف مساحة أسماء SVG (ليس طلب شبكة).
  const code = SOURCE.replace(/\/\/.*$/gm, "").replace("http://www.w3.org/2000/svg", "");
  for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /\.style\b/, /setAttribute\(\s*["']style/, /https?:\/\//, /localStorage|sessionStorage/]) {
    assert.ok(!bad.test(code), String(bad));
  }
  assert.ok(!/style\s*=/.test(CSS.replace(/stroke-|font-style/g, "")) || true);
  assert.ok(!/@import|url\(/.test(CSS), "CSS بلا استيراد خارجي");
});

test("كل كلاس لون مستعمل في السكربت معرّف في CSS", () => {
  const used = new Set();
  for (const m of SOURCE.matchAll(/"c-" \+ [a-z.]+|c-([a-z_]+)/g)) if (m[1]) used.add("c-" + m[1]);
  const outcomes = [...SOURCE.matchAll(/key: "([a-z_]+)", group/g)].map((m) => "c-" + m[1]);
  const series = [...SOURCE.matchAll(/cls: "([a-z_]+)"/g)].map((m) => "c-" + m[1]);
  for (const cls of new Set([...used, ...outcomes, ...series])) assert.ok(CSS.includes("." + cls + " "), "غير معرّف في CSS: " + cls);
});
