const pages = {
  overview: { title: "نظرة عامة", id: "overview-page" },
  users: { title: "إدارة المستخدمين", id: "users-page" },
  settings: { title: "إعدادات التطبيق", id: "settings-page" },
  support: { title: "طريقة الدعم", id: "support-page" },
  commission: { title: "العمولة", id: "commission-page" }
};

const loginScreen = document.getElementById("login-screen");
const loginForm = document.getElementById("login-form");
const loginButton = document.getElementById("login-button");
const googleLoginButton = document.getElementById("google-login-button");
const loginMessage = document.getElementById("login-message");
const dashboardShell = document.getElementById("dashboard-shell");
const commissionInput = document.getElementById("commission");
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

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    const selected = button.dataset.page;
    if (!pages[selected]) return;
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item === button));
    Object.values(pages).forEach((page) => document.getElementById(page.id).classList.add("hidden"));
    document.getElementById(pages[selected].id).classList.remove("hidden");
    document.getElementById("page-title").textContent = pages[selected].title;
    if (selected === "users") loadUsers();
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
    throw error;
  }
  return result;
}

async function enterDashboard(session) {
  // Keep the dashboard hidden until the server confirms this account is authorized.
  loginScreen.classList.remove("hidden");
  dashboardShell.classList.add("hidden");
  commissionInput.disabled = true;
  saveCommissionButton.disabled = true;
  saveAppSettingsButton.disabled = true;
  setLoginMessage("جارٍ التحقق من صلاحية الحساب...", false);

  try {
    const settings = await callSettingsApi(session);
    // Only reveal the dashboard after the server-side authorization check succeeds.
    loginScreen.classList.add("hidden");
    dashboardShell.classList.remove("hidden");
    document.getElementById("admin-email").textContent = session.user.email;
    commissionInput.value = String(settings.commission);
    commissionStatus.textContent = settings.isFlat
      ? "تم تحميل العمولة المحفوظة من قاعدة البيانات."
      : "تنبيه: القيم الحالية ليست عمولة ثابتة. اضغط حفظ فقط إذا كنت تريد توحيدها على الرقم الظاهر.";
    commissionStatus.classList.toggle("error", !settings.isFlat);
    supportEmailInput.value = settings.supportEmail || "shobdkhelpcenter@gmail.com";
    supportPhoneInput.value = settings.supportPhone || "";
    supportStatus.textContent = "تم تحميل معلومات التواصل المحفوظة.";
    supportStatus.classList.remove("error");
    saveSupportButton.disabled = false;
    loadAppSettings(settings.appSettings);
    commissionInput.disabled = false;
    saveCommissionButton.disabled = false;
    return true;
  } catch (error) {
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
      commissionInput.value = "";
      commissionInput.disabled = true;
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
  const amount = Number(commissionInput.value);
  if (!Number.isInteger(amount) || amount < 50 || amount > 1000) {
    commissionStatus.textContent = "أدخل رقماً صحيحاً بين 50 و1000.";
    commissionStatus.classList.add("error");
    return;
  }

  saveCommissionButton.disabled = true;
  saveCommissionButton.textContent = "جارٍ الحفظ…";
  commissionStatus.classList.remove("error");
  commissionStatus.textContent = "جارٍ حفظ الإعداد والتحقق منه…";

  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");

    const saved = await callSettingsApi(data.session, "POST", { commission: amount });
    const verified = await callSettingsApi(data.session);
    if (!saved.success || verified.commission !== amount || !verified.isFlat) {
      throw new Error("لم ينجح التحقق من القيمة بعد الحفظ. راجع الإعدادات قبل إعادة المحاولة.");
    }

    commissionInput.value = String(verified.commission);
    commissionStatus.textContent = "تم حفظ العمولة " + verified.commission + " والتحقق منها بنجاح. تنطبق على الاتفاقات الجديدة.";
    commissionStatus.classList.remove("error");
  } catch (error) {
    commissionStatus.textContent = error.message || "تعذّر تأكيد الحفظ.";
    commissionStatus.classList.add("error");
  } finally {
    saveCommissionButton.disabled = false;
    saveCommissionButton.textContent = "حفظ العمولة";
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
    supportStatus.textContent = error.message || "تعذّر حفظ معلومات الدعم.";
    supportStatus.classList.add("error");
  } finally {
    saveSupportButton.disabled = false;
    saveSupportButton.textContent = "حفظ معلومات الدعم";
  }
});

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
