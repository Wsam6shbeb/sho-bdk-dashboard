const pages = {
  overview: { title: "نظرة عامة", id: "overview-page" },
  settings: { title: "إعدادات التطبيق", id: "settings-page" },
  commission: { title: "العمولة", id: "commission-page" }
};

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    const selected = button.dataset.page;
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item === button));
    Object.values(pages).forEach((page) => document.getElementById(page.id).classList.add("hidden"));
    document.getElementById(pages[selected].id).classList.remove("hidden");
    document.getElementById("page-title").textContent = pages[selected].title;
  });
});

document.getElementById("year").textContent = new Date().getFullYear();
