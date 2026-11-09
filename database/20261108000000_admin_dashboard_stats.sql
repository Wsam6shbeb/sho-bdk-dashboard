-- =====================================================================================
-- إحصائيات لوحة التحكم (قراءة فقط، أرقام مجمّعة بلا أي بيانات شخصية).
-- هذا الملف للمراجعة: لم يُنفَّذ على أي قاعدة بيانات.
-- يضيف دالة واحدة فقط ولا يغيّر أي جدول أو بيانات أو سياسات RLS أو دوال موجودة.
-- تُستدعى من functions/api/stats.js بمفتاح service_role فقط (الدالة مسحوبة من anon/authenticated).
--
-- ما الذي بُني عليه كل جزء (مصدره في المستودع):
--   * حالات الطلب (request_state) والاتفاق (agreement_state) والقيود (ledger_entry_type): src/types/database.ts
--   * يبقى الاتفاق state='active' حتى بعد اكتمال الطلب: submit_rating / finalize_overdue_requests
--     (migrations 20261009093000 و 20261010270000)
--   * commission_debit و topup_credit تُخزَّنان بقيمة موجبة: approve_agreement و admin_topup_wallet
--   * ai_failed و structured_data=null تأتيان من OrderContext.createServiceRequestInSupabase:
--       - الطلب يُدرَج أولاً بـ structured_data = null ثم يُحدَّث بعد تحليل Gemini
--       - عند فشل التحليل يُحفظ { category: null, ai_failed: true }
--   * التصنيف category يأتي من قائمة ثابتة من 13 تصنيفاً (supabase/functions/_shared/ai-analysis.ts)
--   * شروط ظهور مقدم الخدمة في المطابقة (get_provider_candidates بعد migrations 20261019080000 و 20261010290000):
--       is_available + رصيد المحفظة >= commission_max + ليس مخفياً بسبب تقييم منخفض
--   * محافظة مقدم الخدمة تُقرأ من structured_data.region لخدماته الفعّالة (وإلا من users.region)
--   * لا يوجد في قاعدة البيانات أي سجل يثبت أن "المطابقة لم تجد مقدم خدمة": دالة المطابقة لا تكتب شيئاً
--     عند عدم وجود نتائج، لذلك يُعرض هذا الصنف كحالة "غير مؤكدة" ولا يُسمّى "لم يجد مقدم خدمة".
-- =====================================================================================

