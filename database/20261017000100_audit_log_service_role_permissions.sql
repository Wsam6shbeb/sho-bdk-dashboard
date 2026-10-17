-- Minimal privileges required by the dashboard's server-side audit endpoints.
-- The service role key must remain a Cloudflare secret and must never be exposed to browsers.
grant select, insert on table public.audit_log to service_role;
