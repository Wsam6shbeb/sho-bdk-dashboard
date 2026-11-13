-- Jobs section: dashboard (admin) functions. Same pattern as admin_*:
-- support = moderation (hide/restore/delete jobs, handle reports),
-- owner   = ads, blocked words, settings.

create or replace function public._job_clean_note(p_text text, p_max int default 200)
returns text
language sql immutable
set search_path = public, pg_temp
as $f$
  select left(nullif(btrim(coalesce(p_text, '')), ''), p_max);
$f$;

create or replace function public._job_audit(p_action text, p_entity_type text, p_entity_id uuid, p_metadata jsonb)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $f$
begin
  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), p_action, p_entity_type, p_entity_id, p_metadata);
end;
$f$;

-- ---------- jobs ----------
create or replace function public.admin_list_jobs(
  p_status text default null, p_q text default null, p_limit int default 30, p_offset int default 0)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $f$
declare
  v_limit int := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_q text := nullif(btrim(coalesce(p_q, '')), '');
  v_like text;
  v_result jsonb;
begin
  perform public._require_admin();
  if p_status is not null and p_status not in ('active', 'closed', 'hidden', 'expired') then
    raise exception 'INVALID_STATUS' using errcode = '22023';
  end if;
  v_like := case when v_q is null then null
                 else '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  with filtered as (
    select j.* from public.job_posts j
     where (p_status is null
            or (p_status = 'active' and j.status = 'active' and j.expires_at > now())
            or (p_status = 'expired' and j.status = 'active' and j.expires_at <= now())
            or (p_status in ('closed', 'hidden') and j.status = p_status))
       and (v_like is null
            or j.title ilike v_like or j.description ilike v_like
            or j.region ilike v_like or coalesce(j.area, '') ilike v_like)
  ), page as (
    select f.*, u.full_name as user_name,
           (select count(*) from public.job_reports r where r.job_id = f.id and r.status = 'open') as open_reports
      from filtered f
      join public.users u on u.id = f.user_id
     order by f.created_at desc
     limit v_limit offset v_offset
  )
  select jsonb_build_object(
           'total', (select count(*) from filtered),
           'items', coalesce((select jsonb_agg(to_jsonb(page) order by page.created_at desc) from page), '[]'::jsonb))
    into v_result;
  return v_result;
end;
$f$;

create or replace function public.admin_set_job_status(p_job_id uuid, p_status text, p_reason text default null)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $f$
declare
  v_job public.job_posts;
  v_reason text := public._job_clean_note(p_reason);
begin
  perform public._require_admin();
  if p_status is null or p_status not in ('active', 'hidden', 'closed') then
    raise exception 'INVALID_STATUS' using errcode = '22023';
  end if;

  select * into v_job from public.job_posts where id = p_job_id for update;
  if not found then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.job_posts
     set status = p_status,
         hidden_reason = case when p_status = 'hidden' then coalesce(v_reason, 'admin') else null end
   where id = p_job_id;

  -- restoring a job closes its open reports, otherwise the next report would hide it again at once
  if p_status = 'active' then
    update public.job_reports set status = 'dismissed' where job_id = p_job_id and status = 'open';
  end if;

  perform public._job_audit('admin_set_job_status', 'job_post', p_job_id,
    jsonb_build_object('from', v_job.status, 'to', p_status, 'reason', v_reason));
  return jsonb_build_object('job_id', p_job_id, 'status', p_status);
end;
$f$;

