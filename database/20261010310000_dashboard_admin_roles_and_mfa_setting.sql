-- Already applied to the live Supabase project (the app repo's token was no longer available to save it there;
-- copy this file to supabase/migrations/ of the app repo to keep both repos in sync).
--
-- Dashboard administration: roles stored in the database (not in an environment variable) and an optional
-- "require MFA" switch. Normal users cannot change either (no column-level UPDATE grant for authenticated).

alter table public.users
  add column if not exists admin_role text
  check (admin_role is null or admin_role in ('owner', 'support'));

comment on column public.users.admin_role is
  'Dashboard role for users with is_admin = true: owner (everything) or support (read-only). NULL is treated as owner.';

insert into public.app_settings (key, value)
values ('dashboard_require_mfa', 'false'::jsonb)
on conflict (key) do nothing;
