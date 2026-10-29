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
      <p class="delete-warning-final">لا تتابع إلا إذا راجعت الحساب وتأكدت أنك تريد تعطيله وإخفاء بياناته الشخصية.</p>
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
  const modal = ensureDeleteWarningModal();
  const description = modal.querySelector("#delete-warning-description");
  const confirmButton = modal.querySelector("#delete-warning-confirm");
  const cancelButton = modal.querySelector("#delete-warning-cancel");

  description.textContent = DELETE_ACCOUNT_EXPLANATION;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");

  // Clicking the table's delete button only opens this warning; deletion happens
  // only after the administrator explicitly confirms inside the warning dialog.
  confirmButton.onclick = async () => {
    modal._closeWarning();
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
        body: JSON.stringify({ userId: user.id }),
        cache: "no-store"
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "تعذّر تنفيذ إجراء الحساب.");

      await loadUsers(true);
      usersStatus.classList.remove("error");
      usersStatus.textContent = result.message || "تم تنفيذ إجراء الحساب.";
    } catch (error) {
      usersStatus.textContent = error.message || "تعذّر تنفيذ إجراء الحساب.";
      usersStatus.classList.add("error");
      button.disabled = false;
    } finally {
      confirmButton.disabled = false;
    }
  };

  cancelButton.focus();
}
