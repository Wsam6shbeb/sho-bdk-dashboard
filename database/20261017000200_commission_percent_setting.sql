-- Already applied to the live Supabase project (copy to supabase/migrations/ of the app repo to keep both in sync).
-- The commission percentage (previously hard-coded as 5% inside request_agreement) becomes a setting the dashboard can change.
-- commission = clamp(price * percent / 100, commission_min, commission_max). Existing agreements keep the commission they were created with.

insert into public.app_settings (key, value)
values ('commission_percent', '5'::jsonb)
on conflict (key) do nothing;

do $$
declare
  d text;
begin
  select pg_get_functiondef(p.oid) into d
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'request_agreement';

  if position('round(p_price * 0.05)' in d) = 0 then
    raise exception 'request_agreement definition changed; update this migration';
  end if;

  d := replace(d,
    'round(p_price * 0.05)',
    'round(p_price * coalesce((select (value)::text::numeric from app_settings where key = ''commission_percent''), 5) / 100)');

  execute d;
end;
$$;
