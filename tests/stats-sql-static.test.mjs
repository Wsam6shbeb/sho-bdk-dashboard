// فحص ثابت لملف SQL (ليس تنفيذاً): أسماء الجداول والأعمدة وقيم الـ enums، وسلامة البنية، وصلاحيات الدالة.
// لا يغني عن تشغيل الدالة على نسخة تجريبية من قاعدة البيانات.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const SQL = fs.readFileSync(new URL("../database/20261108000000_admin_dashboard_stats.sql", import.meta.url), "utf8");
const SCHEMA = JSON.parse(fs.readFileSync(new URL("./fixtures/schema-snapshot.json", import.meta.url), "utf8"));
const code = SQL.replace(/--.*$/gm, ""); // بلا تعليقات

test("لا يحوي أي أمر كتابة أو DDL على الجداول (فقط create function + revoke/grant)", () => {
  assert.ok(!/\b(insert\s+into|update\s+public\.|delete\s+from|drop\s+|alter\s+|truncate|create\s+table|create\s+index|create\s+policy|create\s+trigger)\b/i.test(code));
  const statements = code.match(/\b(create\s+or\s+replace\s+function|revoke|grant)\b/gi) || [];
  assert.deepEqual(statements.map((s) => s.toLowerCase().replace(/\s+/g, " ")), ["create or replace function", "revoke", "grant"]);
});

test("الدالة SECURITY DEFINER مع search_path ثابت ومسحوبة من anon/authenticated/public ومعطاة لـ service_role فقط", () => {
  assert.match(code, /security definer/i);
  assert.match(code, /set search_path = public, pg_temp/i);
  assert.match(code, /revoke all on function public\.admin_dashboard_stats\(integer, integer, boolean\) from public, anon, authenticated;/i);
  assert.match(code, /grant execute on function public\.admin_dashboard_stats\(integer, integer, boolean\) to service_role;/i);
  assert.ok(!/grant[^;]*\bto\b[^;]*(anon|authenticated)/i.test(code));
});

test("كل الجداول المذكورة بـ public.<name> موجودة في المخطط", () => {
  const names = new Set([...code.matchAll(/public\.([a-z_]+)/g)].map((m) => m[1]));
  names.delete("admin_dashboard_stats");
  for (const name of names) assert.ok(SCHEMA.tables[name], "جدول غير موجود في المخطط: " + name);
  assert.ok(names.size >= 12);
});

test("كل alias.column مرتبط بجدول حقيقي يشير إلى عمود موجود", () => {
  const KEYWORDS = new Set(["on", "where", "left", "right", "inner", "join", "group", "order", "using", "limit", "and", "or", "as", "set", "from", "select"]);
  const bound = new Map(); // alias -> table (تُجمع من كل المواضع؛ نفس الـ alias قد يشير لجداول مختلفة بنطاقات مختلفة)
  const pairs = [];
  for (const m of code.matchAll(/\b(?:from|join)\s+public\.([a-z_]+)(?:\s+as)?\s+([a-z_][a-z0-9_]*)?/gi)) {
    const table = m[1]; const alias = m[2] && !KEYWORDS.has(m[2].toLowerCase()) ? m[2] : table;
    if (!bound.has(alias)) bound.set(alias, new Set());
    bound.get(alias).add(table);
    pairs.push([alias, table]);
  }
  let checked = 0;
  for (const [alias, tables] of bound) {
    for (const m of code.matchAll(new RegExp("\\b" + alias + "\\.([a-z_]+)\\b", "g"))) {
      const col = m[1];
      if (col === "structured_data") { checked++; continue; }
      const ok = [...tables].some((t) => SCHEMA.tables[t].includes(col)) ||
        // alias قد يُعاد استعماله لـ CTE (مثل c = cur) فلا نملك مخططه؛ نتحقق فقط إن كان كل الربط جداول حقيقية
        false;
      if (!ok) {
        // اسمح فقط إن كان الـ alias مستعملاً أيضاً لـ CTE في موضع آخر (لا يمكن فحصه هنا)
        const cteAlias = new RegExp("\\bfrom\\s+(cur|classified|flags|req|prov_state|prov|cat_stats|region_stats|cell_stats|supply_by_cat|supply_by_cat_region|supply_by_region|provider_cats|prev_by_cat|buckets)\\s+" + alias + "\\b", "i").test(code) ||
                         new RegExp("\\bjoin\\s+(cur|classified|flags|req|prov_state|prov|cat_stats|region_stats|cell_stats|supply_by_cat|supply_by_cat_region|supply_by_region|provider_cats|prev_by_cat|buckets)\\s+" + alias + "\\b", "i").test(code);
        assert.ok(cteAlias, `العمود ${alias}.${col} غير موجود في أي جدول مرتبط بالـ alias (${[...tables].join(", ")})`);
      }
      checked++;
    }
  }
  assert.ok(checked > 60, "عدد المراجع المفحوصة: " + checked);
});

