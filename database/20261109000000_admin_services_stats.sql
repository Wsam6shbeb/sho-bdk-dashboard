-- =====================================================================================
-- إحصائيات «الخدمات» في لوحة التحكم: ما الذي يُطلب وما الذي يُعرض، بالاسم الفعلي للخدمة،
-- مع فلتر محافظة ثم منطقة. قراءة فقط، أرقام مجمّعة بلا أي بيانات شخصية.
-- لا يغيّر أي جدول أو بيانات أو سياسات RLS، ولا يمسّ الدالة admin_dashboard_stats الموجودة.
--
-- تجميع الأسماء المتشابهة (تلقائي بالكود):
--   * admin_stats_norm_text: يوحّد الحروف (أ إ آ ← ا، ة ← ه، ى ← ي) ويحذف التشكيل والرموز.
--   * admin_stats_service_group: قواعد مرتبة (أول قاعدة تنطبق تحسم المجموعة).
--     ما لا تنطبق عليه قاعدة يبقى مجموعة بنفسه باسمه المطبَّع (مفتاحه يبدأ بـ ~)، ولا يُدمج مع غيره.
--   * الواجهة تعرض تحت كل مجموعة الأسماء الأصلية التي انضمّت إليها (للمراجعة)، فأي دمج خاطئ يظهر فوراً.
--
-- مصدر البيانات (تحقق منه على القاعدة الفعلية):
--   * اسم الخدمة: service_requests.structured_data->>'service'، ولمقدم الخدمة structured_data->>'service' وإلا description
--   * المحافظة: service_requests.region، ولمقدم الخدمة structured_data.region وإلا users.region
--   * المنطقة: structured_data.service_area.areas[0] وإلا المدينة إن اختلفت عن المحافظة؛
--     ولمقدم الخدمة structured_data.location وإلا ما سبق. المنطقة ناقصة في معظم الصفوف الحالية، وهذا يظهر في الواجهة.
--     «اونلاين» ليست محافظة فلا مناطق لها.
-- =====================================================================================

