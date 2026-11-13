-- =====================================================================================
-- استعلامات قراءة فقط (SELECT) للتحقق من افتراضات دالة الإحصائيات على قاعدة البيانات الفعلية.
-- شغّلها يدوياً في Supabase SQL Editor قبل تطبيق migration الإحصائيات. لا تغيّر أي شيء.
-- كل استعلام يوضّح ما المتوقع منه.
-- =====================================================================================

-- 1) قيم الـ enums. المتوقع: القيم نفسها الواردة في src/types/database.ts
select t.typname, string_agg(e.enumlabel, ', ' order by e.enumsortorder) as labels
  from pg_type t join pg_enum e on e.enumtypid = t.oid
 where t.typname in ('request_state', 'agreement_state', 'ledger_entry_type', 'report_status', 'verification_status', 'request_urgency')
 group by t.typname order by t.typname;

-- 2) وجود كل الأعمدة التي تستعملها الدالة. المتوقع: لا صفوف (أي لا يوجد عمود ناقص).
with needed(tbl, col) as (values
  ('service_requests','id'),('service_requests','created_at'),('service_requests','state'),('service_requests','region'),('service_requests','structured_data'),('service_requests','requester_id'),
  ('candidates','request_id'),('conversations','request_id'),
  ('agreements','request_id'),('agreements','state'),('agreements','responded_at'),('agreements','created_at'),
  ('users','id'),('users','region'),('users','status'),('users','deleted_at'),('users','is_admin'),('users','is_provider'),('users','created_at'),('users','rating_count'),('users','rating_avg'),
  ('provider_profiles','user_id'),('provider_profiles','is_available'),
  ('provider_services','provider_id'),('provider_services','is_active'),('provider_services','structured_data'),
  ('wallets','user_id'),('wallets','available_balance'),
  ('ratings','request_id'),('ratings','from_user_id'),('ratings','score'),('ratings','auto_completed'),('ratings','created_at'),
  ('reports','status'),('reports','created_at'),
  ('verifications','user_id'),('verifications','status'),('verifications','created_at'),
  ('ledger_entries','entry_type'),('ledger_entries','amount'),('ledger_entries','created_at'),
  ('app_error_log','operation'),('app_error_log','created_at'),
  ('app_settings','key'),('app_settings','value')
)
select n.tbl, n.col as missing_column
  from needed n
  left join information_schema.columns c
    on c.table_schema = 'public' and c.table_name = n.tbl and c.column_name = n.col
 where c.column_name is null;

-- 3) مفاتيح الإعدادات المستعملة. المتوقع: commission_max موجود؛ مفتاحا الإخفاء موجودان أو يُستعمل الافتراضي (3 و5).
select key, value from public.app_settings
 where key in ('commission_max', 'commission_min', 'hide_provider_below_rating', 'hide_provider_min_ratings');

-- 4) هل تعريف get_provider_candidates الحي ما زال يحوي شروط الظهور التي بُنيت عليها حالات "مقدم خدمة قابل للظهور"؟
--    المتوقع: الأعمدة الثلاثة كلها true. إن كان أحدها false فعدّل تعريف search_state في الدالة.
select position('is_available' in pg_get_functiondef(p.oid)) > 0            as checks_is_available,
       position('commission_max' in pg_get_functiondef(p.oid)) > 0          as checks_commission_max,
       position('hide_provider_below_rating' in pg_get_functiondef(p.oid)) > 0 as checks_low_rating_hide
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'get_provider_candidates';

-- 5) أي دوال تضع حالة الطلب cancelled أو expired؟ (لفهم معنى هاتين الحالتين قبل الاعتماد عليهما)
select p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and (p.prosrc ilike '%state%=%''cancelled''%' or p.prosrc ilike '%state%=%''expired''%')
 order by p.proname;

-- 6) توزيع حالات الطلبات الفعلية (لرؤية الحالات المستعملة فعلاً).
select state, count(*) from public.service_requests group by state order by 2 desc;

-- 7) كم طلباً بلا تحليل (structured_data فارغ) وكم طلباً بعلم ai_failed؟
select count(*) filter (where structured_data is null) as analysis_missing,
       count(*) filter (where structured_data->'ai_failed' = 'true'::jsonb) as ai_failed,
       count(*) as total
  from public.service_requests;

-- 8) قيم التصنيف خارج القائمة المعتمدة (ستُعامل كـ "بلا تصنيف"). المتوقع: لا صفوف أو قليلة جداً.
select structured_data->>'category' as category, count(*)
  from public.service_requests
 where structured_data->>'category' is not null
   and structured_data->>'category' <> all (array['تعليم','تصليح وصيانة','نقل','تنظيف','معاملات وخدمات حكومية','ترجمة','تصميم وبرمجة','صحة وجمال','منزل وحديقة','سيارات ومركبات','خدمات تجارية','خدمات شخصية','أخرى'])
 group by 1 order by 2 desc;

-- 9) قيم المحافظة خارج القائمة المعتمدة (ستظهر كـ "غير محدد") في الطلبات وحسابات مقدمي الخدمة.
select 'requests' as source, region, count(*)
  from public.service_requests
 where region is not null and btrim(region) <> all (array['دمشق','حلب','حمص','حماه','اللاذقية','طرطوس','إدلب','درعا','السويداء','القنيطرة','دير الزور','الرقة','الحسكة'])
 group by region
union all
select 'provider_accounts', region, count(*)
  from public.users
 where is_provider and region is not null and btrim(region) <> all (array['دمشق','حلب','حمص','حماه','اللاذقية','طرطوس','إدلب','درعا','السويداء','القنيطرة','دير الزور','الرقة','الحسكة'])
 group by region
 order by 1, 3 desc;

-- 10) معنى ratings.auto_completed: كم تقييماً بهذه العلامة؟ (الدالة تستثنيها من مؤشر الرضا)
select auto_completed, count(*) from public.ratings group by auto_completed;

-- 11) فهارس تفيد الاستعلامات (للمراجعة فقط، لا تُنشأ تلقائياً).
select tablename, indexname, indexdef
  from pg_indexes
 where schemaname = 'public'
   and tablename in ('candidates', 'conversations', 'agreements', 'service_requests', 'ratings', 'ledger_entries')
 order by tablename, indexname;

-- 12) مصدر محافظة مقدم الخدمة: الدالة تقرأها من structured_data.region لخدماته الفعّالة وإلا من users.region.
--     المتوقع: ألا تكون كل الصفوف "(null)"؛ وإلا سيظهر مقدمو الخدمة كـ "غير محدد" في جداول المحافظات.
select 'provider_account_region' as source, coalesce(u.region, '(null)') as value, count(*) as n
  from public.users u where u.is_provider and not u.is_admin group by 2
union all
select 'service_structured_data_region', coalesce(ps.structured_data->>'region', '(null)'), count(*)
  from public.provider_services ps where ps.is_active group by 2
order by 1, 3 desc;

-- 13) تدقيق تجميع أسماء الخدمات (بعد تطبيق migration الخدمات): كل اسم أصلي مقابل المجموعة التي انضمّ إليها.
--     المجموعات التي تبدأ بـ ~ لم تطابق أي قاعدة وتبقى بنفسها. إن رأيت اسمين مختلفين في مجموعة واحدة بالخطأ فأخبر المطوّر لتعديل القاعدة.
select public.admin_stats_service_group(t.name) as grp, t.name, count(*) as n
  from (
    select structured_data->>'service' as name from public.service_requests where structured_data->>'service' is not null
    union all
    select coalesce(structured_data->>'service', description) from public.provider_services where is_active
  ) t
 group by 1, 2
 order by 1, 3 desc;