test("قيم الـ enums المستعملة موجودة فعلاً", () => {
  const inList = (list, vals) => vals.forEach((v) => assert.ok(list.includes(v), v + " ليست في " + list.join(",")));
  inList(SCHEMA.enums.request_state, ["completed", "active", "completion_pending_rating", "cancelled", "expired"]);
  inList(SCHEMA.enums.agreement_state, ["active"]);
  inList(SCHEMA.enums.ledger_entry_type, ["commission_debit", "topup_credit"]);
  inList(SCHEMA.enums.report_status, ["open"]);
  // وتأكد أن هذه القيم تُستعمل فعلاً في الملف
  for (const lit of ["'completed'", "'completion_pending_rating'", "'cancelled'", "'expired'", "'commission_debit'", "'topup_credit'", "'open'"]) assert.ok(code.includes(lit), lit);
  // لا حالات غير موجودة (مثل not_executed_review الذي هو حالة محسوبة في دالة سجل الطلبات وليست مخزّنة)
  assert.ok(!code.includes("not_executed_review"));
  assert.ok(!code.includes("non_execution"));
});

test("أقواس وعلامات اقتباس ومحدّدات \$\$ متوازنة", () => {
  const stripped = code.replace(/'(?:[^']|'')*'/g, "''"); // أزل النصوص الحرفية
  let depth = 0;
  for (const ch of stripped) { if (ch === "(") depth++; if (ch === ")") depth--; assert.ok(depth >= 0, "قوس إغلاق زائد"); }
  assert.equal(depth, 0, "أقواس غير متوازنة");
  assert.equal((code.match(/\$\$/g) || []).length, 2);
  assert.equal(((code.replace(/'(?:[^']|'')*'/g, "")).match(/'/g) || []).length, 0, "علامة اقتباس غير مغلقة");
  assert.ok(/\) into v_result;/.test(code));
});

test("المحافظات والتصنيفات في SQL مطابقة تماماً لقوائم التطبيق (13 و13)", () => {
  const catList = ["تعليم","تصليح وصيانة","نقل","تنظيف","معاملات وخدمات حكومية","ترجمة","تصميم وبرمجة","صحة وجمال","منزل وحديقة","سيارات ومركبات","خدمات تجارية","خدمات شخصية","أخرى"];
  const regionList = ["دمشق","حلب","حمص","حماه","اللاذقية","طرطوس","إدلب","درعا","السويداء","القنيطرة","دير الزور","الرقة","الحسكة"];
  const pick = (name) => [...code.match(new RegExp(name + " constant text\\[\\] := array\\[([\\s\\S]*?)\\];"))[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(pick("v_categories"), catList);
  assert.deepEqual(pick("v_regions"), regionList);
});

test("لا اعتماد على دوال مساعدة غير موثقة (norm_ar / norm_region / region_matches)", () => {
  assert.ok(!/norm_ar|norm_region|region_matches|jsonb_text_list/.test(code));
});

test("تصنيف النتائج: كل فرع CASE يعيد قيمة من القائمة المعتمدة ولا تكرار", () => {
  const block = code.match(/case\s+when f\.state = 'completed'[\s\S]*?end as outcome/)[0];
  const outs = [...block.matchAll(/then '([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(outs, ["completed", "agreed_active", "cancelled", "expired", "in_progress", "contact_no_agreement", "candidates_no_contact", "no_candidates_ai_failed", "no_candidates_incomplete"]);
  assert.equal(new Set(outs).size, outs.length);
  assert.match(block, /else 'no_candidates_unconfirmed'/);
});
