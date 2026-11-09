// تشغيل: node --test tests/stats-info.test.mjs
// يحمي أزرار الشرح (stats-info.js) من الانفصال عن stats.js: إذا غُيّر عنوان في الإحصائيات ولم يُغيَّر هنا يفشل الاختبار.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const INFO = fs.readFileSync(new URL("../stats-info.js", import.meta.url), "utf8");
const STATS = fs.readFileSync(new URL("../stats.js", import.meta.url), "utf8");
const HTML = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const CSS = fs.readFileSync(new URL("../stats-info.css", import.meta.url), "utf8");

// مفاتيح الخريطة المسماة (سطر لكل مفتاح بإزاحة 4 مسافات داخل const NAME = { ... };)
function keysOf(name) {
  const start = INFO.indexOf("const " + name + " = {");
  assert.ok(start >= 0, "الخريطة غير موجودة: " + name);
  const end = INFO.indexOf("\n  };", start);
  return [...INFO.slice(start, end).matchAll(/^\s{4}"([^"]+)":/gm)].map((m) => m[1]);
}
const MAPS = ["KPI", "PANELS", "HEADERS", "QUALITY_ROWS", "READINESS_ROWS"];

test("كل عنوان له زر شرح ما زال موجوداً حرفياً في stats.js", () => {
  for (const name of MAPS) {
    const keys = keysOf(name);
    assert.ok(keys.length > 0, name + " فارغة");
    for (const key of keys) assert.ok(STATS.includes(key), name + ": العنوان لم يعد في stats.js → " + key);
  }
});

test("فئات نتائج الطلبات: التسمية والوصف مطابقان لما في stats.js", () => {
  const rows = [...INFO.matchAll(/\["([^"]+)", "(?:confirmed|inferred|progress)", "([^"]+)"\]/g)];
  assert.equal(rows.length, 10, "عشر فئات");
  for (const [, label, help] of rows) {
    assert.ok(STATS.includes('label: "' + label + '"'), "تسمية غير موجودة في stats.js: " + label);
    assert.ok(STATS.includes('help: "' + help + '"'), "وصف مختلف عما في stats.js للفئة: " + label);
  }
});

test("الأرقام المذكورة في الشرح تطابق ثوابت stats.js", () => {
  const num = (name) => Number(STATS.match(new RegExp("const " + name + " = (\\d+)"))[1]);
  assert.ok(INFO.includes("أقل من " + num("MIN_CELL_REQUESTS") + " طلبات"), "حد الخلية");
  assert.ok(INFO.includes(num("MIN_PREV_FOR_TREND") + " طلبات فأكثر"), "حد الاتجاه");
  assert.ok(INFO.includes(num("PRESSURE_RATIO") + " طلبات أو أكثر لكل مقدم"), "نسبة العرض المحدود");
  assert.ok(INFO.includes("أقل من " + num("MIN_CELL_REQUESTS") + " طلبات، فلا يُحكم عليها"), "العينة الصغيرة");
});

test("كل نص شرح غير فارغ وله طول معقول", () => {
  const texts = [...INFO.matchAll(/^\s{4}"[^"]+":\s*(?:\[\s*"[^"]*",\s*)?"((?:[^"\\]|\\.)+)"/gm)].map((m) => m[1]);
  assert.ok(texts.length >= 40, "عدد النصوص المستخرجة: " + texts.length);
  for (const text of texts) assert.ok(text.length >= 20, "نص قصير جداً: " + text);
});

test("الملفان مربوطان في index.html بعد stats.js، والقائمتان المغلّفتان موجودتان", () => {
  assert.ok(HTML.includes("./stats-info.css"), "رابط CSS");
  const statsAt = HTML.indexOf("./stats.js");
  const infoAt = HTML.indexOf("./stats-info.js");
  assert.ok(statsAt >= 0 && infoAt > statsAt, "stats-info.js يجب أن يُحمَّل بعد stats.js");
  for (const id of ["stats-period", "stats-stale", "stats-content"]) assert.ok(HTML.includes('id="' + id + '"'), id);
  assert.ok(INFO.includes('"stats-period"') && INFO.includes('"stats-stale"'));
});

test("المصدر متوافق مع CSP: لا innerHTML ولا style مضمّن ولا eval ولا روابط خارجية", () => {
  const code = INFO.replace(/\/\/.*$/gm, "");
  for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /\.style\b/, /setAttribute\(\s*["']style/, /https?:\/\//, /localStorage|sessionStorage/]) {
    assert.ok(!bad.test(code), String(bad));
  }
  assert.ok(!/@import|url\(/.test(CSS), "CSS بلا استيراد خارجي");
});

test("الزر يستعمل نمط ونافذة app.js المشتركين (الكلاس والسمتان)", () => {
  assert.ok(INFO.includes('"setting-info-button"'));
  assert.ok(INFO.includes('"data-info-title"') && INFO.includes('"data-info"'));
  assert.ok(fs.readFileSync(new URL("../app.js", import.meta.url), "utf8").includes('closest(".setting-info-button")'), "معالج النافذة في app.js");
});