create or replace function public.admin_stats_norm_text(p_text text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select btrim(regexp_replace(
           regexp_replace(
             translate(lower(coalesce(p_text, '')), 'أإآٱىة', 'اااايه'),
             '[\u064B-\u065F\u0670\u0640]', '', 'g'),
           '[^\u0621-\u064Aa-z0-9]+', ' ', 'g'));
$$;

create or replace function public.admin_stats_area_key(p_text text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select nullif(btrim(regexp_replace(public.admin_stats_norm_text(p_text), '(^| )ال(?=[^ ]{2,})', '\1', 'g')), '');
$$;

create or replace function public.admin_stats_service_group(p_name text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  n text := public.admin_stats_norm_text(p_name);
  teach boolean;
  s text;
begin
  if n = '' then
    return null;
  end if;

  teach := n ~ '(تعليم|تدريس|مدرس|معلم|دوره|دورات|درس|كورس|استاذ)';

  if n ~ 'قياد' then return 'تعليم قيادة السيارات'; end if;
  if n ~ 'ترجم' then return 'ترجمة'; end if;

  if teach or n ~ 'لغه' then
    if n ~ 'المان' then return 'تعليم اللغة الألمانية'; end if;
    if n ~ '(انجليز|انكليز|english)' then return 'تعليم اللغة الإنجليزية'; end if;
    if n ~ 'فرنس' then return 'تعليم اللغة الفرنسية'; end if;
    if n ~ 'تركي' then return 'تعليم اللغة التركية'; end if;
    if n ~ 'روسي' then return 'تعليم اللغة الروسية'; end if;
    if n ~ 'اسباني' then return 'تعليم اللغة الإسبانية'; end if;
    if n ~ 'ايطالي' then return 'تعليم اللغة الإيطالية'; end if;
  end if;

  if teach then
    if n ~ 'رياضيات' then return 'تدريس رياضيات'; end if;
    if n ~ 'فيزيا' then return 'تدريس فيزياء'; end if;
    if n ~ 'كيميا' then return 'تدريس كيمياء'; end if;
    if n ~ '(احياء|علوم)' then return 'تدريس علوم وأحياء'; end if;
    if n ~ '(برمج|تطبيق|حاسوب|كمبيوتر|اكسل|وورد)' then return 'تعليم برمجة وحاسوب'; end if;
  end if;

  if n ~ '(صيان|تصليح|اصلاح|تعمير)' then
    if n ~ '(موبايل|جوال|هاتف|هواتف|تلفون)' then return 'صيانة موبايلات'; end if;
    if n ~ '(كمبيوتر|لابتوب|حاسوب|حواسيب)' then return 'صيانة كمبيوتر'; end if;
    if n ~ '(سيار|ميكانيك|بنشر)' then return 'صيانة سيارات'; end if;
    if n ~ '(غسال|براد|تلفزيون|شاشه|مكيف|تكييف|فرن|سخان)' then return 'صيانة أجهزة منزلية'; end if;
  end if;

  if n ~ '(برمج|تطبيق|مطور|تطوير|برنامج|موقع الكتروني|مواقع|ويب)' then return 'برمجة وتطبيقات'; end if;
  if n ~ '(رسم|رسوم|كاريكاتير)' then return 'رسم'; end if;
  if n ~ '(تصميم|جرافيك|شعار|لوغو|مونتاج)' then return 'تصميم وجرافيك'; end if;
  if n ~ 'تاكسي' or (n ~ 'سيار' and n ~ '(اجره|طلب|توصيل)') then return 'سيارة أجرة / طلب سيارة'; end if;
  if n ~ '(توصيل|دليفري|ديليفري)' then return 'توصيل'; end if;
  if n ~ 'معقب' then return 'تعقيب معاملات'; end if;
  if n ~ '(سباك|تمديد|معلم.*صحي|صحي.*معلم)' then return 'سباكة (معلم صحية)'; end if;
  if n ~ '(دهان|دهن|طلاء)' then return 'دهان'; end if;
  if n ~ 'كهرب' then return 'كهرباء'; end if;
  if n ~ 'نجار' then return 'نجارة'; end if;
  if n ~ 'حداد' then return 'حدادة'; end if;
  if n ~ '(بلاط|سيراميك|تبليط)' then return 'تبليط'; end if;
  if n ~ '(تنظيف|نظافه|جلي)' then return 'تنظيف'; end if;
  if n ~ '(تصوير|مصور|فوتوغراف)' then return 'تصوير'; end if;
  if n ~ '(خياط|تفصيل)' then return 'خياطة'; end if;
  if n ~ '(تكييف|مكيف|تبريد)' then return 'تكييف وتبريد'; end if;
  if n ~ '(اثاث|عتال|شحن|نقل)' then return 'نقل أثاث وشحن'; end if;

  -- بلا قاعدة: مجموعة بنفسها باسمها المطبَّع بعد حذف كلمات الطلب الشائعة (مفتاحها يبدأ بـ ~).
  s := regexp_replace(n, '(^| )(طلب|احتاج|محتاج|اريد|ابحث|عن|مع|في|على|من|الى|بدي|مطلوب|خدمه|توفير|لدي|ممكن|بحاجه)(?= |$)', '\1', 'g');
  s := regexp_replace(s, '(^| )ال(?=[^ ]{2,})', '\1', 'g');
  s := btrim(regexp_replace(s, ' +', ' ', 'g'));
  return '~' || coalesce(nullif(s, ''), n);
end;
$$;

create or replace function public.admin_services_stats(
  p_days integer default 30,
  p_region text default null,
  p_area text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz constant text := 'Asia/Damascus';
  v_regions constant text[] := array[
    'دمشق', 'حلب', 'حمص', 'حماه', 'اللاذقية', 'طرطوس', 'إدلب', 'درعا', 'السويداء',
    'القنيطرة', 'دير الزور', 'الرقة', 'الحسكة', 'اونلاين'
  ];
  v_top constant integer := 25;
  v_days integer := greatest(0, least(coalesce(p_days, 30), 3650));
  v_region text := nullif(btrim(coalesce(p_region, '')), '');
  v_area text := nullif(left(btrim(coalesce(p_area, '')), 60), '');
  v_area_none boolean := (nullif(left(btrim(coalesce(p_area, '')), 60), '') = '__none__');
  v_area_key text;
  v_local_now timestamp;
  v_since timestamptz;
  v_commission_max numeric;
  v_hide_below numeric;
  v_hide_min integer;
  v_result jsonb;
begin
  if v_region is not null and not (v_region = any (v_regions)) then
    raise exception 'invalid region';
  end if;
  if v_area is not null and v_region is null then
    raise exception 'area requires region';
  end if;
  v_area_key := case when v_area is null or v_area_none then null else public.admin_stats_area_key(v_area) end;
  if v_area is not null and not v_area_none and v_area_key is null then
    raise exception 'invalid area';
  end if;

  -- نفس تعريف بداية الفترة في admin_dashboard_stats، فتتطابق الإجماليات.
  v_local_now := now() at time zone v_tz;
  v_since := case
    when v_days = 0 then '-infinity'::timestamptz
    when v_days between 1 and 90 then date_trunc('day', v_local_now - make_interval(days => greatest(v_days - 1, 0))) at time zone v_tz
    else now() - make_interval(days => v_days)
  end;

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
  req0 as (
    select sr.id,
           sr.created_at,
           case when btrim(sr.region) = any (v_regions) then btrim(sr.region) end as region,
           nullif(btrim(sr.structured_data->>'service'), '') as raw_name,
           (sr.state::text in ('completed', 'active', 'completion_pending_rating')) as agreed,
           left(coalesce(
             nullif(btrim(case when jsonb_typeof(sr.structured_data->'service_area'->'areas') = 'array'
                               then sr.structured_data->'service_area'->'areas'->>0 end), ''),
             case when public.admin_stats_area_key(sr.structured_data->'service_area'->>'city')
                       is distinct from public.admin_stats_area_key(sr.region)
                  then nullif(btrim(sr.structured_data->'service_area'->>'city'), '') end
           ), 60) as area_raw
      from public.service_requests sr
  ),
  req1 as (
    select r.*,
           public.admin_stats_service_group(r.raw_name) as grp,
           case when r.region = 'اونلاين' then null else nullif(
             regexp_replace(public.admin_stats_area_key(r.area_raw), '^' || coalesce(public.admin_stats_area_key(r.region), '@@') || ' ', ''),
             coalesce(public.admin_stats_area_key(r.region), '@@')
           ) end as area_key
      from req0 r
  ),
  -- ---------------------------------------------------------------- مقدمو الخدمة (نفس شروط الظهور في المطابقة)
  prov as (
    select u.id,
           case when btrim(u.region) = any (v_regions) then btrim(u.region) end as region,
           (pp.user_id is not null) as has_profile,
           coalesce(pp.is_available, false) as is_available,
           coalesce(w.available_balance, 0) as balance,
           (u.rating_count >= v_hide_min and u.rating_avg < v_hide_below) as hidden_low_rating
      from public.users u
      left join public.provider_profiles pp on pp.user_id = u.id
      left join public.wallets w on w.user_id = u.id
     where not u.is_admin and u.is_provider and u.status = 'active' and u.deleted_at is null
  ),
  prov_state as (
    select p.id, p.region,
           case
             when not p.has_profile then 'no_profile'
             when not p.is_available then 'unavailable'
             when v_commission_max is not null and p.balance < v_commission_max then 'low_balance'
             when p.hidden_low_rating then 'hidden_low_rating'
             else 'searchable'
           end as search_state
      from prov p
  ),
  svc0 as (
    select ps.id as service_id,
           ps.provider_id,
           p.search_state,
           coalesce(nullif(btrim(ps.structured_data->>'service'), ''), nullif(btrim(ps.description), '')) as raw_name,
           coalesce(
             case when btrim(ps.structured_data->>'region') = any (v_regions) then btrim(ps.structured_data->>'region') end,
             p.region
           ) as region,
           left(coalesce(
             nullif(btrim(ps.structured_data->>'location'), ''),
             nullif(btrim(case when jsonb_typeof(ps.structured_data->'service_area'->'areas') = 'array'
                               then ps.structured_data->'service_area'->'areas'->>0 end), ''),
             nullif(btrim(ps.structured_data->'service_area'->>'city'), '')
           ), 60) as area_raw
      from public.provider_services ps
      join prov_state p on p.id = ps.provider_id
     where ps.is_active
  ),
  svc1 as (
    select s.*,
           public.admin_stats_service_group(s.raw_name) as grp,
           case when s.region = 'اونلاين' then null else nullif(
             regexp_replace(public.admin_stats_area_key(s.area_raw), '^' || coalesce(public.admin_stats_area_key(s.region), '@@') || ' ', ''),
             coalesce(public.admin_stats_area_key(s.region), '@@')
           ) end as area_key
      from svc0 s
  ),
  -- ---------------------------------------------------------------- نطاق العرض (الفترة، ثم المحافظة، ثم المنطقة)
  req_region as (
    select * from req1 where created_at >= v_since and (v_region is null or region = v_region)
  ),
  req_scope as (
    select * from req_region
     where v_area is null or (v_area_none and area_key is null) or (not v_area_none and area_key = v_area_key)
  ),
  svc_region as (
    select * from svc1 where v_region is null or region = v_region
  ),
  svc_scope as (
    select * from svc_region
     where v_area is null or (v_area_none and area_key is null) or (not v_area_none and area_key = v_area_key)
  ),
  -- اسم العرض لكل مجموعة: اسم القاعدة نفسه، أو أشيع اسم أصلي للمجموعات بلا قاعدة.
  name_counts as (
    select x.grp, x.raw_name, count(*) as n
      from (
        select grp, raw_name from req_scope where grp is not null
        union all
        select grp, raw_name from svc_scope where grp is not null
      ) x
     group by x.grp, x.raw_name
  ),
  labels as (
    select distinct on (nc.grp) nc.grp,
           case when nc.grp like '~%' then nc.raw_name else nc.grp end as label
      from name_counts nc
     order by nc.grp, nc.n desc, nc.raw_name
  ),
  demand as (
    select r.grp, count(*) as requests, count(*) filter (where r.agreed) as agreed
      from req_scope r where r.grp is not null group by r.grp
  ),
  supply as (
    select s.grp,
           count(distinct s.provider_id) as providers,
           count(distinct s.provider_id) filter (where s.search_state = 'searchable') as searchable,
           count(*) as services
      from svc_scope s where s.grp is not null group by s.grp
  ),
  demand_ranked as (
    select d.grp, d.requests, d.agreed,
           coalesce(su.providers, 0) as providers, coalesce(su.searchable, 0) as searchable,
           row_number() over (order by d.requests desc, d.grp) as rn
      from demand d left join supply su on su.grp = d.grp
  ),
  supply_ranked as (
    select su.grp, su.providers, su.searchable, su.services, coalesce(d.requests, 0) as requests,
           row_number() over (order by su.providers desc, su.services desc, su.grp) as rn
      from supply su left join demand d on d.grp = su.grp
  ),
  -- ---------------------------------------------------------------- خيارات الفلاتر (كل التاريخ، لا تتأثر بالفترة)
  opt_rows as (
    select region, area_key, area_raw from req1 where region is not null
    union all
    select region, area_key, area_raw from svc1 where region is not null
  ),
  opt_regions as (
    select region, count(*) as n from opt_rows group by region
  ),
  opt_area_names as (
    select region, area_key, area_raw, count(*) as n
      from opt_rows where area_key is not null group by region, area_key, area_raw
  ),
  opt_areas as (
    select distinct on (region, area_key) region, area_key, area_raw as name,
           sum(n) over (partition by region, area_key) as total
      from opt_area_names
     order by region, area_key, n desc, area_raw
  )
  select jsonb_build_object(
    'meta', jsonb_build_object('generated_at', now(), 'days', v_days, 'region', v_region, 'area', v_area),
    'filters', jsonb_build_object('regions', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'name', o.region,
               'n', o.n,
               'areas', (
                 select coalesce(jsonb_agg(jsonb_build_object('name', a.name, 'n', a.total) order by a.total desc, a.name), '[]'::jsonb)
                   from opt_areas a where a.region = o.region
               )
             ) order by o.n desc, o.region), '[]'::jsonb)
        from opt_regions o
    )),
    'coverage', jsonb_build_object(
      'requests', (select count(*) from req_region),
      'requests_unnamed', (select count(*) from req_region where grp is null),
      'requests_with_area', (select count(*) from req_region where area_key is not null),
      'services', (select count(*) from svc_region),
      'services_with_area', (select count(*) from svc_region where area_key is not null)
    ),
    'scope', jsonb_build_object(
      'requests', (select count(*) from req_scope),
      'requests_named', (select count(*) from req_scope where grp is not null),
      'services', (select count(*) from svc_scope),
      'providers', (select count(distinct provider_id) from svc_scope)
    ),
    'demand', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'service', l.label,
               'requests', d.requests,
               'agreed', d.agreed,
               'providers', d.providers,
               'searchable', d.searchable,
               'variants', (
                 select coalesce(jsonb_agg(jsonb_build_object('name', v.raw_name, 'n', v.n) order by v.n desc, v.raw_name), '[]'::jsonb)
                   from (
                     select r.raw_name, count(*) as n from req_scope r
                      where r.grp = d.grp and r.raw_name is not null
                      group by r.raw_name order by count(*) desc, r.raw_name limit 6
                   ) v
               )
             ) order by d.rn), '[]'::jsonb)
        from demand_ranked d join labels l on l.grp = d.grp
       where d.rn <= v_top
    ),
    'demand_other', (
      select jsonb_build_object('groups', count(*), 'requests', coalesce(sum(requests), 0))
        from demand_ranked where rn > v_top
    ),
    'supply', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'service', l.label,
               'providers', s.providers,
               'searchable', s.searchable,
               'services', s.services,
               'requests', s.requests,
               'variants', (
                 select coalesce(jsonb_agg(jsonb_build_object('name', v.raw_name, 'n', v.n) order by v.n desc, v.raw_name), '[]'::jsonb)
                   from (
                     select x.raw_name, count(*) as n from svc_scope x
                      where x.grp = s.grp and x.raw_name is not null
                      group by x.raw_name order by count(*) desc, x.raw_name limit 6
                   ) v
               )
             ) order by s.rn), '[]'::jsonb)
        from supply_ranked s join labels l on l.grp = s.grp
       where s.rn <= v_top
    ),
    'supply_other', (
      select jsonb_build_object('groups', count(*), 'providers', coalesce(sum(providers), 0))
        from supply_ranked where rn > v_top
    )
  ) into v_result;

  return v_result;
end;
$$;

-- لا يُستدعى إلا من الخادم (Cloudflare Function) بمفتاح service_role.
revoke all on function public.admin_stats_norm_text(text) from public, anon, authenticated;
revoke all on function public.admin_stats_area_key(text) from public, anon, authenticated;
revoke all on function public.admin_stats_service_group(text) from public, anon, authenticated;
revoke all on function public.admin_services_stats(integer, text, text) from public, anon, authenticated;
grant execute on function public.admin_services_stats(integer, text, text) to service_role;
