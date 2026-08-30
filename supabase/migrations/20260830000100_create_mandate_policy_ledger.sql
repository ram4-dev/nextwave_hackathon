create table if not exists public.mandate_policy_reservations (
  transaction_id text primary key,
  checkout_mandate_id text not null,
  payment_mandate_id text not null,
  amount_minor bigint not null constraint mandate_policy_reservations_amount_safe_chk
    check (amount_minor between 0 and 9007199254740991),
  reserved_at timestamptz not null,
  released_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists mandate_policy_reservations_checkout_idx
  on public.mandate_policy_reservations (checkout_mandate_id, reserved_at)
  where released_at is null;

create index if not exists mandate_policy_reservations_payment_idx
  on public.mandate_policy_reservations (payment_mandate_id, reserved_at)
  where released_at is null;

alter table public.mandate_policy_reservations enable row level security;
revoke all on table public.mandate_policy_reservations from anon, authenticated;

drop function if exists public.reserve_mandate_policy(
  text, text, text, bigint, timestamptz,
  bigint, integer, integer, integer,
  bigint, integer, integer, integer
);

create or replace function public.reserve_mandate_policy(
  p_checkout_mandate_id text,
  p_payment_mandate_id text,
  p_transaction_id text,
  p_amount_minor bigint,
  p_reserved_at timestamptz,
  p_checkout_total_budget_minor bigint,
  p_checkout_max_operations integer,
  p_checkout_frequency_window_seconds integer,
  p_checkout_max_operations_per_window integer,
  p_payment_total_budget_minor bigint,
  p_payment_max_operations integer,
  p_payment_frequency_window_seconds integer,
  p_payment_max_operations_per_window integer
) returns table(remaining_budget_minor bigint)
language plpgsql
security invoker
set search_path = public
as $$
declare
  checkout_total numeric;
  checkout_operations integer;
  checkout_window_operations integer;
  payment_total numeric;
  payment_operations integer;
  payment_window_operations integer;
  lock_a text;
  lock_b text;
begin
  if p_checkout_mandate_id is null or p_checkout_mandate_id = ''
    or p_payment_mandate_id is null or p_payment_mandate_id = ''
    or p_transaction_id is null or p_transaction_id = ''
    or p_reserved_at is null or not isfinite(p_reserved_at)
    or p_amount_minor is null or p_amount_minor < 0 or p_amount_minor > 9007199254740991
    or p_checkout_total_budget_minor is null or p_payment_total_budget_minor is null
    or p_checkout_max_operations is null or p_payment_max_operations is null
    or p_checkout_frequency_window_seconds is null or p_payment_frequency_window_seconds is null
    or p_checkout_max_operations_per_window is null or p_payment_max_operations_per_window is null
    or p_checkout_total_budget_minor < 0 or p_payment_total_budget_minor < 0
    or p_checkout_total_budget_minor > 9007199254740991 or p_payment_total_budget_minor > 9007199254740991
    or p_checkout_max_operations < 1 or p_payment_max_operations < 1
    or p_checkout_frequency_window_seconds < 1 or p_payment_frequency_window_seconds < 1
    or p_checkout_max_operations_per_window < 1 or p_payment_max_operations_per_window < 1
    or p_checkout_max_operations_per_window > p_checkout_max_operations
    or p_payment_max_operations_per_window > p_payment_max_operations then
    raise exception 'POLICY_INPUT_INVALID';
  end if;

  -- Deterministic lock ordering across mandate ids prevents deadlocks.
  if p_checkout_mandate_id < p_payment_mandate_id then
    lock_a := p_checkout_mandate_id;
    lock_b := p_payment_mandate_id;
  else
    lock_a := p_payment_mandate_id;
    lock_b := p_checkout_mandate_id;
  end if;
  perform pg_advisory_xact_lock(hashtext(lock_a));
  perform pg_advisory_xact_lock(hashtext(lock_b));

  if exists (select 1 from public.mandate_policy_reservations where transaction_id = p_transaction_id) then
    raise exception 'MANDATE_IDEMPOTENCY';
  end if;

  select coalesce(sum(amount_minor), 0), count(*)
  into checkout_total, checkout_operations
  from public.mandate_policy_reservations
  where checkout_mandate_id = p_checkout_mandate_id
    and released_at is null;

  if checkout_total + p_amount_minor > p_checkout_total_budget_minor then raise exception 'POLICY_BUDGET'; end if;
  if checkout_operations >= p_checkout_max_operations then raise exception 'POLICY_OPERATIONS'; end if;

  select count(*) into checkout_window_operations
  from public.mandate_policy_reservations
  where checkout_mandate_id = p_checkout_mandate_id
    and released_at is null
    and reserved_at >= p_reserved_at - make_interval(secs => p_checkout_frequency_window_seconds);

  if checkout_window_operations >= p_checkout_max_operations_per_window then raise exception 'POLICY_FREQUENCY'; end if;

  select coalesce(sum(amount_minor), 0), count(*)
  into payment_total, payment_operations
  from public.mandate_policy_reservations
  where payment_mandate_id = p_payment_mandate_id
    and released_at is null;

  if payment_total + p_amount_minor > p_payment_total_budget_minor then raise exception 'POLICY_BUDGET'; end if;
  if payment_operations >= p_payment_max_operations then raise exception 'POLICY_OPERATIONS'; end if;

  select count(*) into payment_window_operations
  from public.mandate_policy_reservations
  where payment_mandate_id = p_payment_mandate_id
    and released_at is null
    and reserved_at >= p_reserved_at - make_interval(secs => p_payment_frequency_window_seconds);

  if payment_window_operations >= p_payment_max_operations_per_window then raise exception 'POLICY_FREQUENCY'; end if;

  insert into public.mandate_policy_reservations (
    transaction_id, checkout_mandate_id, payment_mandate_id, amount_minor, reserved_at
  ) values (
    p_transaction_id, p_checkout_mandate_id, p_payment_mandate_id, p_amount_minor, p_reserved_at
  );
  return query select least(
    p_checkout_total_budget_minor - checkout_total - p_amount_minor,
    p_payment_total_budget_minor - payment_total - p_amount_minor
  )::bigint;
end;
$$;

create or replace function public.release_mandate_policy_reservation(p_transaction_id text)
returns void language plpgsql security invoker set search_path = public as $$
declare
  checkout_id text;
  payment_id text;
  lock_a text;
  lock_b text;
begin
  select checkout_mandate_id, payment_mandate_id
  into checkout_id, payment_id
  from public.mandate_policy_reservations
  where transaction_id = p_transaction_id and released_at is null;
  if not found then return; end if;

  if checkout_id < payment_id then
    lock_a := checkout_id;
    lock_b := payment_id;
  else
    lock_a := payment_id;
    lock_b := checkout_id;
  end if;
  perform pg_advisory_xact_lock(hashtext(lock_a));
  perform pg_advisory_xact_lock(hashtext(lock_b));

  update public.mandate_policy_reservations
  set released_at = now()
  where transaction_id = p_transaction_id and released_at is null;
end;
$$;

revoke all on function public.reserve_mandate_policy(
  text, text, text, bigint, timestamptz,
  bigint, integer, integer, integer,
  bigint, integer, integer, integer
) from public, anon, authenticated;
revoke all on function public.release_mandate_policy_reservation(text) from public, anon, authenticated;
grant execute on function public.reserve_mandate_policy(
  text, text, text, bigint, timestamptz,
  bigint, integer, integer, integer,
  bigint, integer, integer, integer
) to service_role;
grant execute on function public.release_mandate_policy_reservation(text) to service_role;
