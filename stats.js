// صفحة "الإحصائيات" في لوحة التحكم.
// تعتمد على supabaseClient و adminState المعرّفين في app.js (يُحمَّل هذا الملف بعده).
// الرسوم SVG تُبنى بـ DOM فقط (بلا مكتبات ولا style مضمّن) فتتوافق مع CSP الصارمة،
// وكل النصوص تُدرَج بـ textContent (لا innerHTML إطلاقاً).
(function () {
  "use strict";

  const navButton = document.querySelector('[data-page="stats"]');
  const page = document.getElementById("stats-page");
  const content = document.getElementById("stats-content");
  if (!navButton || !page || !content) return;

  const statusLine = document.getElementById("stats-status");
  const periodSelect = document.getElementById("stats-period");
  const staleSelect = document.getElementById("stats-stale");
  const refreshButton = document.getElementById("refresh-stats");

  const SVG_NS = "http://www.w3.org/2000/svg";
  // حدود عرض فقط (لا تغيّر الأرقام): تقلل الاستنتاج من عينات صغيرة.
  const MIN_CELL_REQUESTS = 3; // أقل عدد طلبات لعرض خلية (خدمة × محافظة)
  const MIN_PREV_FOR_TREND = 5; // أقل عدد طلبات بالفترة السابقة لعرض نسبة التغير
  const PRESSURE_RATIO = 5; // طلبات لكل مقدم قابل للظهور تُعدّ "عرضاً محدوداً"

  // النتائج: confirmed = حالة مسجّلة في قاعدة البيانات؛ inferred = استنتاج من وجود/غياب سجلات؛ progress = حديث.
  const OUTCOMES = [
    { key: "completed", group: "confirmed", label: "مكتملة", help: "حالة الطلب في قاعدة البيانات: مكتمل." },
    { key: "agreed_active", group: "confirmed", label: "اتفاق قائم", help: "حالة الطلب: نشط أو بانتظار التقييم (اتفاق فعّال)." },
    { key: "cancelled", group: "confirmed", label: "ملغاة", help: "حالة الطلب: ملغى. لا يوجد في البيانات من ألغاه أو لماذا." },
    { key: "expired", group: "confirmed", label: "منتهية", help: "حالة الطلب: منتهي." },
    { key: "contact_no_agreement", group: "inferred", label: "بدأ التواصل ولم يحصل اتفاق", help: "توجد محادثة بلا اتفاق، والطلب أقدم من المهلة المختارة." },
    { key: "candidates_no_contact", group: "inferred", label: "ظهر مرشحون ولم يبدأ تواصل", help: "حُفظ مرشحون للطلب ولم تُفتح محادثة، والطلب أقدم من المهلة." },
    { key: "no_candidates_unconfirmed", group: "inferred", label: "بلا مرشحين — السبب غير مؤكد", help: "لا مرشحين ولا محادثة. قد يكون لا يوجد مقدم مناسب، أو لم ينجح التقييم، أو تركه الزبون قبل اكتمال البحث. قاعدة البيانات لا تسجّل السبب." },
    { key: "no_candidates_ai_failed", group: "inferred", label: "فشل التحليل الذكي وبلا مرشحين", help: "سُجّل فشل التحليل الذكي لهذا الطلب ولا مرشحين." },
    { key: "no_candidates_incomplete", group: "inferred", label: "لم تكتمل معالجة الطلب", help: "أُنشئ الطلب ولم يُحفظ تحليله (تُرك أو انقطع الاتصال)، ولا مرشحين." },
    { key: "in_progress", group: "progress", label: "قيد المعالجة", help: "أحدث من المهلة المختارة ولم يُحسم بعد." }
  ];
  const GROUP_TITLES = {
    confirmed: "حالات مسجّلة في قاعدة البيانات",
    inferred: "حالات مستنتجة (تقديرية)",
    progress: "غير محسومة بعد"
  };
  const NO_CANDIDATE_KEYS = ["no_candidates_unconfirmed", "no_candidates_ai_failed", "no_candidates_incomplete"];
  const DAYS_AR = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
  const PERIODS_AR = ["بعد منتصف الليل (0–6)", "صباحاً (6–12)", "ظهراً وعصراً (12–18)", "مساءً (18–24)"];
  const SEARCH_STATES = [
    { key: "searchable", label: "قابلون للظهور في نتائج البحث", cls: "ready" },
    { key: "unavailable", label: "أوقفوا خيار التوفر", cls: "notready" },
    { key: "low_balance", label: "رصيدهم أقل من الحد الأعلى للعمولة", cls: "notready" },
    { key: "hidden_low_rating", label: "مخفيون بسبب تقييم منخفض", cls: "notready" },
    { key: "no_active_service", label: "بلا خدمة فعّالة", cls: "notready" },
    { key: "no_profile", label: "بلا ملف مقدّم خدمة", cls: "notready" }
  ];
  const VERIFICATION_AR = { pending: "قيد المراجعة", approved: "موثّق", rejected: "مرفوض" };
  const REPORT_STATUS_AR = { open: "مفتوح", reviewed: "قيد المراجعة", resolved: "محلول", dismissed: "مرفوض" };
  const AGREEMENT_AR = { pending: "بانتظار موافقة مقدم الخدمة", active: "فعّال", rejected: "رفضه مقدم الخدمة", expired: "انتهت مهلته", cancelled: "ألغاه الزبون" };

  let loadToken = 0;

  // ------------------------------------------------------------ أدوات DOM
  function h(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }
  function s(tag, attrs, text) {
    const element = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs || {}).forEach(([key, value]) => element.setAttribute(key, String(value)));
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }
  const n = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const obj = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
  const arr = (value) => (Array.isArray(value) ? value : []);
  // صفوف الجداول والسلاسل: نتجاهل أي عنصر ليس كائناً حتى لا يُسقط رد مشوّه الصفحة.
  const rows = (value) => arr(value).filter((item) => item && typeof item === "object" && !Array.isArray(item));
  const fmt = (value) => n(value).toLocaleString("ar");
  const pct = (part, total) => (n(total) > 0 ? Math.round((n(part) / n(total)) * 1000) / 10 : null);
  const fmtPct = (value) => (value === null ? "—" : value.toLocaleString("ar") + "٪");
  const money = (value) => fmt(Math.round(n(value))) + " ل.س";

  function panel(title, help) {
    const element = h("section", "panel stats-panel");
    element.appendChild(h("h3", null, title));
    if (help) element.appendChild(h("p", "stats-help", help));
    return element;
  }
  function empty(text) {
    return h("p", "stats-empty", text);
  }
  function kpi(label, value, hint) {
    const element = h("div", "stats-kpi");
    element.append(h("span", null, label), h("strong", null, value));
    if (hint) element.appendChild(h("small", null, hint));
    return element;
  }
  function setStatus(message, isError) {
    statusLine.textContent = message;
    statusLine.classList.toggle("error", Boolean(isError));
  }

  // ------------------------------------------------------------ أدوات الرسم
  function niceMax(value) {
    const v = Math.max(1, value);
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const r = v / p;
    const base = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * p;
    return Math.max(4, Math.ceil(base / 4) * 4); // قابل للقسمة على 4 فتكون محاور y أعداداً صحيحة
  }
  function shortNumber(value) {
    return value >= 1000 ? (Math.round(value / 100) / 10).toLocaleString("ar") + "k" : fmt(value);
  }
  function shortLabel(label) {
    const parts = String(label).split("-");
    if (parts.length === 3) return parts[1] + "/" + parts[2];
    if (parts.length === 2) return parts[0] + "/" + parts[1];
    return String(label);
  }

  function donut(items, total) {
    const svg = s("svg", { viewBox: "0 0 42 42", class: "stats-donut", role: "img", "aria-label": "توزيع نتائج الطلبات" });
    svg.appendChild(s("circle", { cx: 21, cy: 21, r: 15.9155, class: "donut-track" }));
    let offset = 25;
    items.forEach((item) => {
      if (!item.value) return;
      const share = (item.value / total) * 100;
      const segment = s("circle", {
        cx: 21, cy: 21, r: 15.9155,
        class: "donut-seg c-" + item.key,
        "stroke-dasharray": share.toFixed(3) + " " + (100 - share).toFixed(3),
        "stroke-dashoffset": offset.toFixed(3)
      });
      segment.appendChild(s("title", {}, item.label + ": " + fmt(item.value)));
      svg.appendChild(segment);
      offset -= share;
    });
    svg.appendChild(s("text", { x: 21, y: 21.5, class: "donut-total" }, fmt(total)));
    svg.appendChild(s("text", { x: 21, y: 26, class: "donut-caption" }, "طلب"));
    return svg;
  }

  function chartFrame(width, height, left, bottom, top, right, max) {
    const svg = s("svg", { viewBox: "0 0 " + width + " " + height, class: "stats-chart", role: "img" });
    const y = (value) => top + (height - top - bottom) * (1 - value / max);
    for (let i = 0; i <= 4; i += 1) {
      const value = (max * i) / 4;
      svg.appendChild(s("line", { x1: left, x2: width - right, y1: y(value), y2: y(value), class: "chart-grid" }));
      svg.appendChild(s("text", { x: left - 6, y: y(value) + 3.5, class: "chart-axis chart-axis-y" }, shortNumber(value)));
    }
    return { svg, y };
  }

  function lineChart(points, series) {
    const W = 640, H = 230, L = 40, R = 14, T = 12, B = 28;
    const max = niceMax(Math.max(0, ...points.flatMap((p) => series.map((item) => n(p[item.key])))));
    const { svg, y } = chartFrame(W, H, L, B, T, R, max);
    const x = (i) => L + (points.length <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1));
    const step = Math.max(1, Math.ceil(points.length / 7));
    points.forEach((point, i) => {
      if (i % step === 0 || i === points.length - 1) {
        svg.appendChild(s("text", { x: x(i), y: H - 8, class: "chart-axis chart-axis-x" }, shortLabel(point.d)));
      }
    });
    series.forEach((item) => {
      const coords = points.map((point, i) => x(i).toFixed(1) + "," + y(n(point[item.key])).toFixed(1)).join(" ");
      svg.appendChild(s("polyline", { points: coords, class: "chart-line c-" + item.cls }));
      if (points.length <= 40) {
        points.forEach((point, i) => {
          const dot = s("circle", { cx: x(i).toFixed(1), cy: y(n(point[item.key])).toFixed(1), r: 3, class: "chart-dot c-" + item.cls });
          dot.appendChild(s("title", {}, item.label + " — " + point.d + ": " + fmt(point[item.key])));
          svg.appendChild(dot);
        });
      }
    });
    return svg;
  }

  function barChart(items, cls, labelEvery) {
    const W = 640, H = 200, L = 40, R = 10, T = 12, B = 30;
    const max = niceMax(Math.max(0, ...items.map((item) => n(item.value))));
    const { svg, y } = chartFrame(W, H, L, B, T, R, max);
    const slot = (W - L - R) / Math.max(1, items.length);
    const barWidth = Math.max(2, slot * 0.68);
    items.forEach((item, i) => {
      const barHeight = Math.max(0, (H - T - B) * (n(item.value) / max));
      const rect = s("rect", {
        x: (L + i * slot + (slot - barWidth) / 2).toFixed(1),
        y: (y(0) - barHeight).toFixed(1),
        width: barWidth.toFixed(1),
        height: barHeight.toFixed(1),
        rx: 2,
        class: "chart-bar c-" + cls
      });
      rect.appendChild(s("title", {}, item.label + ": " + fmt(item.value)));
      svg.appendChild(rect);
      if (i % labelEvery === 0) {
        svg.appendChild(s("text", { x: (L + i * slot + slot / 2).toFixed(1), y: H - 10, class: "chart-axis chart-axis-x" }, item.short));
      }
    });
    return svg;
  }

  // شريط أفقي مكدّس؛ يبدأ من اليمين ليناسب الواجهة العربية.
  function stackBar(parts) {
    const total = parts.reduce((sum, part) => sum + n(part.value), 0);
    const svg = s("svg", { viewBox: "0 0 100 8", preserveAspectRatio: "none", class: "stats-stack", role: "img" });
    if (total <= 0) return svg;
    let used = 0;
    parts.forEach((part) => {
      if (!n(part.value)) return;
      const width = (n(part.value) / total) * 100;
      const rect = s("rect", { x: (100 - used - width).toFixed(2), y: 0, width: width.toFixed(2), height: 8, class: "c-" + part.cls });
      rect.appendChild(s("title", {}, part.label + ": " + fmt(part.value)));
      svg.appendChild(rect);
      used += width;
    });
    return svg;
  }

  function simpleBar(value, max, cls, label) {
    const svg = s("svg", { viewBox: "0 0 100 8", preserveAspectRatio: "none", class: "stats-bar", role: "img" });
    const width = max > 0 ? (n(value) / max) * 100 : 0;
    if (width > 0) {
      const rect = s("rect", { x: (100 - width).toFixed(2), y: 0, width: width.toFixed(2), height: 8, class: "c-" + cls });
      rect.appendChild(s("title", {}, label + ": " + fmt(value)));
      svg.appendChild(rect);
    }
    return svg;
  }

  function legendInline(items) {
    const wrap = h("div", "stats-legend-inline");
    items.forEach((item) => {
      const entry = h("span");
      entry.append(h("i", "dot c-" + item.cls), document.createTextNode(item.label));
      wrap.appendChild(entry);
    });
    return wrap;
  }

  function table(headers, rows, extraClass) {
    const wrap = h("div", "users-table-wrap stats-scroll");
    const element = h("table", "users-table stats-table" + (extraClass ? " " + extraClass : ""));
    const head = document.createElement("tr");
    headers.forEach((text) => head.appendChild(h("th", null, text)));
    const thead = document.createElement("thead");
    thead.appendChild(head);
    const tbody = document.createElement("tbody");
    rows.forEach((cells) => {
      const row = document.createElement("tr");
      cells.forEach((cell) => {
        const td = document.createElement("td");
        if (cell instanceof Node) td.appendChild(cell);
        else if (cell && typeof cell === "object" && "text" in cell) {
          td.textContent = String(cell.text);
          if (cell.className) td.className = cell.className;
        } else td.textContent = String(cell);
        row.appendChild(td);
      });
      tbody.appendChild(row);
    });
    element.append(thead, tbody);
    wrap.appendChild(element);
    return wrap;
  }
  function badge(text, kind) {
    return h("span", "stats-badge badge-" + kind, text);
  }

  // ------------------------------------------------------------ تحليل الأرقام (دوال نقية)
  function outcomeSummary(requests) {
    const outcomes = obj(requests.outcomes);
    const total = n(requests.total);
    const count = (key) => n(outcomes[key]);
    const agreed = count("completed") + count("agreed_active");
    const resolved = total - count("in_progress");
    const noCandidates = NO_CANDIDATE_KEYS.reduce((sum, key) => sum + count(key), 0);
    return { total, agreed, resolved, noCandidates, inProgress: count("in_progress"), successRate: pct(agreed, resolved), count };
  }
  function trendNode(current, previous) {
    if (previous === null || previous === undefined || n(previous) < MIN_PREV_FOR_TREND) return h("span", "trend-flat", "—");
    const change = Math.round(((n(current) - n(previous)) / n(previous)) * 100);
    if (change === 0) return h("span", "trend-flat", "ثابت");
    return change > 0
      ? h("span", "trend-up", "▲ " + fmt(change) + "٪")
      : h("span", "trend-down", "▼ " + fmt(Math.abs(change)) + "٪");
  }
  function supplyFlag(requests, providers) {
    if (n(requests) < MIN_CELL_REQUESTS) return h("span", "trend-flat", "عينة صغيرة");
    if (n(providers) === 0) return badge("لا يوجد مقدم قابل للظهور", "bad");
    if (n(requests) / n(providers) >= PRESSURE_RATIO) return badge("عرض محدود", "warn");
    return h("span", "trend-flat", "—");
  }

  // ------------------------------------------------------------ الأقسام
  function renderNotice(data) {
    const meta = obj(data.meta);
    const box = h("div", "stats-note");
    box.appendChild(h("strong", null, "قبل قراءة الأرقام"));
    const list = h("ul");
    [
      "الأرقام تخص الفترة المختارة، وتوقيت دمشق هو المعتمد في التجميع.",
      "«بلا مرشحين» لا تعني أن الخدمة غير موجودة: قاعدة البيانات لا تسجّل سبب غياب المرشحين، لذلك تظهر هذه الحالات كتقديرية.",
      "الطلب الأحدث من " + fmt(n(meta.stale_hours)) + " ساعة يُعدّ قيد المعالجة ولا يدخل في نسبة الاتفاق."
    ].forEach((text) => list.appendChild(h("li", null, text)));
    box.appendChild(list);
    return box;
  }

  function renderUsers(data) {
    const users = obj(data.users);
    const states = obj(obj(data.providers).states);
    const wrap = h("div");
    wrap.appendChild(h("h2", "stats-section-title", "المستخدمون"));
    const grid = h("div", "stats-kpis");
    grid.append(
      kpi("الزبائن الفعّالون", fmt(users.active_customers), "حسابات فعّالة ليست لمقدمي خدمة"),
      kpi("مقدمو الخدمة الفعّالون", fmt(users.active_providers), "حسابات فعّالة بصفة مقدّم خدمة"),
      kpi("قابلون للظهور في البحث", fmt(states.searchable), "فعّالون ومتاحون وبرصيد كافٍ وغير مخفيين بسبب التقييم"),
      kpi("حسابات جديدة بالفترة", fmt(users.new_in_period), "إجمالي الحسابات: " + fmt(users.accounts_total) + " (موقوف " + fmt(users.suspended) + "، محذوف " + fmt(users.deleted) + ")")
    );
    wrap.appendChild(grid);
    return wrap;
  }

  function renderRequestKpis(data) {
    const summary = outcomeSummary(obj(data.requests));
    const wrap = h("div");
    wrap.appendChild(h("h2", "stats-section-title", "الطلبات"));
    const grid = h("div", "stats-kpis");
    grid.append(
      kpi("إجمالي الطلبات", fmt(summary.total)),
      kpi("طلبات اتفقوا فيها", fmt(summary.agreed), "مكتملة + اتفاق قائم"),
      kpi("نسبة الاتفاق", fmtPct(summary.successRate), "= المتفق عليها ÷ (كل الطلبات − قيد المعالجة). لا تقيس جودة المطابقة وحدها."),
      kpi("طلبات بلا مرشحين (تقديري)", fmt(summary.noCandidates), "السبب غير مؤكد: انظر تفصيلها أدناه"),
      kpi("قيد المعالجة", fmt(summary.inProgress), "أحدث من المهلة المختارة")
    );
    wrap.appendChild(grid);
    return wrap;
  }

  function renderOutcomes(data) {
    const requests = obj(data.requests);
    const summary = outcomeSummary(requests);
    const box = panel("نتائج الطلبات", "كل طلب يظهر في فئة واحدة فقط، ومجموع الفئات يساوي إجمالي الطلبات.");
    if (summary.total === 0) {
      box.appendChild(empty("لا توجد طلبات في هذه الفترة."));
      return box;
    }
    const items = OUTCOMES.map((outcome) => ({ ...outcome, value: summary.count(outcome.key) }));
    const wrap = h("div", "stats-donut-wrap");
    const list = h("ul", "stats-legend");
    ["confirmed", "inferred", "progress"].forEach((group) => {
      list.appendChild(h("li", "stats-legend-group", GROUP_TITLES[group]));
      items.filter((item) => item.group === group).forEach((item) => {
        const row = h("li", "legend-row");
        const label = h("span", null, item.label);
        if (group === "inferred") label.appendChild(h("span", "stats-badge badge-est", "تقديري"));
        row.append(h("i", "dot c-" + item.key), label, h("span", "legend-value", fmt(item.value) + " · " + fmtPct(pct(item.value, summary.total))));
        row.appendChild(h("span", "legend-help", item.help));
        list.appendChild(row);
      });
    });
    wrap.append(donut(items, summary.total), list);
    box.appendChild(wrap);
    return box;
  }

  function renderQuality(data) {
    const uncategorized = obj(obj(data.requests).uncategorized);
    const owner = obj(data.owner);
    const box = panel("جودة تحليل الطلبات", "تحليل الطلب بالذكاء الاصطناعي يحدد تصنيف الخدمة. الطلب بلا تصنيف لا يدخل في جداول الخدمات.");
    const rows = [
      ["فشل التحليل وسُجّل ذلك على الطلب", fmt(uncategorized.ai_failed)],
      ["أُنشئ الطلب ولم يُحفظ تحليله", fmt(uncategorized.analysis_missing)],
      ["تحليل بلا تصنيف معتمد", fmt(uncategorized.other)]
    ];
    if (owner.ai && owner.ai.rate_limit_events !== undefined) {
      rows.push(["مرات تجاوز حد Gemini بعد استنفاد المحاولات (حوادث، غير مرتبطة بطلب محدد)", fmt(owner.ai.rate_limit_events)]);
    }
    box.appendChild(table(["المؤشر", "العدد"], rows));
    return box;
  }

  function renderSeries(data) {
    const requests = obj(data.requests);
    const meta = obj(data.meta);
    const box = panel("الطلبات والاتفاقات عبر الزمن", "الطلبات حسب تاريخ إنشائها، والاتفاقات حسب تاريخ موافقة مقدم الخدمة، فلا تُقارن العمودين كنسبة نجاح لكل يوم.");
    const points = rows(requests.series);
    if (!points.some((point) => n(point.created) > 0 || n(point.agreements) > 0)) {
      box.appendChild(empty("لا توجد بيانات في هذه الفترة."));
      return box;
    }
    const series = [
      { key: "created", cls: "created", label: "طلبات جديدة" },
      { key: "agreements", cls: "agreements", label: "اتفاقات فعّالة" }
    ];
    box.append(lineChart(points, series), legendInline(series));
    if (meta.series_truncated) box.appendChild(h("p", "stats-help", "عُرضت آخر 36 شهراً فقط في الرسم؛ الأرقام الأخرى تشمل كل التاريخ."));
    return box;
  }

  function renderSignups(data) {
    const box = panel("نمو التسجيلات", "الحسابات الجديدة (بدون حسابات المدراء).");
    const points = rows(obj(data.users).series);
    if (!points.some((point) => n(point.n) > 0)) {
      box.appendChild(empty("لا توجد تسجيلات جديدة في هذه الفترة."));
      return box;
    }
    const items = points.map((point) => ({ label: point.d, short: shortLabel(point.d), value: point.n }));
    box.appendChild(barChart(items, "users", Math.max(1, Math.ceil(items.length / 7))));
    return box;
  }

  function renderCategories(data) {
    const box = panel(
      "الخدمات المطلوبة",
      "التصنيف عام (13 تصنيفاً يحدده الذكاء الاصطناعي) والمطابقة الفعلية تعتمد على كلمات الخدمة لا على التصنيف، فالمؤشرات هنا تقريبية وليست إثباتاً لنقص."
    );
    const categories = rows(data.categories);
    if (categories.length === 0) {
      box.appendChild(empty("لا توجد طلبات مصنّفة في هذه الفترة."));
      return box;
    }
    const maxRequests = Math.max(...categories.map((row) => n(row.requests)));
    const body = categories.map((row) => [
      row.category || "—",
      fmt(row.requests),
      trendNode(row.requests, row.prev_requests),
      simpleBar(row.requests, maxRequests, "demand", "الطلبات"),
      fmtPct(pct(row.agreed, row.resolved)) + " (" + fmt(row.agreed) + " من " + fmt(row.resolved) + ")",
      fmt(row.no_candidates),
      fmt(row.searchable_providers),
      row.category === "أخرى" ? h("span", "trend-flat", "تصنيف عام") : supplyFlag(row.requests, row.searchable_providers)
    ]);
    box.appendChild(table(
      ["التصنيف", "الطلبات", "التغير عن الفترة السابقة", "", "نسبة الاتفاق (من المحسومة)", "بلا مرشحين (تقديري)", "مقدمون قابلون للظهور", "ملاحظة"],
      body
    ));
    box.appendChild(h("p", "stats-help", "التغير يظهر عند وجود " + fmt(MIN_PREV_FOR_TREND) + " طلبات فأكثر بالفترة السابقة. «عرض محدود» = " + fmt(PRESSURE_RATIO) + " طلبات أو أكثر لكل مقدم قابل للظهور. «بلا مرشحين» تقدير لا يثبت غياب مقدمي الخدمة."));
    return box;
  }

  function renderCells(data) {
    const box = panel(
      "الخدمة والمحافظة معاً",
      "يقارن طلبات كل تصنيف في كل محافظة بمقدمي الخدمة القابلين للظهور في التصنيف نفسه والمحافظة نفسها (محافظة الخدمة نفسها، وإن لم تُحدَّد فمحافظة حساب مقدم الخدمة)."
    );
    const all = rows(data.cells);
    const shown = all.filter((cell) => n(cell.requests) >= MIN_CELL_REQUESTS);
    if (shown.length === 0) {
      box.appendChild(empty(all.length === 0 ? "لا توجد طلبات مصنّفة في هذه الفترة." : "لا توجد خلية فيها " + fmt(MIN_CELL_REQUESTS) + " طلبات أو أكثر بعد."));
      return box;
    }
    const body = shown.map((cell) => {
      const unknownRegion = cell.region === "غير محدد";
      const providers = n(cell.searchable_providers);
      return [
        cell.category,
        cell.region,
        fmt(cell.requests),
        fmt(cell.no_candidates),
        unknownRegion ? "—" : fmt(providers),
        unknownRegion ? "—" : providers > 0 ? (n(cell.requests) / providers).toLocaleString("ar", { maximumFractionDigits: 1 }) : "—",
        unknownRegion ? h("span", "trend-flat", "المحافظة غير محددة") : supplyFlag(cell.requests, providers)
      ];
    });
    box.appendChild(table(["التصنيف", "المحافظة", "الطلبات", "بلا مرشحين (تقديري)", "مقدمون قابلون للظهور", "طلبات لكل مقدم", "ملاحظة"], body));
    const hidden = all.length - shown.length;
    box.appendChild(h("p", "stats-help",
      "تُعرض الخلايا التي فيها " + fmt(MIN_CELL_REQUESTS) + " طلبات فأكثر" + (hidden > 0 ? " (أُخفيت " + fmt(hidden) + " خلية أصغر)" : "") +
      ". مقدم الخدمة الذي لم يُحدَّد تصنيف خدماته أو محافظته لا يدخل في هذه المقارنة."));
    return box;
  }

  function renderRegions(data) {
    const box = panel("المحافظات", "الطلبات حسب المحافظة التي اختارها الزبون، ومقدمو الخدمة حسب محافظات خدماتهم الفعّالة (وإن لم تُحدَّد فمحافظة الحساب). من يخدم أكثر من محافظة يُحسب في كل منها.");
    const demand = rows(data.regions);
    const supply = rows(obj(data.providers).by_region);
    const names = new Set([...demand.map((row) => row.region), ...supply.map((row) => row.region)]);
    if (names.size === 0) {
      box.appendChild(empty("لا توجد بيانات في هذه الفترة."));
      return box;
    }
    const demandBy = new Map(demand.map((row) => [row.region, row]));
    const supplyBy = new Map(supply.map((row) => [row.region, row]));
    const ordered = [...names].sort((a, b) => n(obj(demandBy.get(b)).requests) - n(obj(demandBy.get(a)).requests) || String(a).localeCompare(String(b), "ar"));
    const maxRequests = Math.max(1, ...demand.map((row) => n(row.requests)));
    const body = ordered.map((name) => {
      const d = obj(demandBy.get(name));
      const p = obj(supplyBy.get(name));
      return [
        name,
        fmt(d.requests),
        simpleBar(d.requests, maxRequests, "demand", "الطلبات"),
        fmtPct(pct(d.agreed, d.resolved)),
        fmt(d.no_candidates),
        fmt(p.active) + " / " + fmt(p.searchable)
      ];
    });
    box.appendChild(table(["المحافظة", "الطلبات", "", "نسبة الاتفاق (من المحسومة)", "بلا مرشحين (تقديري)", "مقدمو خدمة: فعّالون / قابلون للظهور"], body));
    return box;
  }

  function renderProviderReadiness(data) {
    const providers = obj(data.providers);
    const states = obj(providers.states);
    const meta = obj(data.meta);
    const total = SEARCH_STATES.reduce((sum, item) => sum + n(states[item.key]), 0);
    const box = panel("جاهزية مقدمي الخدمة", "كل مقدم خدمة فعّال يُحسب في أول سبب ينطبق عليه بالترتيب الظاهر أدناه (شروط الظهور مأخوذة من دالة المطابقة).");
    if (total === 0) {
      box.appendChild(empty("لا يوجد مقدمو خدمة فعّالون."));
      return box;
    }
    box.appendChild(stackBar(SEARCH_STATES.map((item) => ({ value: states[item.key], cls: item.cls, label: item.label }))));
    const rows = SEARCH_STATES.map((item) => {
      let label = item.label;
      if (item.key === "low_balance" && meta.commission_max !== null && meta.commission_max !== undefined) {
        label += " (" + fmt(meta.commission_max) + " ل.س)";
      }
      return [label, fmt(states[item.key]), fmtPct(pct(states[item.key], total))];
    });
    box.appendChild(table(["الحالة", "العدد", "النسبة"], rows));
    if (n(providers.searchable_without_category) > 0) {
      box.appendChild(h("p", "stats-help", fmt(providers.searchable_without_category) + " من القابلين للظهور لا تحمل خدماتهم تصنيفاً معتمداً، فلا يدخلون في مقارنات الخدمة."));
    }
    if (meta.commission_max === null || meta.commission_max === undefined) {
      box.appendChild(h("p", "stats-warn", "تعذّرت قراءة الحد الأعلى للعمولة، لذلك لم يُطبَّق شرط الرصيد في هذا الجدول."));
    }
    return box;
  }

  function renderTiming(data) {
    const requests = obj(data.requests);
    const box = panel("أوقات الطلب", "حسب توقيت دمشق وقت إنشاء الطلب.");
    const hours = arr(requests.by_hour);
    const days = arr(requests.by_dow);
    if (!hours.some((value) => n(value) > 0)) {
      box.appendChild(empty("لا توجد طلبات في هذه الفترة."));
      return box;
    }
    box.appendChild(h("p", "stats-help", "حسب ساعة اليوم"));
    box.appendChild(barChart(hours.map((value, hour) => ({ label: hour + ":00", short: String(hour), value })), "hour", 3));
    box.appendChild(h("p", "stats-help", "حسب يوم الأسبوع"));
    box.appendChild(barChart(days.map((value, day) => ({ label: DAYS_AR[day], short: DAYS_AR[day], value })), "hour", 1));
    return box;
  }

  function renderHeatmap(data) {
    const box = panel("الأيام والفترات", "عدد الطلبات في كل يوم وفترة من اليوم (توقيت دمشق). الأغمق = أكثر.");
    const cells = rows(obj(data.requests).by_dow_period);
    if (cells.length === 0) {
      box.appendChild(empty("لا توجد طلبات في هذه الفترة."));
      return box;
    }
    const grid = DAYS_AR.map(() => PERIODS_AR.map(() => 0));
    cells.forEach((cell) => {
      const d = n(cell.dow);
      const p = n(cell.period);
      if (grid[d] && grid[d][p] !== undefined) grid[d][p] = n(cell.n);
    });
    const max = Math.max(1, ...grid.flat());
    const body = DAYS_AR.map((day, d) => [
      day,
      ...grid[d].map((value) => {
        const level = value === 0 ? 0 : Math.min(4, Math.ceil((value / max) * 4));
        return { text: fmt(value), className: "heat heat-" + level };
      })
    ]);
    box.appendChild(table(["اليوم", ...PERIODS_AR], body, "heat-table"));
    return box;
  }

  function mapRows(object, labels) {
    return Object.entries(obj(object)).map(([key, value]) => [labels[key] || "حالة غير معروفة", fmt(value)]);
  }

  function renderManagement(data) {
    const wrap = h("div");
    wrap.appendChild(h("h2", "stats-section-title", "مؤشرات الإدارة"));
    const grid = h("div", "stats-grid");

    const verification = panel("طلبات التوثيق", "آخر طلب لكل مستخدم (الوضع الحالي، لا يتأثر بالفترة).");
    const verificationRows = mapRows(obj(data.verification).latest_by_status, VERIFICATION_AR);
    verification.appendChild(verificationRows.length ? table(["الحالة", "المستخدمون"], verificationRows) : empty("لا توجد طلبات توثيق."));

    const reports = panel("البلاغات", fmt(obj(data.reports).open_total) + " بلاغ مفتوح حالياً.");
    const reportRows = mapRows(obj(data.reports).by_status, REPORT_STATUS_AR);
    reports.appendChild(reportRows.length ? table(["حالة البلاغات المنشأة بالفترة", "العدد"], reportRows) : empty("لا توجد بلاغات منشأة في هذه الفترة."));

    const agreements = panel("الاتفاقات", "حسب حالة الاتفاق للاتفاقات المنشأة بالفترة. انتهاء المهلة يعني أن مقدم الخدمة لم يردّ في الوقت.");
    const agreementRows = mapRows(obj(data.agreements).by_state, AGREEMENT_AR);
    agreements.appendChild(agreementRows.length ? table(["الحالة", "العدد"], agreementRows) : empty("لا توجد اتفاقات في هذه الفترة."));

    const ratings = obj(data.ratings);
    const ratingCount = n(ratings.count);
    const satisfaction = panel(
      "رضا الزبائن",
      "تقييمات الزبائن لمقدمي الخدمة بالفترة (دون تقييمات مقدمي الخدمة للزبائن ودون التقييمات التلقائية). الراضون = 4 نجوم فأكثر."
    );
    if (ratingCount === 0) {
      satisfaction.appendChild(empty("لا توجد تقييمات في هذه الفترة."));
    } else {
      const cards = h("div", "stats-kpis");
      cards.append(
        kpi("المتوسط", n(ratings.avg).toLocaleString("ar", { maximumFractionDigits: 2 }) + " من 5", fmt(ratingCount) + " تقييم"),
        kpi("نسبة الراضين", fmtPct(pct(ratings.satisfied, ratingCount)), fmt(ratings.satisfied) + " من " + fmt(ratingCount))
      );
      const distribution = obj(ratings.distribution);
      const items = [1, 2, 3, 4, 5].map((score) => ({ label: score + " نجوم", short: String(score), value: n(distribution[String(score)]) }));
      satisfaction.append(cards, barChart(items, "rating", 1));
      if (ratingCount < 10) satisfaction.appendChild(h("p", "stats-help", "عدد التقييمات قليل؛ لا تبنِ قراراً على المتوسط وحده."));
    }

    grid.append(verification, reports, agreements, satisfaction);
    wrap.appendChild(grid);
    return wrap;
  }

  function renderOwner(data) {
    const owner = obj(data.owner);
    const finance = owner.finance;
    if (!finance) return null;
    const wrap = h("div");
    wrap.appendChild(h("h2", "stats-section-title", "المالية (للمالك فقط)"));
    const box = panel("حركة الرصيد", "مجاميع من سجل القيود. العمولة تُخصم عند موافقة مقدم الخدمة على الاتفاق. الشحن قد يشمل أي قيد من نوع شحن. لا يُحسب هنا صافي إيراد.");
    const grid = h("div", "stats-kpis");
    grid.append(
      kpi("عمولات مخصومة بالفترة", money(finance.commission_total)),
      kpi("شحن بالفترة", money(finance.topup_total)),
      kpi("إجمالي أرصدة المحافظ الحالية", money(finance.wallets_total), "الوضع الحالي، لا يتأثر بالفترة")
    );
    box.appendChild(grid);
    wrap.appendChild(box);
    return wrap;
  }

  function renderDefinitions() {
    const note = h("div", "stats-note");
    note.appendChild(h("strong", null, "تعريفات"));
    const list = h("ul");
    [
      "نسبة الاتفاق = (مكتملة + اتفاق قائم) ÷ (كل الطلبات − قيد المعالجة).",
      "الحالات المستنتجة تعتمد على وجود سجلات مرشحين ومحادثات؛ تغيير مهلة «غير المحسوم» يغيّر توزيعها ولا يغيّر عدد الطلبات.",
      "قابل للظهور في البحث = حساب فعّال بخدمة فعّالة ومتاح، ورصيده لا يقل عن الحد الأعلى للعمولة، وغير مخفي بسبب تقييم منخفض.",
      "تُعرض الأرقام مجمّعة فقط، بلا أسماء أو هواتف، وتستثني حسابات المدراء."
    ].forEach((text) => list.appendChild(h("li", null, text)));
    note.appendChild(list);
    return note;
  }

  function render(result) {
    const data = obj(result.stats);
    content.replaceChildren();
    content.appendChild(renderNotice(data));
    content.appendChild(renderUsers(data));
    content.appendChild(renderRequestKpis(data));
    const row1 = h("div", "stats-grid");
    row1.append(renderOutcomes(data), renderQuality(data));
    const row2 = h("div", "stats-grid");
    row2.append(renderSeries(data), renderSignups(data));
    content.append(row1, row2, renderCategories(data), renderCells(data), renderRegions(data), renderProviderReadiness(data));
    const row3 = h("div", "stats-grid");
    row3.append(renderTiming(data), renderHeatmap(data));
    content.appendChild(row3);
    content.appendChild(renderManagement(data));
    const owner = renderOwner(data);
    if (owner) content.appendChild(owner);
    content.appendChild(renderDefinitions());
  }

  // ------------------------------------------------------------ التحميل
  async function load() {
    const token = ++loadToken;
    refreshButton.disabled = true;
    setStatus("جارٍ حساب الإحصائيات…", false);
    try {
      const { data, error } = await supabaseClient.auth.getSession();
      if (error || !data.session) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
      const query = "?days=" + encodeURIComponent(periodSelect.value) + "&staleHours=" + encodeURIComponent(staleSelect.value);
      const response = await fetch("/api/stats" + query, {
        headers: { Authorization: "Bearer " + data.session.access_token },
        cache: "no-store"
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "تعذّر تحميل الإحصائيات.");
      if (token !== loadToken) return; // وصلت نتيجة أقدم من آخر طلب
      render(result);
      const generated = obj(obj(result.stats).meta).generated_at;
      const time = generated ? new Date(generated) : null;
      setStatus(time && !Number.isNaN(time.getTime()) ? "آخر تحديث: " + time.toLocaleString("ar") : "تم تحميل الإحصائيات.", false);
    } catch (error) {
      if (token !== loadToken) return;
      content.replaceChildren();
      setStatus(error && error.message ? error.message : "تعذّر تحميل الإحصائيات.", true);
    } finally {
      if (token === loadToken) refreshButton.disabled = false;
    }
  }

  // ------------------------------------------------------------ ربط الصفحة بالقائمة الجانبية
  navButton.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item === navButton));
    document.querySelectorAll("main .page").forEach((section) => section.classList.toggle("hidden", section !== page));
    document.getElementById("page-title").textContent = "الإحصائيات";
    void load();
  });
  // app.js يخفي الصفحات المعرّفة عنده فقط، فنخفي صفحتنا عند الانتقال لغيرها.
  document.querySelectorAll(".nav-item").forEach((item) => {
    if (item !== navButton) item.addEventListener("click", () => page.classList.add("hidden"));
  });

  periodSelect.addEventListener("change", () => void load());
  staleSelect.addEventListener("change", () => void load());
  refreshButton.addEventListener("click", () => void load());
})();