create or replace function public.admin_delete_job(p_job_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $f$
declare
  v_job public.job_posts;
begin
  perform public._require_admin();
  select * into v_job from public.job_posts where id = p_job_id for update;
  if not found then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform public._job_audit('admin_delete_job', 'job_post', p_job_id,
    jsonb_build_object('title', v_job.title, 'owner_id', v_job.user_id, 'region', v_job.region,
                       'status', v_job.status, 'reason', public._job_clean_note(p_reason)));
  delete from public.job_posts where id = p_job_id;
  return jsonb_build_object('job_id', p_job_id, 'deleted', true);
end;
$f$;

-- ---------- reports ----------
create or replace function public.admin_list_job_reports(
  p_status text default 'open', p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $f$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_result jsonb;
begin
  perform public._require_admin();
  if p_status is not null and p_status not in ('open', 'resolved', 'dismissed') then
    raise exception 'INVALID_STATUS' using errcode = '22023';
  end if;

  with filtered as (
    select r.* from public.job_reports r where p_status is null or r.status = p_status
  ), page as (
    select f.id, f.reason, f.details, f.status, f.created_at,
           f.reporter_id, ru.full_name as reporter_name,
           j.id as job_id, j.title as job_title, j.status as job_status, j.region as job_region,
           j.user_id as job_owner_id, ou.full_name as job_owner_name
      from filtered f
      join public.job_posts j on j.id = f.job_id
      join public.users ru on ru.id = f.reporter_id
      join public.users ou on ou.id = j.user_id
     order by f.created_at desc
     limit v_limit offset v_offset
  )
  select jsonb_build_object(
           'total', (select count(*) from filtered),
           'items', coalesce((select jsonb_agg(to_jsonb(page) order by page.created_at desc) from page), '[]'::jsonb))
    into v_result;
  return v_result;
end;
$f$;

create or replace function public.admin_resolve_job_report(p_report_id uuid, p_action text, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $f$
declare
  v_r public.job_reports;
  v_job public.job_posts;
  v_note text := public._job_clean_note(p_note);
begin
  perform public._require_admin();
  if p_action is null or p_action not in ('hide_job', 'delete_job', 'dismiss') then
    raise exception 'INVALID_ACTION' using errcode = '22023';
  end if;

  select * into v_r from public.job_reports where id = p_report_id for update;
  if not found then
    raise exception 'REPORT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_r.status <> 'open' then
    raise exception 'ALREADY_RESOLVED' using errcode = 'P0001';
  end if;

  if p_action = 'dismiss' then
    update public.job_reports set status = 'dismissed' where id = p_report_id;
  elsif p_action = 'hide_job' then
    update public.job_posts
       set status = 'hidden', hidden_reason = coalesce(v_note, 'report')
     where id = v_r.job_id and status <> 'hidden';
    update public.job_reports set status = 'resolved' where job_id = v_r.job_id and status = 'open';
  else
    select * into v_job from public.job_posts where id = v_r.job_id;
    perform public._job_audit('admin_delete_job', 'job_post', v_r.job_id,
      jsonb_build_object('title', v_job.title, 'owner_id', v_job.user_id, 'region', v_job.region,
                         'status', v_job.status, 'reason', coalesce(v_note, 'report'), 'report_id', p_report_id));
    delete from public.job_posts where id = v_r.job_id;
  end if;

  perform public._job_audit('admin_resolve_job_report', 'job_report', p_report_id,
    jsonb_build_object('action', p_action, 'job_id', v_r.job_id, 'note', v_note));
  return jsonb_build_object('report_id', p_report_id, 'action', p_action);
end;
$f$;

-- ---------- ads ----------
create or replace function public.admin_list_job_ads()
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $f$
begin
  perform public._require_admin();
  return coalesce((
    select jsonb_agg(to_jsonb(t) order by t.priority desc, t.created_at desc)
      from (
        select a.id, a.title, a.image_url, a.link_url, a.is_active, a.starts_at, a.ends_at,
               a.priority, a.impressions, a.clicks, a.created_at,
               (a.is_active
                and (a.starts_at is null or a.starts_at <= now())
                and (a.ends_at is null or a.ends_at > now())) as is_live
          from public.job_ads a) t), '[]'::jsonb);
end;
$f$;

create or replace function public.admin_upsert_job_ad(
  p_title text, p_image_url text, p_link_url text default null, p_is_active boolean default true,
  p_starts_at timestamptz default null, p_ends_at timestamptz default null,
  p_priority int default 0, p_id uuid default null)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $f$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_image text := btrim(coalesce(p_image_url, ''));
  v_link text := nullif(btrim(coalesce(p_link_url, '')), '');
  v_ad public.job_ads;
begin
  perform public._require_owner();
  if char_length(v_title) not between 1 and 80 then
    raise exception 'INVALID_TITLE' using errcode = '22023';
  end if;
  if char_length(v_image) > 500 or v_image !~* '^https://[^\s]+$' then
    raise exception 'INVALID_IMAGE_URL' using errcode = '22023';
  end if;
  if v_link is not null and (char_length(v_link) > 500 or v_link !~* '^https?://[^\s]+$') then
    raise exception 'INVALID_LINK_URL' using errcode = '22023';
  end if;
  if p_starts_at is not null and p_ends_at is not null and p_ends_at <= p_starts_at then
    raise exception 'INVALID_DATES' using errcode = '22023';
  end if;
  if coalesce(p_priority, 0) not between -1000 and 1000 then
    raise exception 'INVALID_PRIORITY' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.job_ads (title, image_url, link_url, is_active, starts_at, ends_at, priority)
    values (v_title, v_image, v_link, coalesce(p_is_active, true), p_starts_at, p_ends_at, coalesce(p_priority, 0))
    returning * into v_ad;
  else
    update public.job_ads
       set title = v_title, image_url = v_image, link_url = v_link,
           is_active = coalesce(p_is_active, true), starts_at = p_starts_at, ends_at = p_ends_at,
           priority = coalesce(p_priority, 0)
     where id = p_id
    returning * into v_ad;
    if not found then
      raise exception 'AD_NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  perform public._job_audit(case when p_id is null then 'admin_create_job_ad' else 'admin_update_job_ad' end,
    'job_ad', v_ad.id, jsonb_build_object('title', v_ad.title, 'is_active', v_ad.is_active));
  return to_jsonb(v_ad);
end;
$f$;

create or replace function public.admin_delete_job_ad(p_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $f$
declare
  v_ad public.job_ads;
begin
  perform public._require_owner();
  delete from public.job_ads where id = p_id returning * into v_ad;
  if not found then
    raise exception 'AD_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform public._job_audit('admin_delete_job_ad', 'job_ad', p_id, jsonb_build_object('title', v_ad.title));
  return jsonb_build_object('id', p_id, 'deleted', true);
end;
$f$;

-- ---------- blocked words ----------
create or replace function public.admin_list_job_blocked_words()
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $f$
begin
  perform public._require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', w.id, 'word', w.word, 'whole_word', w.whole_word,
                                        'created_at', w.created_at) order by w.created_at desc)
      from public.job_blocked_words w), '[]'::jsonb);
