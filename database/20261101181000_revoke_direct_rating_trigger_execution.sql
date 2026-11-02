-- Trigger functions are executed by PostgreSQL through their attached triggers.
-- Prevent direct RPC invocation by API roles; this does not disable the trigger itself.
revoke all on function public.ratings_refresh_user_rating() from public;
revoke all on function public.ratings_refresh_user_rating() from anon;
revoke all on function public.ratings_refresh_user_rating() from authenticated;
