create table if not exists public.mandate_policy_reservations (
  transaction_id text primary key,
  checkout_mandate_id text not null,
  payment_mandate_id text not null,
  amount_minor bigint not null check (amount_minor >= 0),
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
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  checkout_total bigint;
  checkout_operations integer;
  checkout_window_operations integer;
  payment_total bigint;
  payment_operations integer;
  payment_window_operations integer;
  lock_a text;
  lock_b text;
begin
  if p_amount_minor < 0
    or p_checkout_total_budget_minor < 0 or p_payment_total_budget_minor < 0
    or p_checkout_max_operations < 1 or p_payment_max_operations < 1
    or p_checkout_frequency_window_seconds < 1 or p_payment_frequency_window_seconds < 1
    or p_checkout_max_operations_per_window < 1 or p_payment_max_operations_per_window < 1 then
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
end;
$$;

create or replace function public.release_mandate_policy_reservation(p_transaction_id text)
returns void language sql security invoker set search_path = public as $$
  update public.mandate_policy_reservations
  set released_at = now()
  where transaction_id = p_transaction_id and released_at is null;
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
