const pages = {
  users: { title: "إدارة المستخدمين", id: "users-page" },
  settings: { title: "إعدادات التطبيق", id: "settings-page" },
  support: { title: "طريقة الدعم", id: "support-page" },
  commission: { title: "العمولة", id: "commission-page" },
  security: { title: "الأمان", id: "security-page" },
  audit: { title: "سجل التدقيق", id: "audit-page" }
};

const loginScreen = document.getElementById("login-screen");
const loginForm = document.getElementById("login-form");
const googleLoginButton = document.getElementById("google-login-button");
const loginMessage = document.getElementById("login-message");
const dashboardShell = document.getElementById("dashboard-shell");
const commissionMinInput = document.getElementById("commission-min");
const commissionMaxInput = document.getElementById("commission-max");
const commissionDefaultInput = document.getElementById("commission-default");
const commissionStatus = document.getElementById("commission-status");
const saveCommissionButton = document.getElementById("save-commission");
const supportEmailInput = document.getElementById("support-email");
const supportPhoneInput = document.getElementById("support-phone");
const supportStatus = document.getElementById("support-status");
const saveSupportButton = document.getElementById("save-support");
const appSettingsForm = document.getElementById("app-settings-form");
const appSettingsStatus = document.getElementById("app-settings-status");
const saveAppSettingsButton = document.getElementById("save-app-settings");
const appSettingsInputs = {
  agreement_approval_timeout_seconds: document.getElementById("setting-agreement-timeout"),
  chat_writable_after_completion_days: document.getElementById("setting-chat-days"),
  currency: document.getElementById("setting-currency"),
  launch_region: document.getElementById("setting-launch-region"),
  notification_retention_days: document.getElementById("setting-notification-days"),
  rating_window_hours: document.getElementById("setting-rating-hours"),
  signup_bonus_amount: document.getElementById("setting-signup-bonus"),
  test_topup_enabled: document.getElementById("setting-test-topup")
};
const supabaseClient = window.supabase?.createClient(
  window.SHO_BDK_CONFIG.supabaseUrl,
  window.SHO_BDK_CONFIG.supabaseKey
);

document.getElementById("year").textContent = new Date().getFullYear();

// Remove the unused landing overview and open user management after admin login.
document.querySelector("[data-page=\"overview\"]")?.remove();
document.getElementById("overview-page")?.remove();
document.getElementById("page-title").textContent = pages.users.title;

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    const selected = button.dataset.page;
    if (!pages[selected]) return;
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item === button));
    Object.values(pages).forEach((page) => document.getElementById(page.id).classList.add("hidden"));
    document.getElementById(pages[selected].id).classList.remove("hidden");
    document.getElementById("page-title").textContent = pages[selected].title;
    if (selected === "users") loadUsers();
    if (selected === "audit") loadAudit();
    if (selected === "security") loadSecurity();
  });
});

function loadAppSettings(settings) {
  const values = settings && typeof settings === "object" ? settings : {};
  let complete = true;
  Object.entries(appSettingsInputs).forEach(([key, input]) => {
    const value = values[key];
    if (value === null || value === undefined) {
      input.value = "";
      complete = false;
    } else {
      input.value = key === "test_topup_enabled" ? String(Boolean(value)) : String(value);
    }
  });
  saveAppSettingsButton.disabled = !complete;
  appSettingsStatus.classList.toggle("error", !complete);
  appSettingsStatus.textContent = complete
    ? "تم تحميل الإعدادات الحالية من قاعدة البيانات."
    : "بعض الإعدادات غير موجودة في قاعدة البيانات؛ لم نفعّل الحفظ حتى لا ننشئ قيماً افتراضية غير مؤكدة.";
}

function readAppSettingsForm() {
  return {
    agreement_approval_timeout_seconds: Number(appSettingsInputs.agreement_approval_timeout_seconds.value),
    chat_writable_after_completion_days: Number(appSettingsInputs.chat_writable_after_completion_days.value),
    currency: appSettingsInputs.currency.value.trim().toUpperCase(),
    launch_region: appSettingsInputs.launch_region.value.trim(),
    notification_retention_days: Number(appSettingsInputs.notification_retention_days.value),
    rating_window_hours: Number(appSettingsInputs.rating_window_hours.value),
    signup_bonus_amount: Number(appSettingsInputs.signup_bonus_amount.value),
    test_topup_enabled: appSettingsInputs.test_topup_enabled.value === "true"
  };
}

