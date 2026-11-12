// فحص ثابت لملف migration «إحصائيات الخدمات» (ليس تنفيذاً): الجداول والأعمدة وصلاحيات الدوال وسلامة البنية.
// التنفيذ الفعلي جُرّب على قاعدة الإنتاج داخل transaction تُلغى تلقائياً قبل التطبيق.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const SQL = fs.readFileSync(new URL("../database/20261109000000_admin_services_stats.sql", import.meta.url), "utf8");
const SCHEMA = JSON.parse(fs.readFileSync(new URL("./fixtures/schema-snapshot.json", import.meta.url), "utf8"));
const code = SQL.replace(/--.*$/gm, "");

const FUNCTIONS = ["admin_stats_norm_text(text)", "admin_stats_area_key(text)", "admin_stats_service_group(text)", "admin_services_stats(integer, text, text)"];

test("لا يحوي أي أمر كتابة أو DDL على الجداول: فقط 4 دوال + revoke/grant", () => {
  assert.ok(!/\b(insert\s+into|update\s+public\.|delete\s+from|drop\s+|alter\s+|truncate|create\s+table|create\s+index|create\s+policy|create\s+trigger)\b/i.test(code));
  const statements = (code.match(/\b(create\s+or\s+replace\s+function|revoke|grant)\b/gi) || []).map((s) => s.toLowerCase().replace(/\s+/g, " "));
  assert.deepEqual(statements, [
    "create or replace function", "create or replace function", "create or replace function", "create or replace function",
    "revoke", "revoke", "revoke", "revoke", "grant"
  ]);
});

test("كل الدوال مسحوبة من public/anon/authenticated، والدالة الرئيسية فقط معطاة لـ service_role", () => {
  for (const fn of FUNCTIONS) {
    const re = new RegExp("revoke all on function public\\." + fn.replace(/[()]/g, "\\$&") + " from public, anon, authenticated;", "i");
    assert.match(code, re, fn);
  }
  assert.match(code, /grant execute on function public\.admin_services_stats\(integer, text, text\) to service_role;/i);
  assert.ok(!/grant[^;]*\bto\b[^;]*(anon|authenticated|public)/i.test(code));
  assert.equal((code.match(/\bgrant\b/gi) || []).length, 1);
});

test("الدالة الرئيسية SECURITY DEFINER بـ search_path ثابت، والمساعدات IMMUTABLE بلا SECURITY DEFINER", () => {
  const main = code.slice(code.indexOf("create or replace function public.admin_services_stats"));
  assert.match(main, /security definer/i);
  assert.match(main, /set search_path = public, pg_temp/i);
  const helpers = code.slice(0, code.indexOf("create or replace function public.admin_services_stats"));
  assert.ok(!/security definer/i.test(helpers));
  assert.equal((helpers.match(/\bimmutable\b/gi) || []).length, 3);
  assert.equal((helpers.match(/set search_path = pg_catalog, public/gi) || []).length, 3);
});

test("كل الجداول المذكورة بـ public.<name> موجودة في المخطط", () => {
  const names = new Set([...code.matchAll(/public\.([a-z_]+)/g)].map((m) => m[1]));
  for (const fn of ["admin_stats_norm_text", "admin_stats_area_key", "admin_stats_service_group", "admin_services_stats"]) names.delete(fn);
  for (const name of names) assert.ok(SCHEMA.tables[name], "جدول غير موجود في المخطط: " + name);
  for (const t of ["service_requests", "provider_services", "users", "provider_profiles", "wallets", "app_settings"]) assert.ok(names.has(t), t);
});

