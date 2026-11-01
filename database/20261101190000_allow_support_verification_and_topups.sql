-- Allow the explicitly assigned dashboard support role to review verifications
-- and perform audited manual wallet top-ups, without granting owner permissions.

create or replace function public._require_dashboard_operator()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_mfa_count integer;
  v_mfa_enabled boolean;
begin
  if auth.uid() is null or not exists (
    select 1
    from public.users u
    where u.id = auth.uid()
      and u.is_admin = true
      and u.admin_role in ('owner', 'support')
      and u.deleted_at is null
      and coalesce(u.status, 'active') = 'active'
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select count(*), coalesce(bool_and(value = 'true'::jsonb), false)
    into v_mfa_count, v_mfa_enabled
  from public.app_settings
  where key = 'dashboard_require_mfa';

  if v_mfa_count <> 1
     or not v_mfa_enabled
     or coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
    raise exception 'MFA_REQUIRED' using errcode = '42501';
  end if;
end;
$function$;

revoke all on function public._require_dashboard_operator() from public, anon, authenticated;

create or replace function public.admin_topup_wallet(
  p_user uuid,
  p_amount numeric,
  p_reason text,
  p_request_id uuid,
  p_sham_cash_transaction_id text,
  p_thank_you_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_max numeric;
  v_wallet public.wallets;
  v_new numeric;
  v_reference uuid := gen_random_uuid();
  v_ledger uuid;
  v_existing public.ledger_entries;
  v_idempotency_key text;
  v_transaction_id text := upper(btrim(coalesce(p_sham_cash_transaction_id, '')));
  v_thank_you text := nullif(btrim(coalesce(p_thank_you_message, '')), '');
begin
  perform public._require_dashboard_operator();

  if p_user is null then raise exception 'USER_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_amount is null or p_amount <= 0 or trunc(p_amount) <> p_amount then
    raise exception 'INVALID_AMOUNT' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 or length(btrim(p_reason)) > 300 then
    raise exception 'REASON_REQUIRED' using errcode = 'P0001';
  end if;
  if p_request_id is null then raise exception 'REQUEST_ID_REQUIRED' using errcode = 'P0001'; end if;
  if length(v_transaction_id) < 4 or length(v_transaction_id) > 100
     or v_transaction_id !~ '^[A-Z0-9-]+$' then
    raise exception 'INVALID_SHAM_CASH_TRANSACTION_ID' using errcode = 'P0001';
  end if;

  v_max := coalesce(
    (select (value)::text::numeric from public.app_settings where key = 'admin_adjust_wallet_max'),
    100000
  );
  if p_amount > v_max then raise exception 'AMOUNT_TOO_LARGE' using errcode = 'P0001'; end if;

  if not exists (
    select 1 from public.users
    where id = p_user and status = 'active' and deleted_at is null and is_admin = false
  ) then raise exception 'USER_NOT_ELIGIBLE' using errcode = 'P0001'; end if;

  select * into v_wallet from public.wallets where user_id = p_user for update;
  if not found then raise exception 'WALLET_NOT_FOUND' using errcode = 'P0002'; end if;

  v_idempotency_key := 'manual_topup_' || p_request_id::text;
  select * into v_existing from public.ledger_entries
  where idempotency_key = v_idempotency_key for update;
  if found then
    return jsonb_build_object(
      'user_id', p_user, 'amount', v_existing.amount,
      'balance_after', v_existing.balance_after, 'ledger_id', v_existing.id,
      'already_processed', true
    );
  end if;

  v_new := v_wallet.available_balance + p_amount;
  update public.wallets set available_balance = v_new, updated_at = now()
  where user_id = p_user;

  begin
    insert into public.ledger_entries (
      user_id, entry_type, amount, currency, balance_after,
      reference_type, reference_id, idempotency_key, created_by,
      sham_cash_transaction_id
    ) values (
      p_user, 'topup_credit'::public.ledger_entry_type, p_amount, v_wallet.currency, v_new,
      'manual_topup', v_reference, v_idempotency_key, auth.uid(),
      v_transaction_id
    ) returning id into v_ledger;
  exception when unique_violation then
    raise exception 'DUPLICATE_SHAM_CASH_TRANSACTION' using errcode = 'P0001';
  end;

  insert into public.notifications (user_id, type, payload)
  values (
    p_user, 'wallet_topup',
    jsonb_build_object(
      'title', 'تمت إضافة رصيد',
      'body', coalesce(v_thank_you, 'شكراً لثقتك بنا! تمت إضافة رصيدك بنجاح.'),
      'amount', p_amount, 'balance_after', v_new,
      'route', '/(drawer)/(tabs)/wallet'
    )
  );

  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (
    auth.uid(), 'admin_topup_wallet', 'user', p_user,
    jsonb_build_object(
      'amount', p_amount, 'balance_after', v_new,
      'reason', btrim(p_reason), 'ledger_id', v_ledger,
      'sham_cash_transaction_id', v_transaction_id
    )
  );

  return jsonb_build_object(
    'user_id', p_user, 'amount', p_amount, 'balance_after', v_new,
    'ledger_id', v_ledger, 'already_processed', false
  );
end;
$function$;

-- This RPC is invoked only by the authenticated dashboard API using its service-role
-- credential. Validate the real admin row explicitly because the service-role JWT
-- does not carry the dashboard user's auth.uid().
create or replace function public.decide_verification(
  p_id uuid,
  p_decision text,
  p_reason text,
  p_admin uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v public.verifications;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_admin is null or not exists (
    select 1
    from public.users u
    where u.id = p_admin
      and u.is_admin = true
      and u.admin_role in ('owner', 'support')
      and u.deleted_at is null
      and coalesce(u.status, 'active') = 'active'
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if p_decision not in ('approved', 'rejected') then
    raise exception 'INVALID_DECISION' using errcode = 'P0001';
  end if;
  if p_decision = 'rejected' and v_reason is null then
    raise exception 'REASON_REQUIRED' using errcode = 'P0001';
  end if;

  select * into v from public.verifications where id = p_id for update;
  if not found then
    raise exception 'VERIFICATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v.status <> 'pending' then
    raise exception 'ALREADY_DECIDED' using errcode = 'P0001';
  end if;

  update public.verifications
     set status = p_decision::public.verification_status,
         rejection_reason = case when p_decision = 'rejected' then v_reason else null end,
         reviewed_by = p_admin,
         reviewed_at = now()
   where id = p_id;

  update public.users
     set verification_status = p_decision::public.verification_status
   where id = v.user_id;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (p_admin, 'admin_decide_verification', 'verification', p_id,
          jsonb_build_object('decision', p_decision, 'user_id', v.user_id, 'reason', v_reason));

  perform public._notify(
    v.user_id,
    case when p_decision = 'approved' then 'verification_approved' else 'verification_rejected' end,
    case when p_decision = 'approved' then 'تم توثيق حسابك' else 'تعذّر توثيق حسابك' end,
    case when p_decision = 'approved'
         then 'أصبح حسابك موثّقاً وتظهر شارة التوثيق للآخرين.'
         else v_reason end,
    jsonb_build_object('route', '/orders/verify-account', 'reference_id', p_id)
  );

  return jsonb_build_object('id', p_id, 'user_id', v.user_id, 'status', p_decision);
end;
$function$;

revoke all on function public.decide_verification(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.decide_verification(uuid, text, text, uuid) to service_role;

-- Keep the top-up RPC available to authenticated dashboard sessions; its body now
-- enforces an active owner/support row and mandatory AAL2 before changing balances.
grant execute on function public.admin_topup_wallet(uuid, numeric, text, uuid, text, text) to authenticated;
