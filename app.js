const pages = {
  users: { title: "إدارة المستخدمين", id: "users-page" },
  settings: { title: "إعدادات التطبيق", id: "settings-page" },
  payments: { title: "إضافة رصيد", id: "payments-page" },
  commission: { title: "العمولة", id: "commission-page" },
  security: { title: "الأمان", id: "security-page" },
  audit: { title: "سجل التدقيق", id: "audit-page" }
};

const loginScreen = document.getElementById("login-screen");
const loginForm = document.getElementById("login-form");
const loginButton = document.getElementById("login-button");
const googleLoginButton = document.getElementById("google-login-button");
const loginMessage = document.getElementById("login-message");
const dashboardShell = document.getElementById("dashboard-shell");
const commissionMinInput = document.getElementById("commission-min");
const commissionMaxInput = document.getElementById("commission-max");
const commissionPercentInput = document.getElementById("commission-percent");
const commissionStatus = document.getElementById("commission-status");
const saveCommissionButton = document.getElementById("save-commission");
const supportEmailInput = document.getElementById("support-email");
const supportPhoneInput = document.getElementById("support-phone");
const supportStatus = document.getElementById("support-status");
const saveSupportButton = document.getElementById("save-support");
const appSettingsForm = document.getElementById("app-settings-form");
const paymentSettingsForm = document.getElementById("payment-settings-form");
const paymentSettingsStatus = document.getElementById("payment-settings-status");
const savePaymentSettingsButton = document.getElementById("save-payment-settings");
const shamCashAccountCodeInput = document.getElementById("sham-cash-account-code");
const shamCashQrInput = document.getElementById("sham-cash-qr-image");
const shamCashQrPreview = document.getElementById("sham-cash-qr-preview");
const shamCashNoImage = document.getElementById("sham-cash-no-image");
const shamCashRemoveQr = document.getElementById("sham-cash-remove-qr");
const manualTopupEnabledInput = document.getElementById("manual-topup-enabled");
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
    if (selected === "settings") loadPaymentSettings();
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

async function callPaymentSettingsApi(session, method = "GET", formData) {
  const response = await fetch("/api/payment-settings", {
    method,
    headers: { Authorization: "Bearer " + session.access_token },
    ...(formData ? { body: formData } : {}),
    cache: "no-store"
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "تعذّر تحميل إعدادات شام كاش.");
  return result;
}

function setPaymentPreview(url) {
  if (url) {
    shamCashQrPreview.src = url;
    shamCashQrPreview.classList.remove("hidden");
    shamCashNoImage.classList.add("hidden");
  } else {
    shamCashQrPreview.removeAttribute("src");
    shamCashQrPreview.classList.add("hidden");
    shamCashNoImage.classList.remove("hidden");
  }
}

async function loadPaymentSettings() {
  paymentSettingsStatus.classList.remove("error", "success");
  paymentSettingsStatus.textContent = "جارٍ تحميل بيانات شام كاش…";
  savePaymentSettingsButton.disabled = true;
  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    const result = await callPaymentSettingsApi(data.session);
    shamCashAccountCodeInput.value = result.accountCode || "";
    manualTopupEnabledInput.value = String(Boolean(result.enabled));
    shamCashQrInput.value = "";
    shamCashRemoveQr.checked = false;
    setPaymentPreview(result.qrUrl || "");
    paymentSettingsStatus.textContent = result.enabled
      ? "بيانات شام كاش محفوظة وتعليمات الشحن اليدوي مفعّلة."
      : "تم تحميل البيانات. تعليمات الشحن اليدوي معطّلة حالياً.";
    savePaymentSettingsButton.disabled = adminState.role !== "owner";
  } catch (error) {
    paymentSettingsStatus.textContent = error.message || "تعذّر تحميل بيانات شام كاش.";
    paymentSettingsStatus.classList.add("error");
  }
}

shamCashQrInput.addEventListener("change", () => {
  const file = shamCashQrInput.files?.[0];
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) {
    shamCashQrInput.value = "";
    paymentSettingsStatus.textContent = "حجم الصورة يجب ألا يتجاوز 3 ميغابايت.";
    paymentSettingsStatus.classList.add("error");
    return;
  }
  setPaymentPreview(URL.createObjectURL(file));
  shamCashRemoveQr.checked = false;
});

paymentSettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (adminState.role !== "owner") return;
  savePaymentSettingsButton.disabled = true;
  paymentSettingsStatus.classList.remove("error", "success");
  paymentSettingsStatus.textContent = "جارٍ حفظ بيانات شام كاش…";
  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    const formData = new FormData();
    formData.append("accountCode", shamCashAccountCodeInput.value.trim());
    formData.append("enabled", manualTopupEnabledInput.value);
    formData.append("removeQr", String(shamCashRemoveQr.checked));
    const file = shamCashQrInput.files?.[0];
    if (file) formData.append("qrImage", file);
    const result = await callPaymentSettingsApi(data.session, "POST", formData);
    setPaymentPreview(result.qrUrl || "");
    shamCashQrInput.value = "";
    shamCashRemoveQr.checked = false;
    paymentSettingsStatus.textContent = result.enabled
      ? "تم حفظ البيانات وتفعيل تعليمات الشحن اليدوي."
      : "تم حفظ بيانات شام كاش. تعليمات الشحن اليدوي معطّلة.";
    paymentSettingsStatus.classList.add("success");
  } catch (error) {
    paymentSettingsStatus.textContent = error.message || "تعذّر حفظ بيانات شام كاش.";
    paymentSettingsStatus.classList.add("error");
  } finally {
    savePaymentSettingsButton.disabled = adminState.role !== "owner";
  }
});

async function enterDashboard(session) {
  // Keep the dashboard hidden until the server confirms this account is authorized.
  loginScreen.classList.remove("hidden");
  dashboardShell.classList.add("hidden");
  commissionMinInput.disabled = true;
  commissionMaxInput.disabled = true;
  commissionPercentInput.disabled = true;
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
    commissionPercentInput.value = String(settings.commissionPercent ?? 5);
    commissionStatus.textContent = "تم تحميل إعدادات العمولة من قاعدة البيانات.";
    commissionStatus.classList.remove("error");
    supportEmailInput.value = settings.supportEmail || "shobdkhelpcenter@gmail.com";
    supportPhoneInput.value = settings.supportPhone || "";
    supportStatus.textContent = "تم تحميل معلومات التواصل المحفوظة.";
    supportStatus.classList.remove("error");
    saveSupportButton.disabled = false;
    loadAppSettings(settings.appSettings);
    commissionMinInput.disabled = false;
    commissionMaxInput.disabled = false;
    commissionPercentInput.disabled = false;
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
      commissionPercentInput.value = "";
      commissionMinInput.disabled = true;
      commissionMaxInput.disabled = true;
      commissionPercentInput.disabled = true;
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
const topupCodeSearch = document.getElementById("topup-code-search");
const topupCodeSearchButton = document.getElementById("topup-code-search-button");
const topupCodeSearchStatus = document.getElementById("topup-code-search-status");

async function searchTopupCode() {
  const code = topupCodeSearch.value.trim().toUpperCase();
  topupCodeSearchStatus.classList.remove("error", "success");
  if (!/^SHB-[A-F0-9]{10}$/.test(code)) {
    topupCodeSearchStatus.textContent = "أدخل رمزاً صحيحاً بصيغة SHB- متبوعاً بـ10 أحرف أو أرقام.";
    topupCodeSearchStatus.classList.add("error");
    return;
  }
  topupCodeSearchButton.disabled = true;
  topupCodeSearchStatus.textContent = "جارٍ البحث عن المستخدم…";
  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    const response = await fetch("/api/wallet-topup-lookup?code=" + encodeURIComponent(code), {
      headers: { Authorization: "Bearer " + data.session.access_token },
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "تعذّر البحث عن رمز الشحن.");
    const user = {
      id: result.user.id,
      full_name: result.user.name,
      phone: result.user.phone,
      topup_code: result.user.topupCode,
      status: "active",
      deleted_at: null,
      is_admin: false,
      is_provider: false,
      region: ""
    };
    topupCodeSearchStatus.textContent = "تم العثور على المستخدم. راجع البيانات أدناه قبل تأكيد الإضافة.";
    topupCodeSearchStatus.classList.add("success");
    const resultPanel = document.getElementById("topup-user-details");
    resultPanel.replaceChildren();
    const summary = document.createElement("div");
    summary.className = "wallet-admin-card";
    const title = document.createElement("h3");
    title.textContent = "بيانات المستخدم";
    const details = document.createElement("p");
    details.className = "muted";
    details.textContent = "الاسم: " + (user.full_name || "غير مضاف") + " · الهاتف: " + (user.phone || "—") + " · رمز الشحن: " + user.topup_code;
    summary.append(title, details);
    resultPanel.appendChild(summary);
    const topupCard = createWalletTopupCard(user);
    if (topupCard) resultPanel.appendChild(topupCard);
    else {
      const warning = document.createElement("p");
      warning.className = "helper error";
      warning.textContent = "إضافة الرصيد متاحة للمالك فقط وللحسابات المؤهلة.";
      resultPanel.appendChild(warning);
    }
  } catch (error) {
    topupCodeSearchStatus.textContent = error.message || "تعذّر البحث عن رمز الشحن.";
    topupCodeSearchStatus.classList.add("error");
  } finally {
    topupCodeSearchButton.disabled = false;
  }
}
topupCodeSearchButton.addEventListener("click", searchTopupCode);
topupCodeSearch.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    searchTopupCode();
  }
});
let cachedUsers = [];
let usersLoaded = false;
let usersLoading = false;
let usersPage = 1;
let usersTotal = 0;
const USERS_PAGE_SIZE = 25;
let usersSearchTimer = null;