function setLoginMessage(message, isError = true) {
  loginMessage.textContent = message || "";
  loginMessage.classList.toggle("error", isError);
  loginMessage.classList.toggle("success", !isError);
}

async function callSettingsApi(session, method = "GET", body) {
  const response = await fetch("/api/settings", {
    method,
    headers: {
      Authorization: "Bearer " + session.access_token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || "تعذّر الاتصال بخدمة الإعدادات.");
    error.status = response.status;
    error.code = result.code || "";
    error.detail = result.detail || "";
    throw error;
  }
  return result;
}

async function enterDashboard(session) {
  // Keep the dashboard hidden until the server confirms this account is authorized.
  loginScreen.classList.remove("hidden");
  dashboardShell.classList.add("hidden");
  commissionMinInput.disabled = true;
  commissionMaxInput.disabled = true;
  commissionDefaultInput.disabled = true;
  saveCommissionButton.disabled = true;
  saveAppSettingsButton.disabled = true;
  setLoginMessage("جارٍ التحقق من صلاحية الحساب...", false);

  try {
    const settings = await callSettingsApi(session);
    // Only reveal the dashboard after the server-side authorization check succeeds.
    loginScreen.classList.add("hidden");
    dashboardShell.classList.remove("hidden");
    document.getElementById("admin-email").textContent = session.user.email;
    document.querySelector("[data-page=\"users\"]").click();
    commissionMinInput.value = String(settings.commissionMin);
    commissionMaxInput.value = String(settings.commissionMax);
    commissionDefaultInput.value = String(settings.commissionDefault);
    commissionStatus.textContent = "تم تحميل قيم العمولة الثلاث من قاعدة البيانات.";
    commissionStatus.classList.remove("error");
    supportEmailInput.value = settings.supportEmail || "shobdkhelpcenter@gmail.com";
    supportPhoneInput.value = settings.supportPhone || "";
    supportStatus.textContent = "تم تحميل معلومات التواصل المحفوظة.";
    supportStatus.classList.remove("error");
    saveSupportButton.disabled = false;
    loadAppSettings(settings.appSettings);
    commissionMinInput.disabled = false;
    commissionMaxInput.disabled = false;
    commissionDefaultInput.disabled = false;
    saveCommissionButton.disabled = false;
    applyAdminState(settings);
    return true;
  } catch (error) {
    if (error.status === 401 && error.code === "MFA_REQUIRED") {
      await showMfa();
      return false;
    }

    if (error.status === 403) {
      dashboardShell.classList.add("hidden");
      loginScreen.classList.remove("hidden");
      await supabaseClient.auth.signOut();
      setLoginMessage("تعذّر تسجيل الدخول. تحقق من بياناتك وحاول مجدداً.");
      return false;
    }

    // A 502 is returned only after server-side authorization succeeded and the database settings read failed.
    // Let the authorized admin enter; keep commission editing disabled until settings load successfully.
    if (error.status === 502) {
      loginScreen.classList.add("hidden");
      dashboardShell.classList.remove("hidden");
      document.getElementById("admin-email").textContent = session.user.email;
      document.querySelector("[data-page=\"users\"]").click();
      commissionMinInput.value = "";
      commissionMaxInput.value = "";
      commissionDefaultInput.value = "";
      commissionMinInput.disabled = true;
      commissionMaxInput.disabled = true;
      commissionDefaultInput.disabled = true;
      saveCommissionButton.disabled = true;
      commissionStatus.textContent = error.message || "تعذّر تحميل العمولة من قاعدة البيانات. يمكنك استخدام لوحة التحكم، وإعداد العمولة غير متاح مؤقتاً.";
      commissionStatus.classList.add("error");
      supportEmailInput.value = "shobdkhelpcenter@gmail.com";
      supportPhoneInput.value = "";
      supportStatus.textContent = "تعذّر تحميل معلومات الدعم. حدّث الصفحة وحاول مجدداً.";
      supportStatus.classList.add("error");
      saveSupportButton.disabled = true;
      appSettingsStatus.textContent = "تعذّر تحميل إعدادات التطبيق من قاعدة البيانات. حدّث الصفحة وحاول مجدداً.";
      appSettingsStatus.classList.add("error");
      saveAppSettingsButton.disabled = true;
      return true;
    }

    dashboardShell.classList.add("hidden");
    loginScreen.classList.remove("hidden");
    setLoginMessage(error.message || "تعذّر التحقق من صلاحية الحساب حالياً. حاول مجدداً.");
    return false;
  }
}


const usersStatus = document.getElementById("users-status");
const usersTableBody = document.getElementById("users-table-body");
const usersSearch = document.getElementById("users-search");
const usersFilter = document.getElementById("users-filter");
let cachedUsers = [];
let usersLoaded = false;
let usersLoading = false;

function isUserActive(user) {
  return user.status === "active" && !user.deleted_at;
}

function renderUsers() {
  const term = usersSearch.value.trim().toLocaleLowerCase();
  const filter = usersFilter.value;
  const filtered = cachedUsers.filter((user) => {
    const searchable = [user.full_name, user.phone, user.region].filter(Boolean).join(" ").toLocaleLowerCase();
    if (term && !searchable.includes(term)) return false;
    if (filter === "providers" && !user.is_provider) return false;
    if (filter === "customers" && user.is_provider) return false;
    if (filter === "active" && !isUserActive(user)) return false;
    if (filter === "inactive" && isUserActive(user)) return false;
    return true;
  });

  usersTableBody.replaceChildren();
  if (filtered.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.className = "empty-users";
    cell.textContent = cachedUsers.length ? "ما في حسابات مطابقة للبحث." : "ما في مستخدمين لعرضهم.";
    row.appendChild(cell);
    usersTableBody.appendChild(row);
    return;
  }

  filtered.forEach((user) => {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    const name = document.createElement("strong");
    name.textContent = user.full_name || "اسم غير مضاف";
    nameCell.appendChild(name);

    const phoneCell = document.createElement("td");
    phoneCell.textContent = user.phone || "—";
    const regionCell = document.createElement("td");
    regionCell.textContent = user.region || "—";
    const typeCell = document.createElement("td");
    typeCell.textContent = user.is_provider ? "مقدّم خدمة" : "مستخدم";

    const statusCell = document.createElement("td");
    const status = document.createElement("span");
    status.className = "user-status " + (isUserActive(user) ? "status-active" : "status-inactive");
    status.textContent = user.deleted_at ? "محذوف" : (user.status === "active" ? "فعّال" : (user.status || "غير معروف"));
    statusCell.appendChild(status);

    const providerCell = document.createElement("td");
    if (user.provider) {
      const rating = Number(user.provider.rating_avg);
      const completed = Number(user.provider.completed_services_count);
      providerCell.textContent = (Number.isFinite(rating) ? rating.toFixed(1) : "—") +
        " / " + (Number.isFinite(completed) ? completed : 0);
    } else {
      providerCell.textContent = "—";
    }

    const createdCell = document.createElement("td");
    const createdDate = user.created_at ? new Date(user.created_at) : null;
    createdCell.textContent = createdDate && !Number.isNaN(createdDate.getTime())
      ? createdDate.toLocaleDateString("ar")
      : "—";

    const actionCell = document.createElement("td");
    const detailsButton = document.createElement("button");
    detailsButton.type = "button";
    detailsButton.className = "secondary-button user-details-button";
    detailsButton.textContent = "عرض التفاصيل";
    detailsButton.addEventListener("click", () => showUserDetails(user));
    actionCell.appendChild(detailsButton);
    const accountButton = document.createElement("button");
    accountButton.type = "button";
    accountButton.className = "secondary-button user-state-button";
    accountButton.textContent = isUserActive(user) ? "إيقاف الحساب" : "إعادة التفعيل";
    accountButton.addEventListener("click", () => updateUserStatus(user, accountButton));
    if (!user.deleted_at && user.status !== "deleted" && !user.is_admin) actionCell.appendChild(accountButton);

    [nameCell, phoneCell, regionCell, typeCell, statusCell, providerCell, createdCell, actionCell]
      .forEach((cell) => row.appendChild(cell));
    usersTableBody.appendChild(row);
  });
}

async function updateUserStatus(user, button) {
  const nextStatus = isUserActive(user) ? "suspended" : "active";
  if (!window.confirm("تأكيد تغيير حالة حساب " + (user.full_name || "المستخدم") + "؟")) return;
  button.disabled = true;
  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    const response = await fetch("/api/users", {
      method: "PATCH",
      headers: { Authorization: "Bearer " + data.session.access_token, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, status: nextStatus }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "تعذّر تغيير حالة الحساب.");
    user.status = result.status || nextStatus;
    usersStatus.classList.remove("error");
    usersStatus.textContent = result.message || "تم تحديث حالة الحساب.";
    document.getElementById("active-users-total").textContent = String(cachedUsers.filter(isUserActive).length);
    renderUsers();
  } catch (error) {
    usersStatus.textContent = error.message || "تعذّر تغيير حالة الحساب.";
    usersStatus.classList.add("error");
    button.disabled = false;
  }
}

async function loadUsers(force = true) {
  if (usersLoading) return;
  if (usersLoaded && !force) return;

  usersLoading = true;
  const refreshButton = document.getElementById("refresh-users");
  refreshButton.disabled = true;
  usersStatus.textContent = "جارٍ تحميل المستخدمين بأمان…";
  usersStatus.classList.remove("error");

  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");

    const response = await fetch("/api/users", {
      headers: { Authorization: "Bearer " + data.session.access_token },
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "تعذّر تحميل المستخدمين.");

    cachedUsers = Array.isArray(result.users) ? result.users : [];
    usersLoaded = true;
    document.getElementById("users-total").textContent = String(result.total ?? cachedUsers.length);
    document.getElementById("providers-total").textContent = String(cachedUsers.filter((user) => user.is_provider).length);
    document.getElementById("active-users-total").textContent = String(cachedUsers.filter(isUserActive).length);
    usersStatus.textContent = "تم تحميل " + cachedUsers.length + " حساب. استخدم البحث أو التصفية للوصول للحساب المطلوب.";
    renderUsers();
  } catch (error) {
    usersStatus.textContent = error.message || "تعذّر تحميل المستخدمين.";
    usersStatus.classList.add("error");
  } finally {
    usersLoading = false;
    refreshButton.disabled = false;
  }
}

const userDetailsModal = document.getElementById("user-details-modal");
const userDetailsContent = document.getElementById("user-details-content");

function showUserDetails(user) {
  const rows = [
    ["الاسم", user.full_name || "اسم غير مضاف"],
    ["رقم الهاتف", user.phone || "—"],
    ["المنطقة", user.region || "—"],
    ["نوع الحساب", user.is_provider ? "مقدّم خدمة" : "مستخدم"],
    ["حالة الحساب", user.deleted_at ? "محذوف" : (user.status || "غير معروف")],
    ["حالة التوثيق", user.verification_status || "غير محددة"],
    ["تاريخ التسجيل", user.created_at && !Number.isNaN(new Date(user.created_at).getTime()) ? new Date(user.created_at).toLocaleString("ar") : "—"],
    ["تقييم مقدّم الخدمة", user.provider && user.provider.rating_avg != null ? Number(user.provider.rating_avg).toFixed(1) : "—"],
    ["الخدمات المكتملة", user.provider && user.provider.completed_services_count != null ? String(user.provider.completed_services_count) : "—"],
    ["التوفّر لاستقبال الطلبات", user.provider ? (user.provider.is_available ? "متاح" : "غير متاح") : "ليس مقدّم خدمة"]
  ];

  userDetailsContent.replaceChildren();
  rows.forEach(([label, value]) => {
    const row = document.createElement("div");
    row.className = "user-detail-row";
    const labelElement = document.createElement("span");
    labelElement.textContent = label;
    const valueElement = document.createElement("strong");
    valueElement.textContent = value;
    row.append(labelElement, valueElement);
    userDetailsContent.appendChild(row);
  });
  userDetailsModal.classList.remove("hidden");
  userDetailsModal.setAttribute("aria-hidden", "false");
}

function closeUserDetails() {
  userDetailsModal.classList.add("hidden");
  userDetailsModal.setAttribute("aria-hidden", "true");
}

document.getElementById("close-user-details").addEventListener("click", closeUserDetails);
userDetailsModal.addEventListener("click", (event) => {
  if (event.target === userDetailsModal) closeUserDetails();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !userDetailsModal.classList.contains("hidden")) closeUserDetails();
});