test("كل alias.column على جدول حقيقي يشير إلى عمود موجود", () => {
  const bound = new Map();
  for (const m of code.matchAll(/\b(?:from|join)\s+public\.([a-z_]+)\s+([a-z_][a-z0-9_]*)/gi)) {
    if (["on", "where", "left", "right", "inner", "join", "group", "order", "using", "limit"].includes(m[2].toLowerCase())) continue;
    if (!bound.has(m[2])) bound.set(m[2], new Set());
    bound.get(m[2]).add(m[1]);
  }
  assert.deepEqual([...bound.keys()].sort(), ["pp", "ps", "sr", "u", "w"]);
  let checked = 0;
  for (const [alias, tables] of bound) {
    for (const m of code.matchAll(new RegExp("\\b" + alias + "\\.([a-z_]+)\\b", "g"))) {
      const col = m[1];
      assert.ok([...tables].some((t) => SCHEMA.tables[t].includes(col)), `العمود ${alias}.${col} غير موجود في (${[...tables].join(", ")})`);
      checked++;
    }
  }
  assert.ok(checked >= 20, "مراجع مفحوصة: " + checked);
});

test("قيم الحالات المستعملة موجودة فعلاً", () => {
  for (const v of ["completed", "active", "completion_pending_rating"]) assert.ok(SCHEMA.enums.request_state.includes(v), v);
  assert.ok(code.includes("('completed', 'active', 'completion_pending_rating')"));
});

test("قائمة المحافظات: 13 معتمدة + «اونلاين»، ومفتاح المجموعات الحرة يبدأ بـ ~", () => {
  const list = [...code.match(/v_regions constant text\[\] := array\[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(list, ["دمشق","حلب","حمص","حماه","اللاذقية","طرطوس","إدلب","درعا","السويداء","القنيطرة","دير الزور","الرقة","الحسكة","اونلاين"]);
  assert.match(code, /return '~' \|\| coalesce\(nullif\(s, ''\), n\);/);
  assert.match(code, /case when nc\.grp like '~%' then nc\.raw_name else nc\.grp end as label/);
});

test("قواعد التجميع: كل قاعدة تعيد اسماً واحداً ومعروفاً، وقاعدة القيادة قبل قاعدة السيارة", () => {
  const labels = [...code.matchAll(/return '([^'~][^']*)';/g)].map((m) => m[1]);
  assert.ok(labels.length >= 30, "عدد القواعد: " + labels.length);
  const fn = code.slice(code.indexOf("create or replace function public.admin_stats_service_group"), code.indexOf("create or replace function public.admin_services_stats"));
  assert.ok(fn.indexOf("'قياد'") < fn.indexOf("'سيار'"), "تعليم القيادة لا يختلط بسيارة الأجرة");
  assert.ok(fn.indexOf("'ترجم'") < fn.indexOf("'المان'"), "الترجمة قبل اللغات");
  assert.ok(fn.indexOf("(صيان|تصليح|اصلاح|تعمير)") < fn.indexOf("(برمج|تطبيق|مطور"), "الصيانة قبل البرمجة");
});

test("الفلاتر تُتحقق داخل الدالة: محافظة غير معروفة أو منطقة بلا محافظة ترفع خطأ", () => {
  assert.match(code, /raise exception 'invalid region';/);
  assert.match(code, /raise exception 'area requires region';/);
  assert.match(code, /raise exception 'invalid area';/);
  assert.ok(code.includes("'__none__'"));
});

test("أقواس وعلامات اقتباس ومحدّدات $$ متوازنة", () => {
  const stripped = code.replace(/'(?:[^']|'')*'/g, "''");
  let depth = 0;
  for (const ch of stripped) { if (ch === "(") depth++; if (ch === ")") depth--; assert.ok(depth >= 0, "قوس إغلاق زائد"); }
  assert.equal(depth, 0, "أقواس غير متوازنة");
  assert.equal((code.match(/\$\$/g) || []).length, 8);
  assert.equal(((code.replace(/'(?:[^']|'')*'/g, "")).match(/'/g) || []).length, 0, "علامة اقتباس غير مغلقة");
  assert.ok(/\) into v_result;/.test(code));
});
