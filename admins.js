// صفحة إدارة المدراء. جميع إجراءات الصلاحيات محمية على الخادم ومخصصة للمالك.
(function () {
  "use strict";

  const navButton = document.querySelector('[data-page="admins"]');
  const page = document.getElementById("admins-page");
  const refreshButton = document.getElementById("refresh-admins");
  const statusLine = document.getElementById("admins-status");
  const tableBody = document.getElementById("admins-table-body");
  const searchInput = document.getElementById("admins-search-input");
  const searchButton = document.getElementById("admins-search-button");
  const searchStatus = document.getElementById("admins-search-status");
  const searchResults = document.getElementById("admins-search-results");
  if (!navButton || !page || !refreshButton || !statusLine || !tableBody ||
      !searchInput || !searchButton || !searchStatus || !searchResults) return;

  const ROLE_LABELS = { owner: "مالك", support: "دعم" };
  const STATUS_LABELS = { active: "فعّال", suspended: "موقوف" };
  let loading = false;
  let searching = false;

  async function api(method, body, path = "/api/admins") {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    const response = await fetch(path, {
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

  function actionButton(label, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
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
      const actions = document.createElement("div");
      actions.className = "admin-row-actions";
      if (admin.role === "support" && admin.status === "active" && !admin.isCurrentAdmin) {
        if (admin.mfaFactorCount > 0) {
          actions.appendChild(actionButton("إعادة ضبط المصادقة", "secondary-button admin-mfa-reset",
            (event) => resetMfa(admin, event.currentTarget)));
        }
        actions.appendChild(actionButton("إزالة من الإدارة", "secondary-button admin-remove-button",
          (event) => removeSupport(admin, event.currentTarget)));
      } else if (admin.role === "owner") {
        actions.textContent = "محمي";
      } else if (admin.isCurrentAdmin) {
        actions.textContent = "حسابك الحالي";
      } else {
        actions.textContent = "لا يلزم إجراء";
      }
      actionCell.appendChild(actions);
      row.appendChild(actionCell);
      tableBody.appendChild(row);
    });
  }

  function renderSearchResults(users) {
    searchResults.replaceChildren();
    if (!users.length) {
      const row = document.createElement("tr");
      const empty = cell(row, "لم نعثر على مستخدم فعّال بهذا الاسم.");
      empty.colSpan = 3;
      empty.className = "empty-users";
      searchResults.appendChild(row);
      return;
    }
    users.forEach((user) => {
      const row = document.createElement("tr");
      cell(row, user.name || "اسم غير مضاف");
      cell(row, user.email || "—");
      const action = document.createElement("td");
      action.appendChild(actionButton("إضافة كمدير دعم", "primary-button admin-add-button",
        (event) => promoteSupport(user, event.currentTarget)));
      row.appendChild(action);
      searchResults.appendChild(row);
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

  async function searchUsers() {
    if (searching) return;
    const query = searchInput.value.trim();
    if (query.length < 2) {
      searchStatus.textContent = "اكتب حرفين على الأقل للبحث.";
      searchStatus.classList.add("error");
      return;
    }
    searching = true;
    searchButton.disabled = true;
    searchStatus.classList.remove("error", "success");
    searchStatus.textContent = "جارٍ البحث عن المستخدمين…";
    try {
      const result = await api("GET", undefined, "/api/admins?search=" + encodeURIComponent(query));
      const users = Array.isArray(result.users) ? result.users : [];
      renderSearchResults(users);
      searchStatus.textContent = "نتائج البحث: " + users.length + ".";
    } catch (error) {
      searchResults.replaceChildren();
      searchStatus.textContent = error.message;
      searchStatus.classList.add("error");
    } finally {
      searching = false;
      searchButton.disabled = false;
    }
  }

  async function promoteSupport(user, button) {
    if (!window.confirm(
      "هل تريد إضافة " + (user.name || "هذا المستخدم") +
      " مدير دعم؟\n\nسيحصل على صلاحيات الدعم فقط، ولن يستطيع إدارة المدراء أو إعدادات التطبيق. يجب أن يفعّل المصادقة الثنائية قبل دخول اللوحة."
    )) return;
    button.disabled = true;
    searchStatus.classList.remove("error", "success");
    searchStatus.textContent = "جارٍ إضافة مدير الدعم…";
    try {
      const result = await api("POST", { action: "promote_support", userId: user.id });
      await searchUsers();
      await loadAdmins();
      searchStatus.textContent = result.message || "تمت إضافة مدير الدعم.";
      searchStatus.classList.remove("error");
      searchStatus.classList.add("success");
    } catch (error) {
      searchStatus.textContent = error.message;
      searchStatus.classList.add("error");
      button.disabled = false;
    }
  }

  async function removeSupport(admin, button) {
    if (!window.confirm(
      "هل تريد إزالة صلاحيات الإدارة من " + (admin.name || "هذا المدير") +
      "؟\n\nسيعود حسابه مستخدماً عادياً، ولن يُحذف حسابه أو أي من بياناته. لن يعود قادراً على استخدام لوحة التحكم."
    )) return;
    button.disabled = true;
    statusLine.classList.remove("error", "success");
    statusLine.textContent = "جارٍ إزالة صلاحيات الإدارة…";
    try {
      const result = await api("POST", { action: "remove_support", userId: admin.id });
      await loadAdmins();
      statusLine.textContent = result.message || "تمت إزالة صلاحيات الإدارة.";
      statusLine.classList.remove("error");
      statusLine.classList.add("success");
    } catch (error) {
      statusLine.textContent = error.message;
      statusLine.classList.add("error");
      button.disabled = false;
    }
  }

  async function resetMfa(admin, button) {
    if (!window.confirm(
      "هل تريد إعادة ضبط المصادقة الثنائية لهذا الحساب؟\n\n" +
      "سيتم حذف عامل المصادقة الحالي. سيحتاج المدير إلى تسجيل الدخول وربط تطبيق مصادقة جديد."
    )) return;
    button.disabled = true;
    statusLine.classList.remove("error", "success");
    statusLine.textContent = "جارٍ إعادة ضبط المصادقة…";
    try {
      const result = await api("POST", { action: "reset_mfa", userId: admin.id });
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
  searchButton.addEventListener("click", () => void searchUsers());
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void searchUsers();
    }
  });
})();
