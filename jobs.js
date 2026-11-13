// صفحة "فرص العمل" في لوحة التحكم: الوظائف، البلاغات، الإعلانات، الكلمات المحظورة، الإعدادات.
// تعتمد على supabaseClient و adminState المعرّفين في app.js (يُحمَّل هذا الملف بعده).
// كل النصوص تُدرَج بـ textContent (لا innerHTML)، ولا أنماط inline لأن CSP صارمة.
(function () {
  "use strict";

  const navButton = document.querySelector('[data-page="jobs"]');
  const page = document.getElementById("jobs-page");
  if (!navButton || !page) return;

  const PAGE_SIZE = 30;
  const statusLine = document.getElementById("jobs-status");
  const refreshButton = document.getElementById("jobs-refresh");
  const tabButtons = Array.from(page.querySelectorAll("[data-jobs-tab]"));
  const panels = {
    jobs: document.getElementById("jobs-tab-jobs"),
    reports: document.getElementById("jobs-tab-reports"),
    ads: document.getElementById("jobs-tab-ads"),
    words: document.getElementById("jobs-tab-words"),
    settings: document.getElementById("jobs-tab-settings")
  };
  const OWNER_TABS = ["ads", "words", "settings"];

  const JOB_STATUS_TEXT = { active: "فعّالة", closed: "مغلقة", hidden: "مخفية", expired: "منتهية" };
  const REPORT_STATUS_TEXT = { open: "مفتوح", resolved: "عولج", dismissed: "متجاهَل" };
  const REPORT_REASON_TEXT = {
    scam: "احتيال أو وظيفة وهمية",
    inappropriate: "محتوى غير لائق",
    spam: "إعلان مزعج أو مكرر",
    other: "سبب آخر"
  };
  const CONTACT_TEXT = { phone: "هاتف", whatsapp: "واتساب", email: "بريد", link: "رابط" };
  const HIDDEN_REASON_TEXT = { auto_reports: "إخفاء تلقائي بسبب البلاغات", admin: "إخفاء من الإدارة", report: "إخفاء بعد بلاغ" };

  let activeTab = "jobs";
  let jobsOffset = 0;
  let jobsTotal = 0;
  let editingAdId = null;
  let busy = false;

  // ---------- أدوات عامة ----------
  const isOwner = () => adminState.role === "owner";

  async function accessToken() {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    return data.session.access_token;
  }

  async function api(method, query, body) {
    const token = await accessToken();
    const response = await fetch("/api/jobs" + (query || ""), {
      method,
      headers: {
        Authorization: "Bearer " + token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || "تعذّر إتمام العملية.");
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function setStatus(message, isError) {
    statusLine.textContent = message;
    statusLine.classList.toggle("error", Boolean(isError));
  }

  function cell(row, value) {
    const td = document.createElement("td");
    if (value instanceof Node) td.appendChild(value);
    else td.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
    row.appendChild(td);
    return td;
  }

  function sub(text) {
    const small = document.createElement("small");
    small.className = "jobs-sub";
    small.textContent = text;
    return small;
  }

  function actionButton(label, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className + " user-state-button";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  function emptyRow(body, columns, message) {
    const row = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = columns;
    td.className = "empty-users";
    td.textContent = message;
    row.appendChild(td);
    body.replaceChildren(row);
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("ar", { dateStyle: "medium", timeStyle: "short" });
  }

  function toLocalInput(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
      "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  function fromLocalInput(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function supabaseImageOrigin() {
    try {
      return new URL(window.SHO_BDK_CONFIG.supabaseUrl).origin;
    } catch {
      return "";
    }
  }

  async function run(label, task) {
    if (busy) return;
    busy = true;
    setStatus(label, false);
    try {
      await task();
    } catch (error) {
      setStatus(error.message || "تعذّر إتمام العملية.", true);
    } finally {
      busy = false;
    }
  }

  // ---------- الإحصائيات ----------
  async function loadStats() {
    const { data } = await api("GET", "?view=stats");
    const set = (id, value) => { document.getElementById(id).textContent = String(value ?? "—"); };
    set("jobs-stat-active", data.active);
    set("jobs-stat-hidden", data.hidden);
    set("jobs-stat-reports", data.open_reports);
    set("jobs-stat-ads", data.ads_live);
    set("jobs-stat-impressions", data.impressions);
    set("jobs-stat-clicks", data.clicks);
    const badge = document.getElementById("jobs-reports-badge");
    badge.textContent = String(data.open_reports);
    badge.classList.toggle("hidden", !(Number(data.open_reports) > 0));
  }

  // ---------- الوظائف ----------
  function jobStatusKey(job) {
    if (job.status === "active" && new Date(job.expires_at).getTime() <= Date.now()) return "expired";
    return job.status;
  }

  async function loadJobs() {
    const status = document.getElementById("jobs-status-filter").value;
    const q = document.getElementById("jobs-search").value.trim();
    const params = new URLSearchParams({ view: "jobs", limit: String(PAGE_SIZE), offset: String(jobsOffset) });
    if (status) params.set("status", status);
    if (q) params.set("q", q);
    const { data } = await api("GET", "?" + params.toString());
    jobsTotal = Number(data.total) || 0;
    renderJobs(data.items || []);
    const from = jobsTotal === 0 ? 0 : jobsOffset + 1;
    const to = Math.min(jobsOffset + PAGE_SIZE, jobsTotal);
    document.getElementById("jobs-page-info").textContent = from + "–" + to + " من " + jobsTotal;
    document.getElementById("jobs-prev").disabled = jobsOffset === 0;
    document.getElementById("jobs-next").disabled = jobsOffset + PAGE_SIZE >= jobsTotal;
    setStatus(jobsTotal === 0 ? "لا توجد وظائف مطابقة." : "تم تحميل الوظائف.", false);
  }

  function renderJobs(items) {
    const body = document.getElementById("jobs-table-body");
    if (items.length === 0) return emptyRow(body, 7, "لا توجد وظائف.");
    body.replaceChildren();
    for (const job of items) {
      const row = document.createElement("tr");

      const titleCell = document.createElement("div");
      titleCell.className = "jobs-title-cell";
      const strong = document.createElement("strong");
      strong.textContent = job.title;
      titleCell.append(strong, sub(String(job.description || "").slice(0, 140)));
      cell(row, titleCell);

      cell(row, [job.region, job.area].filter(Boolean).join(" - "));
      cell(row, job.user_name || "—");

      const contact = document.createElement("span");
      contact.textContent = (CONTACT_TEXT[job.contact_type] || "") + ": " + (job.contact_value || "—");
      cell(row, contact);

      const key = jobStatusKey(job);
      const pill = document.createElement("span");
      pill.className = "jobs-status-pill" + (key === "hidden" ? " is-hidden" : key === "expired" ? " is-expired" : "");
      pill.textContent = JOB_STATUS_TEXT[key] || key;
      const statusCell = cell(row, pill);
      if (job.status === "hidden" && job.hidden_reason) {
        statusCell.appendChild(sub(HIDDEN_REASON_TEXT[job.hidden_reason] || job.hidden_reason));
      }
      statusCell.appendChild(sub(fmtDate(job.created_at)));

      cell(row, String(job.open_reports ?? 0));

      const actions = document.createElement("div");
      actions.className = "jobs-actions";
      if (job.status === "hidden") {
        actions.appendChild(actionButton("استعادة", "secondary-button", () => restoreJob(job)));
      } else {
        actions.appendChild(actionButton("إخفاء", "secondary-button", () => hideJob(job)));
      }
      actions.appendChild(actionButton("حذف", "danger-button", () => deleteJob(job)));
      cell(row, actions);
      body.appendChild(row);
    }
  }

  async function mutate(action, payload, doneMessage) {
    await api("POST", "", { action, ...payload });
    setStatus(doneMessage, false);
  }

  function hideJob(job) {
    const reason = window.prompt("سبب الإخفاء (اختياري):", "مخالف لشروط الاستخدام");
    if (reason === null) return;
    void run("جارٍ إخفاء الوظيفة…", async () => {
      await mutate("set_job_status", { jobId: job.id, status: "hidden", reason }, "تم إخفاء الوظيفة.");
      await Promise.all([loadJobs(), loadStats()]);
    });
  }

  function restoreJob(job) {
    if (!window.confirm("استعادة هذه الوظيفة وإظهارها للمستخدمين؟ ستُجدَّد مدتها وتُغلق بلاغاتها المفتوحة.")) return;
    void run("جارٍ استعادة الوظيفة…", async () => {
      await mutate("set_job_status", { jobId: job.id, status: "active" }, "تمت استعادة الوظيفة.");
      await Promise.all([loadJobs(), loadStats()]);
    });
  }

  function deleteJob(job) {
    if (!window.confirm("حذف هذه الوظيفة نهائياً؟ لا يمكن التراجع.")) return;
    const reason = window.prompt("سبب الحذف (اختياري):", "");
    if (reason === null) return;
    void run("جارٍ حذف الوظيفة…", async () => {
      await mutate("delete_job", { jobId: job.id, reason }, "تم حذف الوظيفة.");
      await Promise.all([loadJobs(), loadStats()]);
    });
  }

  // ---------- البلاغات ----------
  async function loadReports() {
    const status = document.getElementById("job-reports-filter").value;
    const { data } = await api("GET", "?view=reports&status=" + encodeURIComponent(status) + "&limit=50");
    renderReports(data.items || []);
    const total = Number(data.total) || 0;
    setStatus(total === 0 ? "لا توجد بلاغات." : "عدد البلاغات: " + total + (total > 50 ? " (يُعرض أحدث 50)" : ""), false);
  }

  function renderReports(items) {
    const body = document.getElementById("job-reports-table-body");
    if (items.length === 0) return emptyRow(body, 7, "لا توجد بلاغات.");
    body.replaceChildren();
    for (const report of items) {
      const row = document.createElement("tr");

      const jobCell = document.createElement("div");
      jobCell.className = "jobs-title-cell";
      const strong = document.createElement("strong");
      strong.textContent = report.job_title;
      jobCell.append(strong, sub("صاحبها: " + (report.job_owner_name || "—") + " — " + (JOB_STATUS_TEXT[report.job_status] || report.job_status)));
      cell(row, jobCell);

      cell(row, REPORT_REASON_TEXT[report.reason] || report.reason);
      cell(row, report.details || "—");
      cell(row, report.reporter_name || "—");
      cell(row, fmtDate(report.created_at));
      cell(row, REPORT_STATUS_TEXT[report.status] || report.status);

      const actions = document.createElement("div");
      actions.className = "jobs-actions";
      if (report.status === "open") {
        actions.appendChild(actionButton("إخفاء الوظيفة", "secondary-button", () => resolveReport(report, "hide_job")));
        actions.appendChild(actionButton("حذف الوظيفة", "danger-button", () => resolveReport(report, "delete_job")));
        actions.appendChild(actionButton("تجاهل", "secondary-button", () => resolveReport(report, "dismiss")));
      }
      cell(row, actions);
      body.appendChild(row);
    }
  }

  function resolveReport(report, resolution) {
    if (resolution === "delete_job" && !window.confirm("حذف الوظيفة نهائياً؟ لا يمكن التراجع.")) return;
    const note = resolution === "dismiss" ? "" : window.prompt("ملاحظة / سبب (اختياري):", "");
    if (note === null) return;
    void run("جارٍ حفظ القرار…", async () => {
      await mutate("resolve_report", { reportId: report.id, resolution, note }, "تم حفظ القرار.");
      await Promise.all([loadReports(), loadStats()]);
    });
  }

  // ---------- الإعلانات ----------
  async function loadAds() {
    const { data } = await api("GET", "?view=ads");
    renderAds(Array.isArray(data) ? data : []);
    setStatus(Array.isArray(data) && data.length > 0 ? "تم تحميل الإعلانات." : "لا توجد إعلانات بعد.", false);
  }

  function renderAds(items) {
    const body = document.getElementById("job-ads-table-body");
    if (items.length === 0) return emptyRow(body, 7, "لا توجد إعلانات.");
    body.replaceChildren();
    const imageOrigin = supabaseImageOrigin();
    for (const ad of items) {
      const row = document.createElement("tr");
      cell(row, ad.title);

      const imageCell = document.createElement("div");
      let canPreview = false;
      try { canPreview = Boolean(imageOrigin) && new URL(ad.image_url).origin === imageOrigin; } catch { canPreview = false; }
      if (canPreview) {
        const img = document.createElement("img");
        img.className = "jobs-ad-thumb";
        img.src = ad.image_url;
        img.alt = ad.title;
        imageCell.appendChild(img);
      }
      const link = document.createElement("a");
      link.className = "jobs-ad-link";
      link.href = ad.image_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "فتح الصورة";
      imageCell.appendChild(link);
      cell(row, imageCell);

      const schedule = document.createElement("span");
      schedule.textContent = ad.starts_at || ad.ends_at
        ? "من " + (ad.starts_at ? fmtDate(ad.starts_at) : "الآن") + " إلى " + (ad.ends_at ? fmtDate(ad.ends_at) : "بلا نهاية")
        : "دائم";
      cell(row, schedule);

      cell(row, String(ad.priority));
      cell(row, String(ad.impressions) + " / " + String(ad.clicks));

      const pill = document.createElement("span");
      pill.className = "jobs-status-pill" + (ad.is_live ? "" : " is-expired");
      pill.textContent = ad.is_live ? "ظاهر الآن" : ad.is_active ? "خارج الجدولة" : "متوقف";
      cell(row, pill);

      const actions = document.createElement("div");
      actions.className = "jobs-actions";
      const edit = actionButton("تعديل", "secondary-button", () => startEditAd(ad));
      const remove = actionButton("حذف", "danger-button", () => deleteAd(ad));
      edit.disabled = !isOwner();
      remove.disabled = !isOwner();
      actions.append(edit, remove);
      cell(row, actions);
      body.appendChild(row);
    }
  }

  const adForm = document.getElementById("job-ad-form");
  const adCancel = document.getElementById("job-ad-cancel");

  function resetAdForm() {
    editingAdId = null;
    adForm.reset();
    document.getElementById("job-ad-form-title").textContent = "إعلان جديد";
    document.getElementById("job-ad-save").textContent = "حفظ الإعلان";
    adCancel.classList.add("hidden");
  }

  function startEditAd(ad) {
    editingAdId = ad.id;
    document.getElementById("job-ad-title").value = ad.title;
    document.getElementById("job-ad-image").value = ad.image_url;
    document.getElementById("job-ad-link").value = ad.link_url || "";
    document.getElementById("job-ad-priority").value = String(ad.priority);
    document.getElementById("job-ad-starts").value = toLocalInput(ad.starts_at);
    document.getElementById("job-ad-ends").value = toLocalInput(ad.ends_at);
    document.getElementById("job-ad-active").value = ad.is_active ? "true" : "false";
    document.getElementById("job-ad-form-title").textContent = "تعديل الإعلان";
    document.getElementById("job-ad-save").textContent = "حفظ التعديلات";
    adCancel.classList.remove("hidden");
    adForm.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  adCancel.addEventListener("click", resetAdForm);

  adForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!isOwner()) return;
    const payload = {
      action: "save_ad",
      id: editingAdId,
      title: document.getElementById("job-ad-title").value,
      imageUrl: document.getElementById("job-ad-image").value,
      linkUrl: document.getElementById("job-ad-link").value,
      priority: Number(document.getElementById("job-ad-priority").value || 0),
      startsAt: fromLocalInput(document.getElementById("job-ad-starts").value),
      endsAt: fromLocalInput(document.getElementById("job-ad-ends").value),
      isActive: document.getElementById("job-ad-active").value === "true"
    };
    void run("جارٍ حفظ الإعلان…", async () => {
      await api("POST", "", payload);
      resetAdForm();
      await Promise.all([loadAds(), loadStats()]);
      setStatus("تم حفظ الإعلان.", false);
    });
  });

  function deleteAd(ad) {
    if (!window.confirm("حذف هذا الإعلان نهائياً؟")) return;
    void run("جارٍ حذف الإعلان…", async () => {
      await mutate("delete_ad", { id: ad.id }, "تم حذف الإعلان.");
      if (editingAdId === ad.id) resetAdForm();
      await Promise.all([loadAds(), loadStats()]);
    });
  }

  // ---------- الكلمات المحظورة ----------
  async function loadWords() {
    const { data } = await api("GET", "?view=words");
    renderWords(Array.isArray(data) ? data : []);
    setStatus(Array.isArray(data) ? "عدد الكلمات المحظورة: " + data.length : "تم التحميل.", false);
  }

  function renderWords(items) {
    const body = document.getElementById("job-words-table-body");
    if (items.length === 0) return emptyRow(body, 4, "لا توجد كلمات محظورة.");
    body.replaceChildren();
    for (const item of items) {
      const row = document.createElement("tr");
      cell(row, item.word);
      cell(row, item.whole_word ? "كلمة كاملة" : "داخل النص");
      cell(row, fmtDate(item.created_at));
      const remove = actionButton("حذف", "danger-button", () => deleteWord(item));
      remove.disabled = !isOwner();
      const actions = document.createElement("div");
      actions.className = "jobs-actions";
      actions.appendChild(remove);
      cell(row, actions);
      body.appendChild(row);
    }
  }

  document.getElementById("job-word-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!isOwner()) return;
    const input = document.getElementById("job-word-input");
    const payload = {
      action: "add_word",
      word: input.value,
      wholeWord: document.getElementById("job-word-whole").value === "true"
    };
    void run("جارٍ إضافة الكلمة…", async () => {
      await api("POST", "", payload);
      input.value = "";
      await loadWords();
      setStatus("تمت إضافة الكلمة.", false);
    });
  });

  function deleteWord(item) {
    if (!window.confirm("حذف هذه الكلمة من القائمة المحظورة؟")) return;
    void run("جارٍ حذف الكلمة…", async () => {
      await mutate("delete_word", { id: item.id }, "تم حذف الكلمة.");
      await loadWords();
    });
  }

  // ---------- الإعدادات ----------
  async function loadSettings() {
    const { data } = await api("GET", "?view=settings");
    document.getElementById("jobs-set-enabled").value = data.jobs_enabled ? "true" : "false";
    document.getElementById("jobs-set-ad-every").value = String(data.jobs_ad_every_n);
    document.getElementById("jobs-set-max-active").value = String(data.jobs_max_active_per_user);
    document.getElementById("jobs-set-expiry").value = String(data.jobs_expiry_days);
    document.getElementById("jobs-set-threshold").value = String(data.jobs_report_auto_hide_threshold);
    setStatus("تم تحميل إعدادات الوظائف.", false);
  }

  document.getElementById("jobs-settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!isOwner()) return;
    const payload = {
      action: "save_settings",
      enabled: document.getElementById("jobs-set-enabled").value === "true",
      adEveryN: Number(document.getElementById("jobs-set-ad-every").value),
      maxActive: Number(document.getElementById("jobs-set-max-active").value),
      expiryDays: Number(document.getElementById("jobs-set-expiry").value),
      reportThreshold: Number(document.getElementById("jobs-set-threshold").value)
    };
    void run("جارٍ حفظ الإعدادات…", async () => {
      await api("POST", "", payload);
      await loadSettings();
      setStatus("تم حفظ إعدادات الوظائف.", false);
    });
  });

  // ---------- التبويبات والتحميل ----------
  function applyRole() {
    const owner = isOwner();
    for (const name of OWNER_TABS) {
      panels[name].querySelectorAll("input, select, button.primary-button").forEach((control) => {
        control.disabled = !owner;
      });
      let note = panels[name].querySelector(".jobs-readonly-note");
      if (!owner && !note) {
        note = document.createElement("p");
        note.className = "jobs-readonly-note";
        note.textContent = "هذا القسم للقراءة فقط. التعديل متاح للمالك.";
        panels[name].prepend(note);
      } else if (owner && note) {
        note.remove();
      }
    }
  }

  function loaderFor(tab) {
    return { jobs: loadJobs, reports: loadReports, ads: loadAds, words: loadWords, settings: loadSettings }[tab];
  }

  function reloadActive() {
    void run("جارٍ التحميل…", async () => {
      applyRole();
      await Promise.all([loaderFor(activeTab)(), loadStats()]);
    });
  }

  function selectTab(tab) {
    activeTab = tab;
    tabButtons.forEach((button) => button.classList.toggle("active", button.dataset.jobsTab === tab));
    Object.entries(panels).forEach(([name, panel]) => panel.classList.toggle("hidden", name !== tab));
    reloadActive();
  }

  tabButtons.forEach((button) => button.addEventListener("click", () => selectTab(button.dataset.jobsTab)));
  navButton.addEventListener("click", () => reloadActive());
  refreshButton.addEventListener("click", () => reloadActive());

  document.getElementById("jobs-status-filter").addEventListener("change", () => { jobsOffset = 0; reloadActive(); });
  document.getElementById("job-reports-filter").addEventListener("change", () => reloadActive());
  document.getElementById("jobs-search").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); jobsOffset = 0; reloadActive(); }
  });
  document.getElementById("jobs-prev").addEventListener("click", () => {
    jobsOffset = Math.max(0, jobsOffset - PAGE_SIZE);
    reloadActive();
  });
  document.getElementById("jobs-next").addEventListener("click", () => {
    if (jobsOffset + PAGE_SIZE < jobsTotal) { jobsOffset += PAGE_SIZE; reloadActive(); }
  });
})();
