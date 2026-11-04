// Account deletion warning: require an explicit second confirmation before sending DELETE.
const DELETE_ACCOUNT_EXPLANATION =
  "هذا الإجراء لا يمحو بيانات الحساب من قاعدة البيانات. يتم تعطيل الحساب وإخفاء بياناته الشخصية، ولا يعود صاحبه قادراً على الوصول إلى الحساب القديم. تبقى البيانات المرتبطة به، مثل الطلبات والمحادثات والتقييمات والمعاملات المالية وسجلات التوثيق، محفوظة. قد يستطيع صاحب البريد الإلكتروني التسجيل من جديد، لكن التسجيل الجديد لا يعني استعادة الحساب القديم أو بياناته.";

function ensureDeleteWarningModal() {
  let modal = document.getElementById("delete-account-warning-modal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "delete-account-warning-modal";
  modal.className = "delete-warning-overlay hidden";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "delete-warning-title");
  modal.innerHTML = `
    <section class="delete-warning-card">
      <div class="delete-warning-heading">
        <span class="delete-warning-symbol" aria-hidden="true">!</span>
        <h2 id="delete-warning-title">تحذير: إجراء حذف الحساب</h2>
      </div>
      <p class="delete-warning-intro">انتبه: هذا الإجراء لا يحذف البيانات نهائياً، لكنه يعطّل الحساب ويخفي بياناته الشخصية.</p>
      <p id="delete-warning-description" class="delete-warning-description"></p>
      <p id="delete-warning-account-email" class="delete-warning-final"></p>
      <label id="delete-warning-email-label" class="delete-warning-email-label" for="delete-warning-email">أعد كتابة البريد الإلكتروني أو رقم الهاتف نفسه للتأكيد</label>
      <input id="delete-warning-email" type="email" autocomplete="off" maxlength="254" required placeholder="البريد الإلكتروني المسجّل">
      <p class="delete-warning-final">لن يتم الحذف إذا لم يكن البريد مطابقاً تماماً للحساب المحدد.</p>
      <div class="delete-warning-actions">
        <button id="delete-warning-cancel" class="secondary-button" type="button">إلغاء</button>
        <button id="delete-warning-confirm" class="delete-warning-confirm" type="button">نعم، أتابع حذف الحساب</button>
      </div>
    </section>`;
  document.body.appendChild(modal);

  const close = () => {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  };
  modal.querySelector("#delete-warning-cancel").addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.classList.contains("hidden")) close();
  });
  modal._closeWarning = close;
  return modal;
}