usersSearch.addEventListener("input", renderUsers);
usersFilter.addEventListener("change", renderUsers);
document.getElementById("refresh-users").addEventListener("click", () => loadUsers(true));

  const settingInfoModal = document.getElementById("setting-info-modal");
const settingInfoTitle = document.getElementById("setting-info-title");
const settingInfoDescription = document.getElementById("setting-info-description");

function closeSettingInfo() {
  settingInfoModal.classList.add("hidden");
  settingInfoModal.setAttribute("aria-hidden", "true");
}

document.addEventListener("click", (event) => {
  const button = event.target.closest(".setting-info-button");
  if (button) {
    settingInfoTitle.textContent = button.dataset.infoTitle || "معلومات الإعداد";
    settingInfoDescription.textContent = button.dataset.info || "لا تتوفر تفاصيل إضافية لهذا الإعداد.";
    settingInfoModal.classList.remove("hidden");
    settingInfoModal.setAttribute("aria-hidden", "false");
    document.getElementById("close-setting-info").focus();
    return;
  }
  if (event.target === settingInfoModal || event.target.closest("#close-setting-info, #setting-info-done")) {
    closeSettingInfo();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !settingInfoModal.classList.contains("hidden")) closeSettingInfo();
});

googleLoginButton.addEventListener("click", async () => {
  if (!supabaseClient) {
    setLoginMessage("تعذّر تحميل مكتبة تسجيل الدخول. حدّث الصفحة وحاول مجدداً.");
    return;
  }

  googleLoginButton.disabled = true;
  googleLoginButton.textContent = "جارٍ التحويل إلى Google…";
  setLoginMessage("");

  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin }
  });

  if (error) {
    setLoginMessage("تعذّر بدء تسجيل الدخول عبر Google. تأكد من تفعيل Google في إعدادات Supabase Auth.");
    googleLoginButton.disabled = false;
    googleLoginButton.textContent = "المتابعة باستخدام Google";
  }
});

