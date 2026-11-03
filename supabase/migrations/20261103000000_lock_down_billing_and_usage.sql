-- Security fixes for the April schema (found 2026-11-03 by Supabase advisors + review).
-- Safe to run more than once.

begin;

-- 1. CRITICAL: users could UPDATE their own profile row with no column limits,
--    so anyone signed in could set is_premium = true or tier = 'business' for free.
--    Billing fields must only change from the server (Stripe webhook, service role).
drop policy if exists "Users can update own profile" on public.profiles;

-- 2. Same hole via INSERT: a user without a profile row could insert one with
--    is_premium = true. Profiles are created by the on_auth_user_created trigger instead.
drop policy if exists "Users can insert own profile" on public.profiles;

-- 3. Usage functions were SECURITY DEFINER and callable by anyone (even signed out)
--    with ANY user id: strangers could burn another user's monthly quota or read their usage.
--    Only the server (service_role) may call them now.
revoke execute on function public.increment_usage(uuid, text, bigint) from public, anon, authenticated;
revoke execute on function public.get_current_month_usage(uuid)       from public, anon, authenticated;
revoke execute on function public.get_total_usage(uuid)               from public, anon, authenticated;
revoke execute on function public.handle_new_user()                   from public, anon, authenticated;
revoke execute on function public.rls_auto_enable()                   from public, anon, authenticated;
grant  execute on function public.increment_usage(uuid, text, bigint) to service_role;
grant  execute on function public.get_current_month_usage(uuid)       to service_role;
grant  execute on function public.get_total_usage(uuid)               to service_role;

-- 4. Pin search_path on SECURITY DEFINER functions (prevents object-shadowing attacks).
alter function public.handle_new_user()                   set search_path = public, pg_temp;
alter function public.increment_usage(uuid, text, bigint) set search_path = public, pg_temp;
alter function public.get_current_month_usage(uuid)       set search_path = public, pg_temp;
alter function public.get_total_usage(uuid)               set search_path = public, pg_temp;

-- 5. Users who signed up before the trigger existed have no profile row. Backfill them.
insert into public.profiles (id, email)
select u.id, u.email from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null;

commit;
