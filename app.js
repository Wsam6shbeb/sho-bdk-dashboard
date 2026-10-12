const pages = {
  overview: { title: "نظرة عامة", id: "overview-page" },
  settings: { title: "إعدادات التطبيق", id: "settings-page" },
  commission: { title: "العمولة", id: "commission-page" }
};

const loginScreen = document.getElementById("login-screen");
const loginForm = document.getElementById("login-form");
const loginButton = document.getElementById("login-button");
const loginMessage = document.getElementById("login-message");
const dashboardShell = document.getElementById("dashboard-shell");
const commissionInput = document.getElementById("commission");
const commissionStatus = document.getElementById("commission-status");
const saveCommissionButton = document.getElementById("save-commission");
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
  });
});

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
  try {
    const settings = await callSettingsApi(session);
    loginScreen.classList.add("hidden");
    dashboardShell.classList.remove("hidden");
    document.getElementById("admin-email").textContent = session.user.email;
    commissionInput.value = String(settings.commission);
    commissionStatus.textContent = settings.isFlat
      ? "تم تحميل العمولة المحفوظة من قاعدة البيانات."
      : "تنبيه: القيم الحالية ليست عمولة ثابتة. اضغط حفظ فقط إذا كنت تريد توحيدها على الرقم الظاهر.";
    commissionStatus.classList.toggle("error", !settings.isFlat);
    commissionInput.disabled = false;
    saveCommissionButton.disabled = false;
    return true;
  } catch (error) {
    await supabaseClient.auth.signOut();
    dashboardShell.classList.add("hidden");
    loginScreen.classList.remove("hidden");
    setLoginMessage(error.message || "تعذّر التحقق من صلاحية المدير.");
    return false;
  }
}

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