// الدخول عبر Google فقط (تم حذف الدخول بالبريد وكلمة المرور).
loginForm.addEventListener("submit", (event) => event.preventDefault());

document.getElementById("logout-button").addEventListener("click", async () => {
  if (supabaseClient) await supabaseClient.auth.signOut();
  dashboardShell.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  loginForm.reset();
  setLoginMessage("تم تسجيل الخروج.", false);
});

saveCommissionButton.addEventListener("click", async () => {
  const commissionMin = Number(commissionMinInput.value);
  const commissionMax = Number(commissionMaxInput.value);
  const commissionDefault = Number(commissionDefaultInput.value);
  if (![commissionMin, commissionMax, commissionDefault].every(Number.isInteger) ||
      [commissionMin, commissionMax, commissionDefault].some(value => value < 50 || value > 1000)) {
    commissionStatus.textContent = "أدخل أرقاماً صحيحة من 50 إلى 1000 لكل قيمة.";
    commissionStatus.classList.add("error");
    return;
  }
  if (commissionMin > commissionMax || commissionDefault < commissionMin || commissionDefault > commissionMax) {
    commissionStatus.textContent = "يجب أن يكون الحد الأدنى أقل من أو يساوي الحد الأعلى، والعمولة الافتراضية بينهما.";
    commissionStatus.classList.add("error");
    return;
  }

  saveCommissionButton.disabled = true;
  saveCommissionButton.textContent = "جارٍ الحفظ…";
  commissionStatus.classList.remove("error");
  commissionStatus.textContent = "جارٍ حفظ قيم العمولة الثلاث والتحقق منها…";

  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    const saved = await callSettingsApi(data.session, "POST", {
      action: "commission-settings", commissionMin, commissionMax, commissionDefault
    });
    const verified = await callSettingsApi(data.session);
    if (!saved.success || verified.commissionMin !== commissionMin ||
        verified.commissionMax !== commissionMax || verified.commissionDefault !== commissionDefault) {
      throw new Error("لم يتأكد النظام من حفظ القيم الثلاث. راجع الإعدادات قبل إعادة المحاولة.");
    }
    commissionMinInput.value = String(verified.commissionMin);
    commissionMaxInput.value = String(verified.commissionMax);
    commissionDefaultInput.value = String(verified.commissionDefault);
    commissionStatus.textContent = "تم حفظ قيم العمولة الثلاث والتحقق منها بنجاح.";
    commissionStatus.classList.remove("error");
  } catch (error) {
    commissionStatus.textContent = error.message || "تعذّر تأكيد الحفظ.";
    commissionStatus.classList.add("error");
  } finally {
    saveCommissionButton.disabled = false;
    saveCommissionButton.textContent = "حفظ قيم العمولة";
  }
});

appSettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!appSettingsForm.reportValidity()) return;
  const settings = readAppSettingsForm();
  saveAppSettingsButton.disabled = true;
  saveAppSettingsButton.textContent = "جارٍ الحفظ…";
  appSettingsStatus.textContent = "جارٍ حفظ الإعدادات والتحقق منها…";
  appSettingsStatus.classList.remove("error");
  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    const saved = await callSettingsApi(data.session, "POST", { action: "app-settings", settings });
    const verified = await callSettingsApi(data.session);
    const actual = verified.appSettings || {};
    if (!saved.success || !Object.entries(settings).every(([key, value]) => actual[key] === value)) {
      throw new Error("لم يتأكد النظام من حفظ كل الإعدادات. أعد تحميلها وتحقق من القيم.");
    }
    loadAppSettings(actual);
    appSettingsStatus.textContent = "تم حفظ إعدادات التطبيق والتحقق منها بنجاح.";
    appSettingsStatus.classList.remove("error");
  } catch (error) {
    appSettingsStatus.textContent = error.message || "تعذّر حفظ إعدادات التطبيق.";
    appSettingsStatus.classList.add("error");
  } finally {
    saveAppSettingsButton.disabled = false;
    saveAppSettingsButton.textContent = "حفظ إعدادات التطبيق";
  }
});

