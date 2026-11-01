-- Enforce TOTP MFA for dashboard access.
-- The owner account was verified to have an enrolled, verified TOTP factor before applying.
update public.app_settings
set value = 'true'::jsonb
where key = 'dashboard_require_mfa';

do $$
begin
  if not exists (
    select 1 from public.app_settings
    where key = 'dashboard_require_mfa' and value = 'true'::jsonb
  ) then
    raise exception 'Dashboard MFA setting was not enabled';
  end if;
end
$$;