end;
$f$;

create or replace function public.admin_add_job_blocked_word(p_word text, p_whole_word boolean default false)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $f$
declare
  v_word text := btrim(coalesce(p_word, ''));
  v_id uuid;
begin
  perform public._require_owner();
  if char_length(v_word) not between 2 and 60 or char_length(public.job_normalize_text(v_word)) < 2 then
    raise exception 'WORD_TOO_SHORT' using errcode = '22023';
  end if;
  if exists (select 1 from public.job_blocked_words w
              where public.job_normalize_text(w.word) = public.job_normalize_text(v_word)) then
    raise exception 'WORD_EXISTS' using errcode = 'P0001';
  end if;

  insert into public.job_blocked_words (word, whole_word)
  values (v_word, coalesce(p_whole_word, false))
  returning id into v_id;

  perform public._job_audit('admin_add_job_blocked_word', 'job_blocked_word', v_id,
    jsonb_build_object('whole_word', coalesce(p_whole_word, false)));
  return jsonb_build_object('id', v_id, 'word', v_word, 'whole_word', coalesce(p_whole_word, false));
end;
$f$;

create or replace function public.admin_delete_job_blocked_word(p_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $f$
begin
  perform public._require_owner();
  delete from public.job_blocked_words where id = p_id;
  if not found then
    raise exception 'WORD_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform public._job_audit('admin_delete_job_blocked_word', 'job_blocked_word', p_id, '{}'::jsonb);
  return jsonb_build_object('id', p_id, 'deleted', true);
end;
$f$;

-- ---------- settings and stats ----------
create or replace function public.admin_get_jobs_settings()
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $f$
begin
  perform public._require_admin();
  return jsonb_build_object(
    'jobs_enabled', coalesce((select (value)::text::boolean from public.app_settings where key = 'jobs_enabled'), false),
    'jobs_ad_every_n', public._job_setting_int('jobs_ad_every_n', 5),
    'jobs_max_active_per_user', public._job_setting_int('jobs_max_active_per_user', 5),
    'jobs_expiry_days', public._job_setting_int('jobs_expiry_days', 30),
    'jobs_report_auto_hide_threshold', public._job_setting_int('jobs_report_auto_hide_threshold', 3));
end;
$f$;

-- null = leave unchanged
create or replace function public.admin_set_jobs_settings(
  p_enabled boolean default null, p_ad_every_n int default null, p_max_active int default null,
  p_expiry_days int default null, p_report_threshold int default null)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $f$
begin
  perform public._require_owner();
  if (p_ad_every_n is not null and p_ad_every_n not between 2 and 20)
     or (p_max_active is not null and p_max_active not between 1 and 50)
     or (p_expiry_days is not null and p_expiry_days not between 1 and 365)
     or (p_report_threshold is not null and p_report_threshold not between 0 and 50) then
    raise exception 'INVALID_SETTING' using errcode = '22023';
  end if;

  if p_enabled is not null then
    insert into public.app_settings (key, value) values ('jobs_enabled', to_jsonb(p_enabled))
    on conflict (key) do update set value = excluded.value;
  end if;
  if p_ad_every_n is not null then
    insert into public.app_settings (key, value) values ('jobs_ad_every_n', to_jsonb(p_ad_every_n))
    on conflict (key) do update set value = excluded.value;
  end if;
  if p_max_active is not null then
    insert into public.app_settings (key, value) values ('jobs_max_active_per_user', to_jsonb(p_max_active))
    on conflict (key) do update set value = excluded.value;
  end if;
  if p_expiry_days is not null then
    insert into public.app_settings (key, value) values ('jobs_expiry_days', to_jsonb(p_expiry_days))
    on conflict (key) do update set value = excluded.value;
  end if;
  if p_report_threshold is not null then
    insert into public.app_settings (key, value) values ('jobs_report_auto_hide_threshold', to_jsonb(p_report_threshold))
    on conflict (key) do update set value = excluded.value;
  end if;

  perform public._job_audit('admin_set_jobs_settings', 'app_settings', null,
    jsonb_strip_nulls(jsonb_build_object('enabled', p_enabled, 'ad_every_n', p_ad_every_n,
      'max_active', p_max_active, 'expiry_days', p_expiry_days, 'report_threshold', p_report_threshold)));
  return public.admin_get_jobs_settings();
end;
$f$;

create or replace function public.admin_jobs_stats()
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $f$
begin
  perform public._require_admin();
  return jsonb_build_object(
    'active', (select count(*) from public.job_posts where status = 'active' and expires_at > now()),
    'expired', (select count(*) from public.job_posts where status = 'active' and expires_at <= now()),
    'closed', (select count(*) from public.job_posts where status = 'closed'),
    'hidden', (select count(*) from public.job_posts where status = 'hidden'),
    'open_reports', (select count(*) from public.job_reports where status = 'open'),
    'ads_live', (select count(*) from public.job_ads
                  where is_active and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now())),
    'ads_total', (select count(*) from public.job_ads),
    'impressions', (select coalesce(sum(impressions), 0) from public.job_ads),
    'clicks', (select coalesce(sum(clicks), 0) from public.job_ads));