// التقييم العام الموحّد: "جديد" إذا لا توجد تقييمات حقيقية بعد، وإلا الرقم مع العدد.
function formatUserRating(user) {
  const count = Number(user.rating_count ?? 0);
  if (count === 0) return "جديد";
  const avg = Number(user.rating_avg);
  return (Number.isFinite(avg) ? avg.toFixed(1) : "—") + " (" + count + ")";
}

function isUserActive(user) {
  return user.status === "active" && !user.deleted_at;
}

function renderUsers() {
  const filtered = cachedUsers;
  usersTableBody.replaceChildren();
  if (filtered.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.className = "empty-users";
    cell.textContent = (usersSearch.value.trim() || usersFilter.value !== "all") ? "ما في حسابات مطابقة للبحث." : "ما في مستخدمين لعرضهم.";
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
    const completed = user.provider ? Number(user.provider.completed_services_count) : null;
    providerCell.textContent = formatUserRating(user) +
      (user.is_provider && completed !== null ? " / " + (Number.isFinite(completed) ? completed : 0) : "");

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
    if (!user.deleted_at && user.status !== "deleted" && !user.is_admin) {
      actionCell.appendChild(accountButton);
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "secondary-button user-delete-button";
      deleteButton.textContent = "حذف الحساب";
      deleteButton.addEventListener("click", () => deleteUserAccount(user, deleteButton));
      actionCell.appendChild(deleteButton);

      const deleteInfoButton = document.createElement("button");
      deleteInfoButton.type = "button";
      deleteInfoButton.className = "user-delete-info-button";
      deleteInfoButton.textContent = "i";
      deleteInfoButton.title = "هذا الإجراء لا يحذف الحساب نهائياً من قاعدة البيانات: يعطّل تسجيل الدخول، ويخفي البيانات الشخصية، ويحتفظ بسجلات التوثيق والمعاملات والتقييمات والمحادثات اللازمة. لا يمكن التراجع عنه من لوحة التحكم.";
      deleteInfoButton.setAttribute("aria-label", deleteInfoButton.title);
      deleteInfoButton.addEventListener("click", () => {
        usersStatus.classList.remove("error");
        usersStatus.textContent = deleteInfoButton.title;
      });
      actionCell.appendChild(deleteInfoButton);
    }

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
    await loadUsers(true);
    usersStatus.classList.remove("error");
    usersStatus.textContent = result.message || "تم تحديث حالة الحساب.";
  } catch (error) {
    usersStatus.textContent = error.message || "تعذّر تغيير حالة الحساب.";
    usersStatus.classList.add("error");
    button.disabled = false;
  }
}