saveSupportButton.addEventListener("click", async () => {
  const email = supportEmailInput.value.trim();
  const phone = supportPhoneInput.value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    supportStatus.textContent = "أدخل إيميل دعم صحيحاً.";
    supportStatus.classList.add("error");
    return;
  }
  saveSupportButton.disabled = true;
  saveSupportButton.textContent = "جارٍ الحفظ…";
  supportStatus.textContent = "جارٍ حفظ معلومات الدعم والتحقق منها…";
  supportStatus.classList.remove("error");
  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    const saved = await callSettingsApi(data.session, "POST", { action: "support", supportEmail: email, supportPhone: phone });
    const verified = await callSettingsApi(data.session);
    if (!saved.success || verified.supportEmail !== email || (verified.supportPhone || "") !== phone) {
      throw new Error("لم نتمكن من تأكيد حفظ معلومات الدعم. راجع الإعدادات قبل إعادة المحاولة.");
    }
    supportEmailInput.value = verified.supportEmail;
    supportPhoneInput.value = verified.supportPhone || "";
    supportStatus.textContent = "تم حفظ معلومات الدعم والتحقق منها بنجاح.";
    supportStatus.classList.remove("error");
  } catch (error) {
    supportStatus.textContent = error.detail
      ? (error.message + " التفاصيل: " + error.detail)
      : (error.message || "تعذّر حفظ معلومات الدعم.");
    supportStatus.classList.add("error");
  } finally {
    saveSupportButton.disabled = false;
    saveSupportButton.textContent = "حفظ معلومات الدعم";
  }
});


// ===================== الدور والتحقق بخطوتين =====================
const adminState = { role: null, requireMfa: false, aal: "aal1" };

