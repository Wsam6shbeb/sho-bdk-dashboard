-- A support administrator must not resolve reports or issue commission refunds.
-- Keep the full decision and refund logic unchanged; strengthen only the required role.
create or replace function public.admin_resolve_report(
  p_report_id uuid,
  p_refund boolean,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_r public.reports;
  v_ag public.agreements;
  v_balance numeric;
  v_refunded boolean := false;
begin
  perform public._require_owner();

  select * into v_r from public.reports where id = p_report_id for update;
  if not found then
    raise exception 'REPORT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_r.status in ('resolved', 'dismissed') then
    raise exception 'ALREADY_RESOLVED' using errcode = 'P0001';
  end if;

  if p_refund then
    select * into v_ag from public.agreements a where a.request_id = v_r.request_id order by a.created_at desc limit 1;
    if not found or coalesce(v_ag.commission_amount, 0) <= 0 then
      raise exception 'NO_COMMISSION_TO_REFUND' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.ledger_entries where idempotency_key = 'agreement_commission_' || v_ag.id::text) then
      raise exception 'COMMISSION_NOT_CHARGED' using errcode = 'P0001';
    end if;
    -- Idempotent per agreement: a second refund attempt returns NULL and changes nothing.
    v_balance := public._credit_wallet(
      v_ag.provider_id, v_ag.commission_amount, 'refund_credit', 'agreement', v_ag.id,
      'commission_refund_' || v_ag.id::text);
    v_refunded := v_balance is not null;
  end if;

  update public.reports
     set status = (case when p_refund then 'resolved' else 'dismissed' end)::public.report_status,
         resolution = case when p_refund then 'commission_refunded' else 'no_refund' end,
         resolved_by = auth.uid(),
         resolved_at = now(),
         resolution_note = nullif(btrim(p_note), '')
   where id = p_report_id;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), 'admin_resolve_report', 'report', p_report_id,
          jsonb_build_object('refund', p_refund, 'refunded', v_refunded, 'note', nullif(btrim(p_note), '')));

  return jsonb_build_object('report_id', p_report_id, 'refunded', v_refunded);
end;
$function$;
