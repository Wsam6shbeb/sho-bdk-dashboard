// صفحة "طلبات التوثيق" في لوحة التحكم.
// تعتمد على supabaseClient و adminState المعرّفين في app.js (يُحمَّل هذا الملف بعده).
// كل النصوص تُدرَج بـ textContent، والصور تصل من نفس الأصل كـ data: URL (متوافق مع CSP الصارمة).
(function () {
  "use strict";

  const navButton = document.querySelector('[data-page="verifications"]');
  const page = document.getElementById("verifications-page");
  const modal = document.getElementById("verification-review-modal");
  const modalBody = document.getElementById("verification-review-body");
  if (!navButton || !page || !modal || !modalBody) return;

  const statusLine = document.getElementById("verifications-status");
  const tableBody = document.getElementById("verifications-table-body");
  const filterSelect = document.getElementById("verifications-filter");
  const refreshButton = document.getElementById("refresh-verifications");

  const STATUS_TEXT = { pending: "قيد المراجعة", approved: "موثّق", rejected: "مرفوض" };
  const STATUS_CLASS = { pending: "vr-pending", approved: "status-active", rejected: "status-inactive" };
  const REJECT_REASONS = [
    "الصورة غير واضحة. أعد التقاطها بإضاءة جيدة.",
    "الهوية غير مقروءة أو مقصوصة. صوّر الوجه الأمامي كاملاً.",
    "الوجه في السيلفي لا يطابق صورة الهوية.",
    "السيلفي ليست حديثة أو ليست لصاحب الحساب."
  ];
  const OTHER_REASON = "__other__";

  let loading = false;
  let reviewing = false;

  async function accessToken() {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    return data.session.access_token;
  }

  async function api(method, query, body) {
    const token = await accessToken();
    const response = await fetch("/api/verifications" + (query || ""), {
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

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("تعذّر قراءة الصورة."));
      reader.readAsDataURL(blob);
    });
  }

  async function fetchImage(id, which) {
    const token = await accessToken();
    const response = await fetch("/api/verifications?id=" + encodeURIComponent(id) + "&file=" + which, {
      headers: { Authorization: "Bearer " + token },
      cache: "no-store"
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || "تعذّر تحميل الصورة.");
    }
    return blobToDataUrl(await response.blob());
  }

  function formatDate(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toLocaleString("ar") : "—";
  }

  function badge(status) {
    const element = document.createElement("span");
    element.className = "user-status " + (STATUS_CLASS[status] || "");
    element.textContent = STATUS_TEXT[status] || status;
    return element;
  }

  function setStatus(message, isError) {
    statusLine.textContent = message;
    statusLine.classList.toggle("error", Boolean(isError));
  }

  function ownerOnly() {
    return typeof adminState !== "undefined" && adminState.role === "support";
  }

  // ---------------------------------------------------------------- القائمة
  function renderRows(items) {
    tableBody.replaceChildren();
    if (items.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 5;
      cell.className = "empty-users";
      cell.textContent = "ما في طلبات بهالحالة.";
      row.appendChild(cell);
      tableBody.appendChild(row);
      return;
    }
    items.forEach((item) => {
      const row = document.createElement("tr");
      const nameCell = document.createElement("td");
      const name = document.createElement("strong");
      name.textContent = (item.user && item.user.full_name) || "اسم غير مضاف";
      nameCell.appendChild(name);
      const phoneCell = document.createElement("td");
      phoneCell.textContent = (item.user && item.user.phone) || "—";
      const dateCell = document.createElement("td");
      dateCell.textContent = formatDate(item.created_at);
      const statusCell = document.createElement("td");
      statusCell.appendChild(badge(item.status));
      const actionCell = document.createElement("td");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary-button user-details-button";
      button.textContent = item.status === "pending" ? "مراجعة" : "عرض";
      button.addEventListener("click", () => openReview(item.id));
      actionCell.appendChild(button);
      [nameCell, phoneCell, dateCell, statusCell, actionCell].forEach((cell) => row.appendChild(cell));
      tableBody.appendChild(row);
    });
  }

  async function loadList() {
    if (loading) return;
    if (ownerOnly()) {
      tableBody.replaceChildren();
      setStatus("هذه الصفحة للمالك فقط.", true);
      return;
    }
    loading = true;
    refreshButton.disabled = true;
    setStatus("جارٍ تحميل الطلبات بأمان…", false);
    try {
      const result = await api("GET", "?status=" + encodeURIComponent(filterSelect.value));
      const items = Array.isArray(result.items) ? result.items : [];
      renderRows(items);
      setStatus(items.length === 0 ? "لا توجد طلبات." : "تم تحميل " + items.length + " طلب.", false);
    } catch (error) {
      tableBody.replaceChildren();
      setStatus(error.status === 403 ? "هذه الصفحة للمالك فقط." : error.message, true);
    } finally {
      loading = false;
      refreshButton.disabled = false;
    }
  }

  // ---------------------------------------------------------------- نافذة المراجعة
  function infoRow(label, value) {
    const row = document.createElement("div");
    row.className = "user-detail-row";
    const labelElement = document.createElement("span");
    labelElement.textContent = label;
    const valueElement = document.createElement("strong");
    valueElement.textContent = value;
    row.append(labelElement, valueElement);
    return row;
  }

  function imageFigure(caption) {
    const figure = document.createElement("figure");
    figure.className = "vr-figure";
    const title = document.createElement("figcaption");
    title.textContent = caption;
    const placeholder = document.createElement("p");
    placeholder.className = "vr-placeholder";
    placeholder.textContent = "جارٍ تحميل الصورة…";
    figure.append(title, placeholder);
    return { figure, placeholder };
  }

  function showImage(slot, dataUrl, alt) {
    const image = document.createElement("img");
    image.className = "vr-image";
    image.alt = alt;
    image.src = dataUrl;
    slot.placeholder.replaceWith(image);
  }

  function showImageError(slot, message) {
    slot.placeholder.textContent = message;
    slot.placeholder.classList.add("error");
  }

  function closeReview() {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    modalBody.replaceChildren(); // نزيل الصور من الذاكرة
    reviewing = false;
  }

  async function openReview(id) {
    if (reviewing) return;
    reviewing = true;
    modalBody.replaceChildren();
    const loadingText = document.createElement("p");
    loadingText.className = "helper";
    loadingText.textContent = "جارٍ التحميل…";
    modalBody.appendChild(loadingText);
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");

    let detail;
    try {
      detail = await api("GET", "?id=" + encodeURIComponent(id));
    } catch (error) {
      loadingText.textContent = error.message;
      loadingText.classList.add("error");
      return;
    }

    const verification = detail.verification;
    const user = detail.user || {};
    modalBody.replaceChildren();
    const info = document.createElement("div");
    info.className = "user-details-content";
    info.appendChild(infoRow("اسم الحساب", user.full_name || "اسم غير مضاف"));
    info.appendChild(infoRow("الهاتف", user.phone || "—"));
    info.appendChild(infoRow("المنطقة", user.region || "—"));
    info.appendChild(infoRow("نوع الحساب", user.is_provider ? "مقدّم خدمة" : "مستخدم"));
    info.appendChild(infoRow("تاريخ التسجيل", formatDate(user.created_at)));
    info.appendChild(infoRow("تاريخ الطلب", formatDate(verification.created_at)));
    info.appendChild(infoRow("الحالة", STATUS_TEXT[verification.status] || verification.status));
    if (verification.status === "rejected" && verification.rejection_reason) {
      info.appendChild(infoRow("سبب الرفض", verification.rejection_reason));
    }
    modalBody.appendChild(info);

    const grid = document.createElement("div");
    grid.className = "vr-images";
    const idSlot = imageFigure("الهوية (الوجه الأمامي)");
    const selfieSlot = imageFigure("السيلفي");
    grid.append(idSlot.figure, selfieSlot.figure);
    modalBody.appendChild(grid);
    const message = document.createElement("p");
    message.className = "helper";
    message.setAttribute("role", "status");
    modalBody.appendChild(message);

    fetchImage(id, "id")
      .then((url) => showImage(idSlot, url, "صورة الهوية"))
      .catch((error) => showImageError(idSlot, error.message));
    fetchImage(id, "selfie")
      .then((url) => showImage(selfieSlot, url, "صورة السيلفي"))
      .catch((error) => showImageError(selfieSlot, error.message));

    if (verification.status === "pending") buildDecisionControls(id, message);
  }

  function buildDecisionControls(id, message) {
    const checks = [
      { text: "الوجه في السيلفي هو نفس الوجه في الهوية", required: true },
      { text: "الهوية واضحة ومقروءة وغير مقصوصة", required: true },
      { text: "السيلفي حديثة وحقيقية (ليست صورة لصورة أو لشاشة)", required: true },
      { text: "الاسم على الهوية يشبه اسم الحساب (اختياري)", required: false }
    ];
    const list = document.createElement("div");
    list.className = "vr-checks";
    const boxes = checks.map((item) => {
      const label = document.createElement("label");
      label.className = "vr-check";
      const box = document.createElement("input");
      box.type = "checkbox";
      const text = document.createElement("span");
      text.textContent = item.text;
      label.append(box, text);
      list.appendChild(label);
      return { box, required: item.required };
    });

    const approveButton = document.createElement("button");
    approveButton.type = "button";
    approveButton.className = "primary-button";
    approveButton.textContent = "توثيق الحساب";
    approveButton.disabled = true;
    const syncApprove = () => {
      approveButton.disabled = !boxes.every((item) => !item.required || item.box.checked);
    };
    boxes.forEach((item) => item.box.addEventListener("change", syncApprove));

    const rejectBox = document.createElement("div");
    rejectBox.className = "vr-reject";
    const reasonSelect = document.createElement("select");
    reasonSelect.setAttribute("aria-label", "سبب الرفض");
    reasonSelect.add(new Option("اختر سبب الرفض…", ""));
    REJECT_REASONS.forEach((reason) => reasonSelect.add(new Option(reason, reason)));
    reasonSelect.add(new Option("سبب آخر (اكتبه)", OTHER_REASON));
    const reasonText = document.createElement("textarea");
    reasonText.maxLength = 300;
    reasonText.placeholder = "اكتب سبب الرفض ليظهر للمستخدم";
    reasonText.classList.add("hidden");
    reasonSelect.addEventListener("change", () => {
      reasonText.classList.toggle("hidden", reasonSelect.value !== OTHER_REASON);
    });
    const rejectButton = document.createElement("button");
    rejectButton.type = "button";
    rejectButton.className = "danger-button";
    rejectButton.textContent = "رفض الطلب";
    rejectBox.append(reasonSelect, reasonText, rejectButton);

    const lock = (locked) => {
      approveButton.disabled = locked || !boxes.every((item) => !item.required || item.box.checked);
      rejectButton.disabled = locked;
    };

    async function submitDecision(decision, reason) {
      lock(true);
      message.classList.remove("error");
      message.textContent = "جارٍ حفظ القرار…";
      try {
        const result = await api("POST", "", { id, decision, reason });
        closeReview();
        setStatus(result.message || "تم حفظ القرار.", false);
        await loadList();
      } catch (error) {
        message.textContent = error.message;
        message.classList.add("error");
        lock(false);
      }
    }

    approveButton.addEventListener("click", () => submitDecision("approved", ""));
    rejectButton.addEventListener("click", () => {
      const chosen = reasonSelect.value;
      const reason = chosen === OTHER_REASON ? reasonText.value.trim() : chosen;
      if (!reason) {
        message.textContent = "اختر سبب الرفض أو اكتبه.";
        message.classList.add("error");
        return;
      }
      submitDecision("rejected", reason);
    });

    const actions = document.createElement("div");
    actions.className = "vr-actions";
    actions.appendChild(approveButton);
    modalBody.append(list, actions, rejectBox);
  }

  // ---------------------------------------------------------------- ربط الصفحة بالقائمة الجانبية
  navButton.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item === navButton));
    document.querySelectorAll("main .page").forEach((section) => section.classList.toggle("hidden", section !== page));
    document.getElementById("page-title").textContent = "طلبات التوثيق";
    void loadList();
  });
  // app.js يخفي الصفحات المعرّفة عنده فقط، فنخفي صفحتنا عند الانتقال لغيرها.
  document.querySelectorAll(".nav-item").forEach((item) => {
    if (item !== navButton) item.addEventListener("click", () => page.classList.add("hidden"));
  });

  filterSelect.addEventListener("change", () => void loadList());
  refreshButton.addEventListener("click", () => void loadList());
  document.getElementById("close-verification-review").addEventListener("click", closeReview);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeReview();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.classList.contains("hidden")) closeReview();
  });
})();
