// صفحة إدارة المدراء. لا تظهر إلا للمالك، وكل إجراء حساس يتحقق منه الخادم.
(function () {
  "use strict";

  const navButton = document.querySelector('[data-page="admins"]');
  const page = document.getElementById("admins-page");
  const refreshButton = document.getElementById("refresh-admins");
  const statusLine = document.getElementById("admins-status");
  const tableBody = document.getElementById("admins-table-body");
  if (!navButton || !page || !refreshButton || !statusLine || !tableBody) return;

  const ROLE_LABELS = { owner: "مالك", support: "دعم" };
  const STATUS_LABELS = { active: "فعّال", suspended: "موقوف" };
  let loading = false;

  async function api(method, body) {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    const response = await fetch("/api/admins", {
      method,
      headers: {
        Authorization: "Bearer " + data.session.access_token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const failure = new Error(result.error || "تعذّرت معالجة طلب إدارة المدراء.");
      failure.status = response.status;
      throw failure;
    }
    return result;
  }

  function cell(row, value) {
    const td = document.createElement("td");
    td.textContent = value;
    row.appendChild(td);
    return td;
  }

  function renderAdmins(admins) {
    tableBody.replaceChildren();
    if (!admins.length) {
      const row = document.createElement("tr");
      const empty = cell(row, "لا توجد حسابات إدارة مسجّلة.");
      empty.colSpan = 6;
      empty.className = "empty-users";
      tableBody.appendChild(row);
      return;
    }

    admins.forEach((admin) => {
      const row = document.createElement("tr");
      cell(row, admin.name || "اسم غير مضاف");
      cell(row, admin.email || "—");

      const roleCell = document.createElement("td");
      const role = document.createElement("span");
      role.className = "admin-role-label" + (admin.role === "support" ? " admin-role-support" : "");
      role.textContent = ROLE_LABELS[admin.role] || "غير معروف";
      roleCell.appendChild(role);
      row.appendChild(roleCell);

      cell(row, STATUS_LABELS[admin.status] || admin.status || "غير معروفة");
      cell(row, admin.mfaEnabled
        ? "مفعّلة"
        : admin.mfaFactorCount > 0 ? "إعداد غير مكتمل" : "غير مفعّلة");

      const actionCell = document.createElement("td");
      if (admin.role === "support" && admin.status === "active" &&
          !admin.isCurrentAdmin && admin.mfaFactorCount > 0) {
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "secondary-button admin-mfa-reset";
        reset.textContent = "إعادة ضبط المصادقة";
        reset.addEventListener("click", () => resetMfa(admin, reset));
        actionCell.appendChild(reset);
      } else if (admin.role === "owner") {
        actionCell.textContent = "محمي";
      } else if (admin.isCurrentAdmin) {
        actionCell.textContent = "حسابك الحالي";
      } else {
        actionCell.textContent = "لا يلزم إجراء";
      }
      row.appendChild(actionCell);
      tableBody.appendChild(row);
    });
  }

  async function loadAdmins() {
    if (loading) return;
    loading = true;
    refreshButton.disabled = true;
    statusLine.classList.remove("error", "success");
    statusLine.textContent = "جارٍ تحميل حسابات الإدارة وحالة المصادقة…";
    try {
      if (adminState.role !== "owner") throw new Error("هذه الصفحة متاحة للمالك فقط.");
      const result = await api("GET");
      const admins = Array.isArray(result.admins) ? result.admins : [];
      renderAdmins(admins);
      statusLine.textContent = "تم تحميل " + admins.length + " حساب إدارة.";
    } catch (error) {
      tableBody.replaceChildren();
      statusLine.textContent = error.message;
      statusLine.classList.add("error");
    } finally {
      loading = false;
      refreshButton.disabled = false;
    }
  }

  async function resetMfa(admin, button) {
    const confirmed = window.confirm(
      "هل تريد إعادة ضبط المصادقة الثنائية لهذا الحساب؟\n\n" +
      "سيتم حذف عامل المصادقة الحالي وإنهاء جلسات المدير. سيحتاج إلى تسجيل الدخول وربط تطبيق مصادقة جديد."
    );
    if (!confirmed) return;

    button.disabled = true;
    statusLine.classList.remove("error", "success");
    statusLine.textContent = "جارٍ إعادة ضبط المصادقة…";
    try {
      const result = await api("POST", { userId: admin.id });
      await loadAdmins();
      statusLine.textContent = result.message || "تمت إعادة ضبط المصادقة.";
      statusLine.classList.remove("error");
      statusLine.classList.add("success");
    } catch (error) {
      statusLine.textContent = error.message;
      statusLine.classList.add("error");
      button.disabled = false;
    }
  }

  navButton.addEventListener("click", () => {
    document.querySelectorAll("main .page").forEach((section) => {
      section.classList.toggle("hidden", section !== page);
    });
    document.getElementById("page-title").textContent = "إدارة المدراء";
    void loadAdmins();
  });
  document.querySelectorAll(".nav-item").forEach((item) => {
    if (item !== navButton) item.addEventListener("click", () => page.classList.add("hidden"));
  });
  refreshButton.addEventListener("click", () => void loadAdmins());
})();