end;
$f$;

-- ---------- privileges ----------
revoke all on function public._job_clean_note(text, int) from public, anon, authenticated;
revoke all on function public._job_audit(text, text, uuid, jsonb) from public, anon, authenticated;

revoke all on function public.admin_list_jobs(text, text, int, int) from public, anon;
revoke all on function public.admin_set_job_status(uuid, text, text) from public, anon;
revoke all on function public.admin_delete_job(uuid, text) from public, anon;
revoke all on function public.admin_list_job_reports(text, int, int) from public, anon;
revoke all on function public.admin_resolve_job_report(uuid, text, text) from public, anon;
revoke all on function public.admin_list_job_ads() from public, anon;
revoke all on function public.admin_upsert_job_ad(text, text, text, boolean, timestamptz, timestamptz, int, uuid) from public, anon;
revoke all on function public.admin_delete_job_ad(uuid) from public, anon;
revoke all on function public.admin_list_job_blocked_words() from public, anon;
revoke all on function public.admin_add_job_blocked_word(text, boolean) from public, anon;
revoke all on function public.admin_delete_job_blocked_word(uuid) from public, anon;
revoke all on function public.admin_get_jobs_settings() from public, anon;
revoke all on function public.admin_set_jobs_settings(boolean, int, int, int, int) from public, anon;
revoke all on function public.admin_jobs_stats() from public, anon;

grant execute on function public.admin_list_jobs(text, text, int, int) to authenticated;
grant execute on function public.admin_set_job_status(uuid, text, text) to authenticated;
grant execute on function public.admin_delete_job(uuid, text) to authenticated;
grant execute on function public.admin_list_job_reports(text, int, int) to authenticated;
grant execute on function public.admin_resolve_job_report(uuid, text, text) to authenticated;
grant execute on function public.admin_list_job_ads() to authenticated;
grant execute on function public.admin_upsert_job_ad(text, text, text, boolean, timestamptz, timestamptz, int, uuid) to authenticated;
grant execute on function public.admin_delete_job_ad(uuid) to authenticated;
grant execute on function public.admin_list_job_blocked_words() to authenticated;
grant execute on function public.admin_add_job_blocked_word(text, boolean) to authenticated;
grant execute on function public.admin_delete_job_blocked_word(uuid) to authenticated;
grant execute on function public.admin_get_jobs_settings() to authenticated;
grant execute on function public.admin_set_jobs_settings(boolean, int, int, int, int) to authenticated;
grant execute on function public.admin_jobs_stats() to authenticated;

notify pgrst, 'reload schema';