async function deleteUserAccount(user, button) {
  const name = user.full_name || "المستخدم";
  const confirmed = window.confirm(
    "هل تريد حذف حساب " + name + "؟\n\n" +
    "سيتم تعطيل تسجيل الدخول وإخفاء البيانات الشخصية. ستبقى سجلات التوثيق والمعاملات والتقييمات اللازمة للسلامة والمحاسبة. لا يمكن التراجع عن هذا الإجراء."
  );
  if (!confirmed) return;

  button.disabled = true;
  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");

    const response = await fetch("/api/users", {
      method: "DELETE",
      headers: {
        Authorization: "Bearer " + data.session.access_token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ userId: user.id }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "تعذّر حذف الحساب.");

    await loadUsers(true);
    usersStatus.classList.remove("error");
    usersStatus.textContent = result.message || "تم حذف الحساب.";
  } catch (error) {
    usersStatus.textContent = error.message || "تعذّر حذف الحساب.";
    usersStatus.classList.add("error");
    button.disabled = false;
  }
}

async function loadUsers(force = true, page = usersPage) {
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

    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(USERS_PAGE_SIZE),
      filter: usersFilter.value,
      q: usersSearch.value.trim()
    });
    const response = await fetch("/api/users?" + params.toString(), {
      headers: { Authorization: "Bearer " + data.session.access_token },
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "تعذّر تحميل المستخدمين.");

    cachedUsers = Array.isArray(result.users) ? result.users : [];
    usersLoaded = true;
    usersPage = result.page || page;
    usersTotal = Number(result.total ?? cachedUsers.length);
    const summary = result.summary || {};
    document.getElementById("users-total").textContent = summary.total != null ? String(summary.total) : "—";
    document.getElementById("providers-total").textContent = summary.providers != null ? String(summary.providers) : "—";
    document.getElementById("active-users-total").textContent = summary.active != null ? String(summary.active) : "—";

    const pages = Math.max(1, Math.ceil(usersTotal / USERS_PAGE_SIZE));
    document.getElementById("users-page-info").textContent = "الصفحة " + usersPage + " من " + pages + " · " + usersTotal + " نتيجة";
    document.getElementById("users-prev").disabled = usersPage <= 1;
    document.getElementById("users-next").disabled = usersPage >= pages;
    usersStatus.textContent = usersTotal === 0 ? "لا توجد نتائج." : "تم تحميل " + cachedUsers.length + " حساب.";
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

function createWalletTopupCard(user) {
  if (adminState.role !== "owner" || !isUserActive(user) || user.is_admin) return null;

  const card = document.createElement("section");
  card.className = "wallet-admin-card";
  const heading = document.createElement("h3");
  heading.textContent = "إضافة رصيد يدوية";
  const balance = document.createElement("p");
  balance.className = "wallet-admin-balance";
  balance.textContent = "جارٍ تحميل الرصيد الحالي…";
  const form = document.createElement("form");
  form.className = "wallet-admin-form";

  const amountLabel = document.createElement("label");
  amountLabel.textContent = "المبلغ (ليرة سورية)";
  const amountInput = document.createElement("input");
  amountInput.type = "number";
  amountInput.min = "1";
  amountInput.max = "100000";
  amountInput.step = "1";
  amountInput.required = true;
  amountInput.inputMode = "numeric";
  amountLabel.appendChild(amountInput);

  const transactionLabel = document.createElement("label");
  transactionLabel.className = "wallet-admin-reason";
  transactionLabel.textContent = "رقم عملية شام كاش";
  const transactionInput = document.createElement("input");
  transactionInput.type = "text";
  transactionInput.minLength = 4;
  transactionInput.maxLength = 100;
  transactionInput.required = true;
  transactionInput.autocomplete = "off";
  transactionInput.placeholder = "أدخل رقم العملية كما يظهر في الإيصال";
  transactionLabel.appendChild(transactionInput);

  const reasonLabel = document.createElement("label");
  reasonLabel.className = "wallet-admin-reason";
  reasonLabel.textContent = "سبب الإضافة";
  const reasonInput = document.createElement("input");
  reasonInput.type = "text";
  reasonInput.minLength = 5;
  reasonInput.maxLength = 300;
  reasonInput.required = true;
  reasonInput.value = "تأكيد تحويل شام كاش";
  reasonLabel.appendChild(reasonInput);

  const thankYouLabel = document.createElement("label");
  thankYouLabel.className = "wallet-admin-reason";
  thankYouLabel.textContent = "رسالة الشكر التي ستصل للمستخدم";
  const thankYouInput = document.createElement("textarea");
  thankYouInput.maxLength = 300;
  thankYouInput.rows = 3;
  thankYouInput.value = "شكراً لاستخدامك شو بدك. تم إضافة رصيدك بنجاح.";
  thankYouLabel.appendChild(thankYouInput);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary-button";
  submit.textContent = "تأكيد إضافة الرصيد";
  const status = document.createElement("p");
  status.className = "wallet-admin-status helper";
  status.setAttribute("role", "status");
  form.append(amountLabel, transactionLabel, reasonLabel, thankYouLabel, submit);
  card.append(heading, balance, form, status);

  let requestId = crypto.randomUUID();
  (async () => {
    try {
      const { data, error } = await supabaseClient.auth.getSession();
      if (error || !data.session) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
      const response = await fetch("/api/wallet-topup?userId=" + encodeURIComponent(user.id), {
        headers: { Authorization: "Bearer " + data.session.access_token },
        cache: "no-store"
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "تعذّر تحميل رصيد المستخدم.");
      balance.textContent = "الرصيد الحالي: " + Number(result.balance).toLocaleString("ar") + " ل.س";
    } catch (error) {
      balance.textContent = error.message || "تعذّر تحميل الرصيد الحالي.";
      balance.classList.add("error");
    }
  })();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const amount = Number(amountInput.value);
    const reason = reasonInput.value.trim();
    const shamCashTransactionId = transactionInput.value.trim();
    const thankYouMessage = thankYouInput.value.trim();
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000 || reason.length < 5 || reason.length > 300 || !/^[A-Za-z0-9-]{4,100}$/.test(shamCashTransactionId) || thankYouMessage.length > 300) {
      status.textContent = "تحقق من المبلغ ورقم عملية شام كاش وسبب الإضافة قبل المتابعة.";
      status.classList.add("error");
      return;
    }
    if (!window.confirm("تأكيد إضافة " + amount.toLocaleString("ar") + " ل.س إلى رصيد " + (user.full_name || "هذا المستخدم") + "؟")) return;
    submit.disabled = true;
    status.classList.remove("error", "success");
    status.textContent = "جارٍ تنفيذ الإضافة وتسجيلها…";
    try {
      const { data, error } = await supabaseClient.auth.getSession();
      if (error || !data.session) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
      const response = await fetch("/api/wallet-topup", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + data.session.access_token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ userId: user.id, amount, reason, requestId, shamCashTransactionId, thankYouMessage }),
        cache: "no-store"
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "تعذّرت إضافة الرصيد.");
      balance.textContent = "الرصيد الحالي: " + Number(result.balance_after).toLocaleString("ar") + " ل.س";
      status.textContent = result.already_processed
        ? "هذه العملية مسجّلة مسبقاً؛ لم يُضف الرصيد مرة ثانية."
        : "تمت إضافة " + amount.toLocaleString("ar") + " ل.س وتسجيل العملية وإرسال إشعار للمستخدم.";
      status.classList.add("success");
      amountInput.value = "";
      transactionInput.value = "";
      reasonInput.value = "تأكيد تحويل شام كاش";
      requestId = crypto.randomUUID();
    } catch (error) {
      status.textContent = error.message || "تعذّرت إضافة الرصيد. يمكنك إعادة المحاولة بأمان.";
      status.classList.add("error");
    } finally {
      submit.disabled = false;
    }
  });

  return card;
}