function applyAdminState(settings) {
  adminState.role = settings.adminRole || null;
  adminState.requireMfa = Boolean(settings.dashboardRequireMfa);
  adminState.aal = settings.sessionAal || "aal1";
  const readOnly = adminState.role === "support";
  [saveCommissionButton, saveAppSettingsButton, saveSupportButton, document.getElementById("save-security")]
    .forEach((button) => {
      if (!button) return;
      if (readOnly) button.disabled = true;
      button.title = readOnly ? "دور الدعم للقراءة فقط" : "";
    });
}

const mfaBox = document.getElementById("mfa-box");
const mfaEnrollBox = document.getElementById("mfa-enroll");
const mfaQr = document.getElementById("mfa-qr");
const mfaSecret = document.getElementById("mfa-secret");
const mfaHint = document.getElementById("mfa-hint");
const mfaCodeInput = document.getElementById("mfa-code");
const mfaVerifyButton = document.getElementById("mfa-verify-button");
let mfaFlow = null;

async function beginMfaEnrollment() {
  // احذف أي محاولة تسجيل سابقة لم تكتمل، وإلا قد يرفض الخادم إنشاء عامل جديد.
  const { data: factors } = await supabaseClient.auth.mfa.listFactors();
  for (const factor of factors?.all || []) {
    if (factor.factor_type === "totp" && factor.status !== "verified") {
      await supabaseClient.auth.mfa.unenroll({ factorId: factor.id });
    }
  }
  const { data, error } = await supabaseClient.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "Dashboard " + new Date().toISOString().slice(0, 10)
  });
  if (error || !data) {
    setLoginMessage("تعذّر تجهيز التحقق بخطوتين. تأكد أنه مفعّل في إعدادات Supabase Auth.");
    return false;
  }
  mfaFlow = { factorId: data.id, mode: "enroll" };
  mfaQr.src = data.totp.qr_code;
  mfaSecret.textContent = data.totp.secret;
  mfaEnrollBox.classList.remove("hidden");
  mfaHint.textContent = "امسح الرمز بتطبيق مصادقة (مثل Google Authenticator) ثم أدخل الرمز المكوّن من 6 أرقام.";
  return true;
}

async function showMfa() {
  loginScreen.classList.remove("hidden");
  dashboardShell.classList.add("hidden");
  mfaBox.classList.remove("hidden");
  mfaCodeInput.value = "";
  setLoginMessage("");
  const { data, error } = await supabaseClient.auth.mfa.listFactors();
  if (error) {
    setLoginMessage("تعذّر تحميل إعدادات التحقق بخطوتين.");
    return;
  }
  const factor = (data?.totp || []).find((item) => item.status === "verified");
  if (factor) {
    mfaFlow = { factorId: factor.id, mode: "verify" };
    mfaEnrollBox.classList.add("hidden");
    mfaHint.textContent = "أدخل الرمز الظاهر في تطبيق المصادقة.";
  } else {
    await beginMfaEnrollment();
  }
  mfaCodeInput.focus();
}

mfaVerifyButton.addEventListener("click", async () => {
  const code = mfaCodeInput.value.trim();
  if (!/^[0-9]{6}$/.test(code) || !mfaFlow) {
    setLoginMessage("أدخل رمزاً مكوّناً من 6 أرقام.");
    return;
  }
  mfaVerifyButton.disabled = true;
  try {
    const challenge = await supabaseClient.auth.mfa.challenge({ factorId: mfaFlow.factorId });
    if (challenge.error) throw challenge.error;
    const verified = await supabaseClient.auth.mfa.verify({
      factorId: mfaFlow.factorId,
      challengeId: challenge.data.id,
      code
    });
    if (verified.error) throw verified.error;
    mfaBox.classList.add("hidden");
    mfaQr.removeAttribute("src");
    mfaSecret.textContent = "";
    setLoginMessage("");
    const { data } = await supabaseClient.auth.getSession();
    if (data.session) await enterDashboard(data.session);
  } catch {
    setLoginMessage("الرمز غير صحيح أو انتهت صلاحيته. حاول مجدداً.");
  } finally {
    mfaVerifyButton.disabled = false;
  }
});

