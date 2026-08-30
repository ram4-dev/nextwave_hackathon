-- Safe upgrade from the original 20260830 mandate migrations to the remediations schema.
-- Idempotent on fresh installs that already have the remediated shape.

-- 1) Request store: add encrypted ref, drop plaintext prompt irrevocably, replace RPC by signature.
alter table if exists public.mandate_requests
  add column if not exists encrypted_prompt_ref text;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = current_schema() and table_name = 'mandate_requests' and column_name = 'prompt'
  ) then
    alter table mandate_requests drop column prompt cascade;
  end if;
end $$;

-- Drop legacy create_mandate_request(p_prompt text, ...) if present (old 7-arg with plaintext).
drop function if exists public.create_mandate_request(text, text, text, text, text, text, timestamptz);

-- Ensure prompt_hash cannot hold plaintext (exact SHA-256 base64url).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'mandate_requests_prompt_hash_sha256_chk'
  ) then
    alter table public.mandate_requests
      add constraint mandate_requests_prompt_hash_sha256_chk
      check (prompt_hash ~ '^[A-Za-z0-9_-]{43}$');
  end if;
exception when undefined_table then null;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'mandate_requests_encrypted_prompt_ref_chk'
  ) then
    alter table public.mandate_requests
      add constraint mandate_requests_encrypted_prompt_ref_chk
      check (
        encrypted_prompt_ref is null
        or (
          encrypted_prompt_ref ~ '^[-A-Za-z0-9._:]+$'
          and char_length(encrypted_prompt_ref) <= 512
        )
      );
  end if;
exception when undefined_table then null;
end $$;

create or replace function public.create_mandate_request(
  p_id text,
  p_transaction_id text,
  p_agent_id text,
  p_tenant_id text,
  p_prompt_hash text,
  p_encrypted_prompt_ref text,
  p_received_at timestamptz
) returns public.mandate_requests
language plpgsql
security invoker
set search_path = public
as $$
declare
  row public.mandate_requests;
begin
  if p_prompt_hash is null or p_prompt_hash !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'PROMPT_HASH_INVALID';
  end if;
  if p_encrypted_prompt_ref is not null and (
    p_encrypted_prompt_ref !~ '^[-A-Za-z0-9._:]+$'
    or char_length(p_encrypted_prompt_ref) > 512
  ) then
    raise exception 'ENCRYPTED_PROMPT_REF_INVALID';
  end if;
  insert into public.mandate_requests (
    id, transaction_id, agent_id, tenant_id, prompt_hash, encrypted_prompt_ref, received_at
  ) values (
    p_id, p_transaction_id, p_agent_id, p_tenant_id, p_prompt_hash, p_encrypted_prompt_ref, p_received_at
  ) returning * into row;
  return row;
end;
$$;

revoke all on function public.create_mandate_request(text, text, text, text, text, text, timestamptz) from public;
do $$ begin
  revoke all on function public.create_mandate_request(text, text, text, text, text, text, timestamptz) from anon, authenticated;
exception when undefined_object then null;
end $$;
do $$ begin
  grant execute on function public.create_mandate_request(text, text, text, text, text, text, timestamptz) to service_role;
exception when undefined_object then null;
end $$;

-- 2) Policy ledger: drop legacy 9-arg pair-scoped reserve, ensure per-mandate function + indexes.
drop function if exists public.reserve_mandate_policy(
  text, text, text, bigint, timestamptz, bigint, integer, integer, integer
);

create index if not exists mandate_policy_reservations_checkout_idx
  on public.mandate_policy_reservations (checkout_mandate_id, reserved_at)
  where released_at is null;

create index if not exists mandate_policy_reservations_payment_idx
  on public.mandate_policy_reservations (payment_mandate_id, reserved_at)
  where released_at is null;

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

revoke all on function public.reserve_mandate_policy(
  text, text, text, bigint, timestamptz,
  bigint, integer, integer, integer,
  bigint, integer, integer, integer
) from public;
do $$ begin
  revoke all on function public.reserve_mandate_policy(
    text, text, text, bigint, timestamptz,
    bigint, integer, integer, integer,
    bigint, integer, integer, integer
  ) from anon, authenticated;
exception when undefined_object then null;
end $$;
do $$ begin
  grant execute on function public.reserve_mandate_policy(
    text, text, text, bigint, timestamptz,
    bigint, integer, integer, integer,
    bigint, integer, integer, integer
  ) to service_role;
exception when undefined_object then null;
end $$;

alter table if exists public.mandate_requests enable row level security;
alter table if exists public.mandate_policy_reservations enable row level security;
do $$ begin
  revoke all on table public.mandate_requests from anon, authenticated;
  revoke all on table public.mandate_policy_reservations from anon, authenticated;
exception when undefined_object then null;
end $$;