function showUserDetails(user) {
  const rows = [
    ["الاسم", user.full_name || "اسم غير مضاف"],
    ["رقم الهاتف", user.phone || "—"],
    ["رمز الشحن", user.topup_code || "—"],
    ["المنطقة", user.region || "—"],
    ["نوع الحساب", user.is_provider ? "مقدّم خدمة" : "مستخدم"],
    ["حالة الحساب", user.deleted_at ? "محذوف" : (user.status || "غير معروف")],
    ["حالة التوثيق", user.verification_status || "غير محددة"],
    ["تاريخ التسجيل", user.created_at && !Number.isNaN(new Date(user.created_at).getTime()) ? new Date(user.created_at).toLocaleString("ar") : "—"],
    ["التقييم العام (زبون ومقدّم خدمة)", formatUserRating(user)],
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

usersSearch.addEventListener("input", () => {
  clearTimeout(usersSearchTimer);
  usersSearchTimer = setTimeout(() => loadUsers(true, 1), 350);
});
usersFilter.addEventListener("change", () => loadUsers(true, 1));
document.getElementById("refresh-users").addEventListener("click", () => loadUsers(true, usersPage));
document.getElementById("users-prev").addEventListener("click", () => loadUsers(true, Math.max(1, usersPage - 1)));
document.getElementById("users-next").addEventListener("click", () => loadUsers(true, usersPage + 1));

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
    // بالـ / النهائية حتى يطابق قائمة السماح في Supabase (https://*.sho-bdk-dashboard.pages.dev/**)
    options: { redirectTo: window.location.origin + "/" }
  });

  if (error) {
    setLoginMessage("تعذّر بدء تسجيل الدخول عبر Google. تأكد من تفعيل Google في إعدادات Supabase Auth.");
    googleLoginButton.disabled = false;
    googleLoginButton.textContent = "المتابعة باستخدام Google";
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!supabaseClient) {
    setLoginMessage("تعذّر تحميل مكتبة تسجيل الدخول. حدّث الصفحة وحاول مجدداً.");
    return;
  }

  loginButton.disabled = true;
  loginButton.textContent = "جارٍ التحقق…";
  setLoginMessage("");

  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

  if (error || !data.session) {
    setLoginMessage("تعذّر تسجيل الدخول. تأكد من البريد الإلكتروني وكلمة المرور.");
  } else {
    await enterDashboard(data.session);
  }

  loginButton.disabled = false;
  loginButton.textContent = "دخول آمن";
});

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
  const commissionPercent = Number(commissionPercentInput.value);
  if (![commissionMin, commissionMax].every(Number.isInteger) ||
      [commissionMin, commissionMax].some((value) => value < 50 || value > 1000)) {
    commissionStatus.textContent = "الحدّان أعداد صحيحة من 50 إلى 1000.";
    commissionStatus.classList.add("error");
    return;
  }
  if (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 50 ||
      Math.round(commissionPercent * 100) !== commissionPercent * 100) {
    commissionStatus.textContent = "النسبة بين 0 و50 (بخانتين عشريتين كحد أقصى).";
    commissionStatus.classList.add("error");
    return;
  }
  if (commissionMin > commissionMax) {
    commissionStatus.textContent = "يجب أن يكون الحد الأدنى أقل من أو يساوي الحد الأعلى.";
    commissionStatus.classList.add("error");
    return;
  }

  saveCommissionButton.disabled = true;
  saveCommissionButton.textContent = "جارٍ الحفظ…";
  commissionStatus.classList.remove("error");
  commissionStatus.textContent = "جارٍ حفظ إعدادات العمولة والتحقق منها…";

  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    const saved = await callSettingsApi(data.session, "POST", {
      action: "commission-settings", commissionMin, commissionMax, commissionPercent
    });
    const verified = await callSettingsApi(data.session);
    if (!saved.success || verified.commissionMin !== commissionMin ||
        verified.commissionMax !== commissionMax || verified.commissionPercent !== commissionPercent) {
      throw new Error("لم يتأكد النظام من حفظ القيم. راجع الإعدادات قبل إعادة المحاولة.");
    }
    commissionMinInput.value = String(verified.commissionMin);
    commissionMaxInput.value = String(verified.commissionMax);
    commissionPercentInput.value = String(verified.commissionPercent);
    commissionStatus.textContent = "تم حفظ إعدادات العمولة والتحقق منها بنجاح.";
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
  [saveCommissionButton, saveAppSettingsButton, saveSupportButton, savePaymentSettingsButton, document.getElementById("save-security")]
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
  admin_view_report_case: "عرض ملف بلاغ",
  admin_decide_verification: "قرار في طلب توثيق",
  admin_topup_wallet: "إضافة رصيد لمستخدم",
  admin_view_verification_file: "عرض صورة توثيق"
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