// ===================== صفحة الأمان =====================
async function loadSecurity() {
  const state = document.getElementById("security-mfa-state");
  const enrollButton = document.getElementById("security-enroll-button");
  const requireSelect = document.getElementById("security-require-mfa");
  document.getElementById("security-role").textContent = adminState.role === "support" ? "دعم (قراءة فقط)" : "مالك";
  requireSelect.value = String(adminState.requireMfa);
  const { data } = await supabaseClient.auth.mfa.listFactors();
  const verified = (data?.totp || []).some((item) => item.status === "verified");
  if (!verified) {
    state.textContent = "غير مفعّل على حسابك.";
  } else if (adminState.aal === "aal2") {
    state.textContent = "مفعّل على حسابك، والجلسة الحالية محقَّقة بخطوتين.";
  } else {
    state.textContent = "مفعّل على حسابك، لكن الجلسة الحالية لم تُحقَّق بخطوتين بعد. سجّل الخروج وادخل من جديد.";
  }
  enrollButton.classList.toggle("hidden", verified);
}

document.getElementById("security-enroll-button").addEventListener("click", () => {
  void showMfa();
});

document.getElementById("save-security").addEventListener("click", async () => {
  const status = document.getElementById("security-status");
  const requireMfa = document.getElementById("security-require-mfa").value === "true";
  status.classList.remove("error");
  status.textContent = "جارٍ الحفظ…";
  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    const result = await callSettingsApi(data.session, "POST", { action: "security", requireMfa });
    adminState.requireMfa = Boolean(result.dashboardRequireMfa);
    status.textContent = adminState.requireMfa ? "تم إلزام التحقق بخطوتين لكل دخول." : "التحقق بخطوتين غير إلزامي الآن.";
  } catch (error) {
    status.textContent = error.message || "تعذّر حفظ إعداد الأمان.";
    status.classList.add("error");
  }
});

// ===================== سجل التدقيق =====================
const AUDIT_LABELS = {
  admin_set_user_status: "تغيير حالة مستخدم",
  admin_update_settings: "تعديل إعدادات",
  admin_resolve_report: "قرار في بلاغ",
  admin_view_report_case: "عرض ملف بلاغ"
};

async function loadAudit() {
  const status = document.getElementById("audit-status");
  const body = document.getElementById("audit-table-body");
  status.classList.remove("error");
  status.textContent = "جارٍ تحميل السجل…";
  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    const response = await fetch("/api/audit", { headers: { Authorization: "Bearer " + data.session.access_token } });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "تعذّر تحميل السجل.");

    body.replaceChildren();
    for (const entry of result.entries) {
      const row = document.createElement("tr");
      const cells = [
        new Date(entry.created_at).toLocaleString("ar"),
        entry.actor_name || (entry.actor_id ? entry.actor_id.slice(0, 8) : "—"),
        AUDIT_LABELS[entry.action] || entry.action,
        entry.entity_type + (entry.entity_id ? " · " + entry.entity_id.slice(0, 8) : ""),
        entry.metadata ? JSON.stringify(entry.metadata).slice(0, 600) : ""
      ];
      cells.forEach((text, index) => {
        const cell = document.createElement("td");
        cell.textContent = text;
        if (index === 4) cell.className = "audit-details";
        row.appendChild(cell);
      });
      body.appendChild(row);
    }
    status.textContent = result.entries.length === 0 ? "لا توجد إجراءات مسجّلة بعد." : "آخر " + result.entries.length + " إجراء.";
  } catch (error) {
    status.textContent = error.message || "تعذّر تحميل السجل.";
    status.classList.add("error");
  }
}

document.getElementById("refresh-audit").addEventListener("click", () => void loadAudit());

if (!supabaseClient) {
  setLoginMessage("مكتبة تسجيل الدخول غير متاحة حالياً. تحقق من اتصال الإنترنت.");
} else {
  supabaseClient.auth.getSession().then(async ({ data, error }) => {
    if (error) {
      setLoginMessage("تعذّر استعادة جلسة الدخول. سجّل الدخول مجدداً.");
      return;
    }
    if (data.session) await enterDashboard(data.session);
  });
}
