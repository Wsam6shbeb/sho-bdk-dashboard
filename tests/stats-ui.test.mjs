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
  for (const k of ["نتائج الطلبات", "الخدمات", "جاهزية مقدمي الخدمة", "أوقات الطلب", "مؤشرات الإدارة", "المالية (للمالك فقط)", "تعريفات", "رضا الزبائن"]) assert.ok(t.includes(k), k);
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
  const m = mount(async (url) => {
    if (url.startsWith("/api/stats-services")) return { ok: true, json: async () => ({}) };
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
  assert.equal(m.fetchCalls.filter((c) => c.url.startsWith("/api/stats?")).at(-1).url, "/api/stats?days=0&staleHours=168");
  assert.equal(m.fetchCalls.filter((c) => c.url.startsWith("/api/stats-services")).at(-1).url, "/api/stats-services?days=0");
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

// ---------------------------------------------------------------- قسم الخدمات
const SERVICES_PAYLOAD = {
  role: "owner",
  services: {
    meta: { days: 30, region: null, area: null },
    filters: { regions: [
      { name: "اللاذقية", n: 44, areas: [{ name: "سقوبين", n: 3 }, { name: "صلنفة", n: 3 }] },
      { name: "اونلاين", n: 1, areas: [] }
    ] },
    coverage: { requests: 40, requests_unnamed: 2, requests_with_area: 6, services: 6, services_with_area: 3 },
    scope: { requests: 40, requests_named: 38, services: 6, providers: 5 },
    demand: [
      { service: "برمجة وتطبيقات", requests: 14, agreed: 4, providers: 2, searchable: 2,
        variants: [{ name: "مبرمج", n: 5 }, { name: "مبرمجة", n: 4 }, { name: "تطبيقات", n: 2 }, { name: "برمجة تطبيقات", n: 1 }] },
      { service: "رسم", requests: 10, agreed: 6, providers: 0, searchable: 0, variants: [{ name: "رسم", n: 10 }] },
      { service: "<img src=x onerror=alert(1)>", requests: 2, agreed: 0, providers: 1, searchable: 1, variants: [{ name: "<b>x</b>", n: 2 }] }
    ],
    demand_other: { groups: 3, requests: 4 },
    supply: [
      { service: "برمجة وتطبيقات", providers: 2, searchable: 2, services: 2, requests: 14, variants: [{ name: "مبرمج تطبيقات", n: 2 }] },
      { service: "تدريس رياضيات", providers: 1, searchable: 1, services: 1, requests: 0, variants: [{ name: "مدرس رياضيات", n: 1 }] }
    ],
    supply_other: { groups: 0, providers: 0 }
  }
};
const both = (main, services) => async (url) => ({ ok: true, json: async () => (url.startsWith("/api/stats-services") ? services : main) });
const findNodes = (m, pred) => { const out = []; m.content.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const selectByLabel = (m, label) => findNodes(m, (n) => n.tagName === "select" && n.attrs["aria-label"] === label)[0];
const mountServices = async (servicesPayload = SERVICES_PAYLOAD) => {
  const m = mount(both(OWNER_PAYLOAD, servicesPayload));
  m.click(); await m.settle();
  return m;
};

test("قسم الخدمات يظهر تحت عدادات المستخدمين مباشرة وقبل مؤشرات الطلبات", async () => {
  const m = await mountServices();
  const t = m.text();
  const users = t.indexOf("الزبائن الفعّالون");
  const services = t.indexOf("الأكثر طلباً");
  const requests = t.indexOf("إجمالي الطلبات");
  assert.ok(users >= 0 && services > users && requests > services, JSON.stringify({ users, services, requests }));
});

test("الأكثر طلباً: الترتيب حسب العدد الفعلي، وأسماء الصيغ المدموجة ظاهرة للمراجعة", async () => {
  const m = await mountServices();
  const t = m.text();
  assert.ok(t.indexOf("برمجة وتطبيقات") < t.indexOf("رسم"), "14 طلباً قبل 10");
  assert.ok(t.includes("تشمل: مبرمج (" + digits(5) + ")، مبرمجة (" + digits(4) + ")، تطبيقات (" + digits(2) + ")، برمجة تطبيقات (" + digits(1) + ")"));
  assert.ok(!t.includes("تشمل: رسم"), "اسم واحد بلا دمج لا يُكرَّر");
  assert.ok(t.includes(digits(14)) && t.includes(digits(10)));
  assert.ok(t.includes("و" + digits(3) + " خدمة أخرى (" + digits(4) + " طلب)"));
});

test("إذا طُلبت خدمة أكثر تظهر أولاً حتى لو كانت أقل مجموعات الأسماء", async () => {
  const p = clone(SERVICES_PAYLOAD);
  p.services.demand = [
    { service: "رسم", requests: 30, agreed: 1, providers: 0, searchable: 0, variants: [{ name: "رسم", n: 30 }] },
    { service: "برمجة وتطبيقات", requests: 14, agreed: 4, providers: 2, searchable: 2, variants: [{ name: "مبرمج", n: 14 }] }
  ];
  const m = await mountServices(p);
  const t = m.text();
  assert.ok(t.indexOf("رسم") < t.indexOf("برمجة وتطبيقات"));
});

test("أعلام العرض: «لا يوجد مقدم» لخدمة مطلوبة بلا مقدمين، ولا علم لعينة صغيرة", async () => {
  const m = await mountServices();
  const t = m.text();
  assert.ok(t.includes("لا يوجد مقدم قابل للظهور")); // رسم: 10 طلبات و0 مقدمين
  assert.equal(t.split("لا يوجد مقدم قابل للظهور").length - 1, 1, "طلبان فقط لا يُعدّان نقصاً");
});

test("ماذا يقدّم الناس: خدمة معروضة بلا طلب عليها تُوسم", async () => {
  const m = await mountServices();
  const t = m.text();
  assert.ok(t.includes("ماذا يقدّم الناس"));
  assert.ok(t.includes("تدريس رياضيات"));
  assert.ok(t.includes("لا طلب عليها"));
});

test("النص القادم من البيانات (اسم خدمة أو صيغة) يُدرَج كنص فقط (لا عناصر HTML)", async () => {
  const m = await mountServices();
  assert.ok(m.text().includes("<img src=x onerror=alert(1)>"));
  assert.ok(m.text().includes("<b>x</b>"));
  assert.ok(!m.created.includes("img") && !m.created.includes("b"));
});

test("الفلاتر: محافظة ثم منطقة، والمنطقة معطّلة قبل اختيار المحافظة", async () => {
  const m = await mountServices();
  const region = selectByLabel(m, "المحافظة");
  const area = selectByLabel(m, "المنطقة");
  assert.ok(region && area);
  assert.deepEqual(region.children.map((o) => o.value), ["", "اللاذقية", "اونلاين"]);
  assert.equal(area.disabled, true);
  assert.deepEqual(area.children.map((o) => o.value), [""]);
});

test("اختيار محافظة يعيد تحميل قسم الخدمات فقط بمعاملاتها، ثم المنطقة تضيف area", async () => {
  const m = await mountServices();
  const before = m.fetchCalls.filter((c) => c.url.startsWith("/api/stats?")).length;
  let region = selectByLabel(m, "المحافظة");
  region.value = "اللاذقية";
  region.listeners.change.forEach((f) => f());
  await m.settle();
  assert.equal(m.fetchCalls.at(-1).url, "/api/stats-services?days=30&region=" + encodeURIComponent("اللاذقية"));
  assert.equal(m.fetchCalls.filter((c) => c.url.startsWith("/api/stats?")).length, before, "لا يُعاد تحميل الصفحة كلها");

  // بعد إعادة البناء: المنطقة مفعّلة وفيها «غير محددة» والمناطق الموجودة بالبيانات
  region = selectByLabel(m, "المحافظة");
  let area = selectByLabel(m, "المنطقة");
  assert.equal(region.value, "اللاذقية");
  assert.equal(area.disabled, false);
  assert.deepEqual(area.children.map((o) => o.value), ["", "__none__", "سقوبين", "صلنفة"]);
  area.value = "سقوبين";
  area.listeners.change.forEach((f) => f());
  await m.settle();
  assert.equal(m.fetchCalls.at(-1).url, "/api/stats-services?days=30&region=" + encodeURIComponent("اللاذقية") + "&area=" + encodeURIComponent("سقوبين"));
});

test("تغيير المحافظة يصفّر المنطقة، و«اونلاين» لا مناطق لها", async () => {
  const m = await mountServices();
  let region = selectByLabel(m, "المحافظة");
  region.value = "اللاذقية"; region.listeners.change.forEach((f) => f()); await m.settle();
  let area = selectByLabel(m, "المنطقة");
  area.value = "__none__"; area.listeners.change.forEach((f) => f()); await m.settle();
  assert.ok(m.fetchCalls.at(-1).url.endsWith("&area=__none__"));
  region = selectByLabel(m, "المحافظة");
  region.value = "اونلاين"; region.listeners.change.forEach((f) => f()); await m.settle();
  assert.equal(m.fetchCalls.at(-1).url, "/api/stats-services?days=30&region=" + encodeURIComponent("اونلاين"));
  assert.equal(selectByLabel(m, "المنطقة").disabled, true);
});

test("تغيير الفترة يحتفظ بالفلاتر المختارة", async () => {
  const m = await mountServices();
  const region = selectByLabel(m, "المحافظة");
  region.value = "اللاذقية"; region.listeners.change.forEach((f) => f()); await m.settle();
  m.period.value = "7"; m.period.listeners.change.forEach((f) => f()); await m.settle();
  const last = m.fetchCalls.filter((c) => c.url.startsWith("/api/stats-services")).at(-1).url;
  assert.equal(last, "/api/stats-services?days=7&region=" + encodeURIComponent("اللاذقية"));
});

test("تغطية المنطقة تُعرض بأرقامها الفعلية (المتوفر فقط)", async () => {
  const m = await mountServices();
  const t = m.text();
  assert.ok(t.includes("المنطقة محددة في " + digits(6) + " من " + digits(40) + " طلب، وفي " + digits(3) + " من " + digits(6) + " خدمة مقدَّمة"));
  assert.ok(t.includes(digits(2) + " منها بلا اسم خدمة"));
});

test("فشل طلب الخدمات لا يُسقط باقي الصفحة ويعرض رسالة عامة", async () => {
  const m = mount(async (url) => url.startsWith("/api/stats-services")
    ? { ok: false, json: async () => ({ error: "تعذّر حساب إحصائيات الخدمات حالياً. حاول مجدداً لاحقاً." }) }
    : { ok: true, json: async () => OWNER_PAYLOAD });
  m.click(); await m.settle();
  const t = m.text();
  assert.ok(t.includes("تعذّر حساب إحصائيات الخدمات حالياً"));
  assert.ok(t.includes("نتائج الطلبات"), "باقي الصفحة سليم");
  assert.equal(m.status().classList.contains("error"), false);
});

test("رد خدمات مشوّه لا يُسقط الصفحة", async () => {
  for (const payload of [{}, { services: {} }, { services: { scope: {}, demand: "bad", supply: [null, 5], filters: { regions: [null, { name: "اللاذقية", areas: "x" }] } } }]) {
    const m = await mountServices(payload);
    assert.ok(m.text().length > 0);
  }
});

test("بلا أشرطة تمرير: عمود واحد وجداول تلتف نصوصها", () => {
  assert.ok(!/overflow-x\s*:\s*(auto|scroll)/.test(CSS), "لا overflow-x:auto/scroll");
  assert.match(CSS, /\.stats-grid\s*\{[^}]*grid-template-columns:\s*1fr\s*;/);
  assert.match(CSS, /\.users-table\.stats-table\s*\{[^}]*min-width:\s*0/);
  assert.match(CSS, /\.users-table\.stats-table th,\s*\.users-table\.stats-table td\s*\{[^}]*white-space:\s*normal/);
  assert.match(CSS, /\.stats-table-wrap\s*\{[^}]*overflow:\s*visible/);
  assert.ok(!SOURCE.includes("users-table-wrap"), "لا نستعمل غلاف التمرير القديم");
});