async function deleteUserAccount(user, button) {
  const status = document.getElementById("users-status");
  const identifierType = user.email ? "email" : user.matchedPhone ? "phone" : null;
  const expectedIdentifier = identifierType === "email" ? user.email : user.matchedPhone;
  if (!identifierType || !expectedIdentifier) {
    status.classList.add("error");
    status.textContent = "للحذف الآمن، ابحث عن الحساب بالبريد الإلكتروني الكامل أو رقم الهاتف الكامل المسجّل، ثم اختر النتيجة المطابقة.";
    return;
  }

  const modal = ensureDeleteWarningModal();
  const description = modal.querySelector("#delete-warning-description");
  const accountEmail = modal.querySelector("#delete-warning-account-email");
  const emailInput = modal.querySelector("#delete-warning-email");
  const confirmButton = modal.querySelector("#delete-warning-confirm");
  const cancelButton = modal.querySelector("#delete-warning-cancel");

  description.textContent = DELETE_ACCOUNT_EXPLANATION;
  const isPhone = identifierType === "phone";
  accountEmail.textContent = (isPhone ? "رقم الهاتف المسجّل لهذا الحساب: " : "البريد المسجّل لهذا الحساب: ") + expectedIdentifier;
  modal.querySelector("#delete-warning-email-label").textContent = isPhone ? "أعد كتابة رقم الهاتف نفسه للتأكيد" : "أعد كتابة البريد الإلكتروني نفسه للتأكيد";
  emailInput.type = isPhone ? "tel" : "email";
  emailInput.inputMode = isPhone ? "tel" : "email";
  emailInput.placeholder = isPhone ? "رقم الهاتف المسجّل" : "البريد الإلكتروني المسجّل";
  emailInput.value = "";
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");

  confirmButton.onclick = async () => {
    const typedIdentifier = isPhone ? emailInput.value.trim() : emailInput.value.trim().toLowerCase();
    const matches = isPhone
      ? normalizePhoneForConfirmation(typedIdentifier) === normalizePhoneForConfirmation(expectedIdentifier)
      : typedIdentifier === expectedIdentifier.trim().toLowerCase();
    if (!matches) {
      status.classList.add("error");
      status.textContent = (isPhone ? "رقم الهاتف" : "البريد الإلكتروني") + " الذي كتبته لا يطابق بيانات الحساب. لم يتم حذف أي شيء.";
      emailInput.focus();
      return;
    }

    confirmButton.disabled = true;
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
        body: JSON.stringify({ userId: user.id, [identifierType]: typedIdentifier }),
        cache: "no-store"
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "تعذّر تنفيذ إجراء الحساب.");

      modal._closeWarning();
      await loadUsers(true);
      status.classList.remove("error");
      status.textContent = result.message || "تم تنفيذ إجراء الحساب.";
    } catch (error) {
      status.textContent = error.message || "تعذّر تنفيذ إجراء الحساب.";
      status.classList.add("error");
      button.disabled = false;
    } finally {
      confirmButton.disabled = false;
    }
  };

  cancelButton.focus();
}


function normalizePhoneForConfirmation(value) { let digits = String(value || "").replace(/\D/g, ""); if (digits.startsWith("00963")) digits = digits.slice(5); else if (digits.startsWith("963")) digits = digits.slice(3); else if (digits.startsWith("0")) digits = digits.slice(1); return digits; }

// Show an exact email or phone search result identifier.
const originalRenderUsersForEmail = renderUsers;
renderUsers = function () {
  originalRenderUsersForEmail();
  cachedUsers.forEach((user, index) => {
    const identifier = user.email || user.matchedPhone;
    if (!identifier) return;
    const nameCell = usersTableBody.children[index]?.children[0];
    if (!nameCell || nameCell.querySelector(".user-email-search-result")) return;
    const email = document.createElement("small");
    email.className = "user-email-search-result";
    email.textContent = (user.email ? "البريد: " : "الهاتف: ") + identifier;
    email.style.display = "block";
    email.style.direction = "ltr";
    email.style.textAlign = "left";
    email.style.fontSize = "12px";
    email.style.opacity = "0.8";
    nameCell.appendChild(email);
  });
};
const usersSearchInput = document.getElementById("users-search");
if (usersSearchInput) usersSearchInput.placeholder = "ابحث بالاسم أو المنطقة، أو بالبريد/رقم الهاتف الكامل للحذف";

// Keep the information tooltip clear and consistent whenever the users table rerenders.
function refreshDeleteAccountInfoText() {
  document.querySelectorAll(".user-delete-info-button").forEach((infoButton) => {
    infoButton.title = DELETE_ACCOUNT_EXPLANATION;
    infoButton.setAttribute("aria-label", DELETE_ACCOUNT_EXPLANATION);
    infoButton.onclick = () => {
      const status = document.getElementById("users-status");
      if (!status) return;
      status.classList.remove("error");
      status.textContent = DELETE_ACCOUNT_EXPLANATION;
    };
  });
}
const deleteInfoObserver = new MutationObserver(refreshDeleteAccountInfoText);
const usersTableForDeleteInfo = document.getElementById("users-table-body");
if (usersTableForDeleteInfo) {
  deleteInfoObserver.observe(usersTableForDeleteInfo, { childList: true, subtree: true });
  refreshDeleteAccountInfoText();
}