create or replace function public.admin_dashboard_stats(
  p_days integer default 30,
  p_stale_hours integer default 48,
  p_include_owner boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz constant text := 'Asia/Damascus';
  v_categories constant text[] := array[
    'تعليم', 'تصليح وصيانة', 'نقل', 'تنظيف', 'معاملات وخدمات حكومية', 'ترجمة',
    'تصميم وبرمجة', 'صحة وجمال', 'منزل وحديقة', 'سيارات ومركبات', 'خدمات تجارية',
    'خدمات شخصية', 'أخرى'
  ];
  v_regions constant text[] := array[
    'دمشق', 'حلب', 'حمص', 'حماه', 'اللاذقية', 'طرطوس', 'إدلب', 'درعا', 'السويداء',
    'القنيطرة', 'دير الزور', 'الرقة', 'الحسكة'
  ];
  v_days integer := greatest(0, least(coalesce(p_days, 30), 3650));
  v_stale integer := greatest(1, least(coalesce(p_stale_hours, 48), 720));
  v_gran text;
  v_step interval;
  v_fmt text;
  v_local_now timestamp;
  v_series_start timestamp;
  v_series_end timestamp;
  v_series_truncated boolean := false;
  v_since timestamptz;
  v_req_from timestamptz;
  v_commission_max numeric;
  v_hide_below numeric;
  v_hide_min integer;
  v_result jsonb;
begin
  v_gran := case when v_days between 1 and 90 then 'day' else 'month' end;
  v_step := case when v_gran = 'day' then interval '1 day' else interval '1 month' end;
  v_fmt := case when v_gran = 'day' then 'YYYY-MM-DD' else 'YYYY-MM' end;
  v_local_now := now() at time zone v_tz;
  v_series_end := date_trunc(v_gran, v_local_now);

  if v_days > 0 then
    v_series_start := date_trunc(v_gran, v_local_now - make_interval(days => greatest(v_days - 1, 0)));
  else
    v_series_start := date_trunc('month', coalesce(
      least(
        (select min(created_at) from public.service_requests),
        (select min(created_at) from public.users)
      ),
      now()
    ) at time zone v_tz);
    -- كل التاريخ: لا نبني سلسلة زمنية أطول من 36 شهراً.
    if v_series_start < date_trunc('month', v_local_now) - interval '35 months' then
      v_series_start := date_trunc('month', v_local_now) - interval '35 months';
      v_series_truncated := true;
    end if;
  end if;

  v_since := case
    when v_days = 0 then '-infinity'::timestamptz
    when v_gran = 'day' then v_series_start at time zone v_tz
    else now() - make_interval(days => v_days)
  end;
  -- نافذة الفترة السابقة (بالطول نفسه) لمقارنة نمو الطلب؛ لا تُستعمل مع "كل التاريخ".
  v_req_from := case
    when v_days = 0 then v_since
    else v_since - make_interval(days => v_days)
  end;

  -- إعدادات تحدد ظهور مقدمي الخدمة في البحث (نفس تعبيرات القراءة في migrations المطابقة وقيمها الافتراضية).
  begin
    select (value)::text::numeric into v_commission_max
      from public.app_settings where key = 'commission_max';
  exception when others then
    v_commission_max := null;
  end;
  begin
    select (value)::text::numeric into v_hide_below
      from public.app_settings where key = 'hide_provider_below_rating';
    select (value)::text::integer into v_hide_min
      from public.app_settings where key = 'hide_provider_min_ratings';
  exception when others then
    v_hide_below := null;
    v_hide_min := null;
  end;
  v_hide_below := coalesce(v_hide_below, 3);
  v_hide_min := coalesce(v_hide_min, 5);

  with
  -- ---------------------------------------------------------------- الطلبات
  req as (
    select sr.id,
           sr.created_at,
           (sr.created_at >= v_since) as in_current,
           sr.state::text as state,
           case when btrim(sr.region) = any (v_regions) then btrim(sr.region) end as region,
           case when (sr.structured_data->>'category') = any (v_categories)
                then sr.structured_data->>'category' end as category,
           (coalesce(sr.structured_data, 'null'::jsonb) = 'null'::jsonb) as analysis_missing,
           coalesce(sr.structured_data->'ai_failed' = 'true'::jsonb, false) as ai_failed
      from public.service_requests sr
     where sr.created_at >= v_req_from
  ),
  flags as (
    select r.*,
           exists (select 1 from public.candidates c where c.request_id = r.id) as has_cand,
           exists (select 1 from public.conversations cv where cv.request_id = r.id) as has_conv
      from req r
  ),
  -- فئات متبادلة الاستبعاد: أول شرط ينطبق يحسم الصنف، فلا يُحسب الطلب في أكثر من نتيجة.
  classified as (
    select f.*,
           case
             when f.state = 'completed' then 'completed'
             when f.state in ('active', 'completion_pending_rating') then 'agreed_active'
             when f.state = 'cancelled' then 'cancelled'
             when f.state = 'expired' then 'expired'
             when f.created_at > now() - make_interval(hours => v_stale) then 'in_progress'
             when f.has_conv then 'contact_no_agreement'
             when f.has_cand then 'candidates_no_contact'
             when f.ai_failed then 'no_candidates_ai_failed'
             when f.analysis_missing then 'no_candidates_incomplete'
             else 'no_candidates_unconfirmed'
           end as outcome
      from flags f
  ),
  cur as (select * from classified where in_current),
  prev_by_cat as (
    select category, count(*) as n from classified where not in_current and category is not null group by category
  ),
  -- ---------------------------------------------------------------- مقدمو الخدمة
  prov as (
    select u.id,
           case when btrim(u.region) = any (v_regions) then btrim(u.region) end as region,
           (pp.user_id is not null) as has_profile,
           coalesce(pp.is_available, false) as is_available,
           coalesce(w.available_balance, 0) as balance,
           (u.rating_count >= v_hide_min and u.rating_avg < v_hide_below) as hidden_low_rating,
           exists (select 1 from public.provider_services ps where ps.provider_id = u.id and ps.is_active) as has_service
      from public.users u
      left join public.provider_profiles pp on pp.user_id = u.id
      left join public.wallets w on w.user_id = u.id
     where not u.is_admin and u.is_provider and u.status = 'active' and u.deleted_at is null
  ),
  prov_state as (
    select p.*,
           case
             when not p.has_profile then 'no_profile'
             when not p.has_service then 'no_active_service'
             when not p.is_available then 'unavailable'
             when v_commission_max is not null and p.balance < v_commission_max then 'low_balance'
             when p.hidden_low_rating then 'hidden_low_rating'
             else 'searchable'
           end as search_state
      from prov p
  ),
  -- محافظة الخدمة نفسها (structured_data.region) إن كانت من القائمة المعتمدة. وإن لم تُحدَّد تُستعمل محافظة حساب المقدم.
  -- (تحقق من قاعدة الإنتاج: users.region فارغ لمقدمي الخدمة بينما structured_data.region معبّأ في معظم الخدمات.)
  provider_cats as (
    select distinct ps.provider_id,
           ps.structured_data->>'category' as category,
           case when btrim(ps.structured_data->>'region') = any (v_regions) then btrim(ps.structured_data->>'region') end as service_region
      from public.provider_services ps
     where ps.is_active and (ps.structured_data->>'category') = any (v_categories)
  ),
  -- المحافظات التي يعمل فيها كل مقدم: محافظات خدماته الفعّالة، وإن لم تحدد أي خدمة محافظة فمحافظة حسابه.
  -- المقدم الذي يخدم أكثر من محافظة يُحسب في كل منها.
  provider_regions_raw as (
    select p.id as provider_id,
           p.search_state,
           coalesce(
             case when btrim(ps.structured_data->>'region') = any (v_regions) then btrim(ps.structured_data->>'region') end,
             p.region
           ) as region
      from prov_state p
      left join public.provider_services ps on ps.provider_id = p.id and ps.is_active
  ),
  provider_regions as (
    select distinct rg.provider_id, rg.search_state, rg.region
      from provider_regions_raw rg
     where rg.region is not null
        or not exists (select 1 from provider_regions_raw rg2 where rg2.provider_id = rg.provider_id and rg2.region is not null)
  ),
  supply_by_cat as (
    select pc.category, count(distinct p.id) as providers
      from prov_state p join provider_cats pc on pc.provider_id = p.id
     where p.search_state = 'searchable'
     group by pc.category
  ),
  supply_by_cat_region as (
    select pc.category, coalesce(pc.service_region, p.region) as region, count(distinct p.id) as providers
      from prov_state p join provider_cats pc on pc.provider_id = p.id
     where p.search_state = 'searchable'
     group by pc.category, coalesce(pc.service_region, p.region)
  ),
  supply_by_region as (
    select pr.region,
           count(distinct pr.provider_id) as active,
           count(distinct pr.provider_id) filter (where pr.search_state = 'searchable') as searchable
      from provider_regions pr group by pr.region
  ),
  -- ---------------------------------------------------------------- جداول الطلب
  cat_stats as (
    select c.category,
           count(*) as requests,
           count(*) filter (where c.outcome in ('completed', 'agreed_active')) as agreed,
           count(*) filter (where c.outcome <> 'in_progress') as resolved,
           count(*) filter (where c.outcome in ('no_candidates_unconfirmed', 'no_candidates_ai_failed', 'no_candidates_incomplete')) as no_candidates
      from cur c where c.category is not null group by c.category
  ),
  region_stats as (
    select c.region,
           count(*) as requests,
           count(*) filter (where c.outcome in ('completed', 'agreed_active')) as agreed,
           count(*) filter (where c.outcome <> 'in_progress') as resolved,
           count(*) filter (where c.outcome in ('no_candidates_unconfirmed', 'no_candidates_ai_failed', 'no_candidates_incomplete')) as no_candidates
      from cur c group by c.region
  ),
  cell_stats as (
    select c.category, c.region,
           count(*) as requests,
           count(*) filter (where c.outcome in ('no_candidates_unconfirmed', 'no_candidates_ai_failed', 'no_candidates_incomplete')) as no_candidates
      from cur c where c.category is not null group by c.category, c.region
  ),
  -- ---------------------------------------------------------------- السلاسل الزمنية
  buckets as (
    select b from generate_series(v_series_start, v_series_end, v_step) as b
  )
  select jsonb_build_object(
    'meta', jsonb_build_object(
      'generated_at', now(),
      'days', v_days,
      'granularity', v_gran,
      'timezone', v_tz,
      'stale_hours', v_stale,
      'series_truncated', v_series_truncated,
      'commission_max', v_commission_max
    ),
    'users', jsonb_build_object(
      'accounts_total', (select count(*) from public.users where not is_admin),
      'active_customers', (select count(*) from public.users where not is_admin and not is_provider and status = 'active' and deleted_at is null),
      'active_providers', (select count(*) from public.users where not is_admin and is_provider and status = 'active' and deleted_at is null),
      'suspended', (select count(*) from public.users where not is_admin and status = 'suspended' and deleted_at is null),
      'deleted', (select count(*) from public.users where not is_admin and (deleted_at is not null or status = 'deleted')),
      'new_in_period', (select count(*) from public.users where not is_admin and created_at >= v_since),
      'series', (
        select coalesce(jsonb_agg(jsonb_build_object('d', to_char(t.b, v_fmt), 'n', t.n) order by t.b), '[]'::jsonb)
          from (
            select bk.b, count(u.id) as n
              from buckets bk
              left join public.users u
                on date_trunc(v_gran, u.created_at at time zone v_tz) = bk.b
               and not u.is_admin and u.created_at >= v_since
             group by bk.b
          ) t
      )
    ),
    'providers', jsonb_build_object(
      'states', (
        select coalesce(jsonb_object_agg(t.search_state, t.n), '{}'::jsonb)
          from (select search_state, count(*) as n from prov_state group by search_state) t
      ),
      'searchable_without_category', (
        select count(*) from prov_state p
         where p.search_state = 'searchable'
           and not exists (select 1 from provider_cats pc where pc.provider_id = p.id)
      ),
      'by_region', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'region', coalesce(s.region, 'غير محدد'), 'active', s.active, 'searchable', s.searchable
               ) order by s.active desc, s.region), '[]'::jsonb)
          from supply_by_region s
      )
    ),
    'requests', jsonb_build_object(
      'total', (select count(*) from cur),
      'outcomes', (
        select coalesce(jsonb_object_agg(t.outcome, t.n), '{}'::jsonb)
          from (select outcome, count(*) as n from cur group by outcome) t
      ),
      'uncategorized', jsonb_build_object(
        'analysis_missing', (select count(*) from cur where category is null and analysis_missing),
        'ai_failed', (select count(*) from cur where category is null and not analysis_missing and ai_failed),
        'other', (select count(*) from cur where category is null and not analysis_missing and not ai_failed)
      ),
      'series', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'd', to_char(t.b, v_fmt), 'created', t.created, 'agreements', t.agreements
               ) order by t.b), '[]'::jsonb)
          from (
            select bk.b,
                   (select count(*) from cur c where date_trunc(v_gran, c.created_at at time zone v_tz) = bk.b) as created,
                   (select count(*) from public.agreements a
                     where a.state = 'active' and a.responded_at is not null and a.responded_at >= v_since
                       and date_trunc(v_gran, a.responded_at at time zone v_tz) = bk.b) as agreements
              from buckets bk
          ) t
      ),
      'by_hour', (
        select coalesce(jsonb_agg(t.n order by t.h), '[]'::jsonb)
          from (
            select h, count(c.id) as n
              from generate_series(0, 23) h
              left join cur c on extract(hour from c.created_at at time zone v_tz)::int = h
             group by h
          ) t
      ),
      'by_dow', (
        select coalesce(jsonb_agg(t.n order by t.d), '[]'::jsonb)
          from (
            select d, count(c.id) as n
              from generate_series(0, 6) d
              left join cur c on extract(dow from c.created_at at time zone v_tz)::int = d
             group by d
          ) t
      ),
      'by_dow_period', (
        select coalesce(jsonb_agg(jsonb_build_object('dow', t.d, 'period', t.p, 'n', t.n)), '[]'::jsonb)
          from (
            select extract(dow from c.created_at at time zone v_tz)::int as d,
                   case
                     when extract(hour from c.created_at at time zone v_tz) < 6 then 0
                     when extract(hour from c.created_at at time zone v_tz) < 12 then 1
                     when extract(hour from c.created_at at time zone v_tz) < 18 then 2
                     else 3
                   end as p,
                   count(*) as n
              from cur c group by 1, 2
          ) t
      )
    ),
    'categories', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'category', s.category,
               'requests', s.requests,
               'prev_requests', case when v_days > 0 then coalesce(pv.n, 0) end,
               'agreed', s.agreed,
               'resolved', s.resolved,
               'no_candidates', s.no_candidates,
               'searchable_providers', coalesce(sp.providers, 0)
             ) order by s.requests desc, s.category), '[]'::jsonb)
        from cat_stats s
        left join prev_by_cat pv on pv.category = s.category
        left join supply_by_cat sp on sp.category = s.category
    ),
    'regions', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'region', coalesce(s.region, 'غير محدد'),
               'requests', s.requests,
               'agreed', s.agreed,
               'resolved', s.resolved,
               'no_candidates', s.no_candidates,
               'searchable_providers', coalesce(sr.searchable, 0)
             ) order by s.requests desc, s.region), '[]'::jsonb)
        from region_stats s
        left join supply_by_region sr on sr.region is not distinct from s.region
    ),
    'cells', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'category', t.category,
               'region', coalesce(t.region, 'غير محدد'),
               'requests', t.requests,
               'no_candidates', t.no_candidates,
               'searchable_providers', t.providers
             ) order by t.requests desc, t.category, t.region), '[]'::jsonb)
        from (
          select s.category, s.region, s.requests, s.no_candidates, coalesce(sp.providers, 0) as providers
            from cell_stats s
            left join supply_by_cat_region sp on sp.category = s.category and sp.region = s.region
           order by s.requests desc, s.category, s.region
           limit 40
        ) t
    ),
    'agreements', jsonb_build_object(
      'by_state', (
        select coalesce(jsonb_object_agg(t.s, t.n), '{}'::jsonb)
          from (select a.state::text as s, count(*) as n from public.agreements a where a.created_at >= v_since group by 1) t
      )
    ),
    'verification', jsonb_build_object(
      'latest_by_status', (
        select coalesce(jsonb_object_agg(t.s, t.n), '{}'::jsonb)
          from (
            select v.status::text as s, count(*) as n
              from (select distinct on (user_id) user_id, status
                      from public.verifications order by user_id, created_at desc) v
             group by 1
          ) t
      )
    ),
    'reports', jsonb_build_object(
      'open_total', (select count(*) from public.reports where status = 'open'),
      'by_status', (
        select coalesce(jsonb_object_agg(t.s, t.n), '{}'::jsonb)
          from (select status::text as s, count(*) as n from public.reports where created_at >= v_since group by 1) t
      )
    ),
    -- تقييمات الزبائن لمقدمي الخدمة فقط (from = صاحب الطلب)، دون التقييمات التلقائية.
    'ratings', (
      select jsonb_build_object(
               'count', count(*),
               'avg', round(avg(t.score)::numeric, 2),
               'satisfied', count(*) filter (where t.score >= 4),
               'distribution', coalesce(
                 (select jsonb_object_agg(d.score::text, d.n)
                    from (
                      select r2.score, count(*) as n
                        from public.ratings r2
                        join public.service_requests s2 on s2.id = r2.request_id
                       where r2.from_user_id = s2.requester_id and not r2.auto_completed and r2.created_at >= v_since
                       group by r2.score
                    ) d),
                 '{}'::jsonb)
             )
        from (
          select r.score
            from public.ratings r
            join public.service_requests s on s.id = r.request_id
           where r.from_user_id = s.requester_id and not r.auto_completed and r.created_at >= v_since
        ) t
    )
  ) into v_result;

  if p_include_owner then
    v_result := v_result || jsonb_build_object('owner', jsonb_build_object(
      'finance', jsonb_build_object(
        'commission_total', (
          select coalesce(sum(l.amount), 0) from public.ledger_entries l
           where l.entry_type = 'commission_debit' and l.created_at >= v_since
        ),
        'topup_total', (
          select coalesce(sum(l.amount), 0) from public.ledger_entries l
           where l.entry_type = 'topup_credit' and l.created_at >= v_since
        ),
        'wallets_total', (
          select coalesce(sum(w.available_balance), 0)
            from public.wallets w join public.users u on u.id = w.user_id and not u.is_admin
        )
      ),
      'ai', jsonb_build_object(
        'rate_limit_events', (
          select count(*) from public.app_error_log e
           where e.operation = 'analyze_service_request' and e.created_at >= v_since
        )
      )
    ));
  end if;

  return v_result;
end;
$$;

-- لا يُستدعى إلا من الخادم (Cloudflare Function) بمفتاح service_role.
revoke all on function public.admin_dashboard_stats(integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.admin_dashboard_stats(integer, integer, boolean) to service_role;
