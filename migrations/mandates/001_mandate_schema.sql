-- Mandate policy ledger + mandate request store, on plain self-hosted Postgres.
--
-- This consolidates what used to be three sequential Supabase migrations
-- (create_mandate_policy_ledger, create_mandate_requests, upgrade_mandate_schema_v2)
-- into the single final shape, since a fresh local database has no legacy rows to
-- carry forward. Behavior (constraints, RPC signatures, advisory-lock ordering) is
-- unchanged from the Supabase version.
--
-- Supabase-specific plumbing intentionally dropped: `enable row level security` and
-- `grant/revoke ... anon, authenticated, service_role` existed only to fence off the
-- PostgREST anon/authenticated roles that Supabase exposes. Outside Supabase there is
-- no PostgREST layer and the app connects as a single owning role, so that plumbing
-- was a no-op waiting to become a footgun (RLS with zero policies denies everyone,
-- including the app, the moment the app role stops owning the tables).

create table if not exists mandate_policy_reservations (
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
  on mandate_policy_reservations (checkout_mandate_id, reserved_at)
  where released_at is null;

create index if not exists mandate_policy_reservations_payment_idx
  on mandate_policy_reservations (payment_mandate_id, reserved_at)
  where released_at is null;

create table if not exists mandate_requests (
  id text primary key,
  transaction_id text not null unique,
  agent_id text not null,
  tenant_id text not null,
  prompt_hash text not null,
  encrypted_prompt_ref text,
  received_at timestamptz not null,
  status text not null default 'received' check (status = 'received'),
  created_at timestamptz not null default now(),
  constraint mandate_requests_prompt_hash_sha256_chk
    check (prompt_hash ~ '^[A-Za-z0-9_-]{43}$'),
  constraint mandate_requests_encrypted_prompt_ref_chk
    check (
      encrypted_prompt_ref is null
      or (
        encrypted_prompt_ref ~ '^[-A-Za-z0-9._:]+$'
        and char_length(encrypted_prompt_ref) <= 512
      )
    )
);

-- Plaintext prompt column is intentionally absent. Only prompt_hash (+ optional opaque ref) is stored.

create or replace function create_mandate_request(
  p_id text,
  p_transaction_id text,
  p_agent_id text,
  p_tenant_id text,
  p_prompt_hash text,
  p_encrypted_prompt_ref text,
  p_received_at timestamptz
) returns mandate_requests
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  row mandate_requests;
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
  insert into mandate_requests (
    id, transaction_id, agent_id, tenant_id, prompt_hash, encrypted_prompt_ref, received_at
  ) values (
    p_id, p_transaction_id, p_agent_id, p_tenant_id, p_prompt_hash, p_encrypted_prompt_ref, p_received_at
  ) returning * into row;
  return row;
end;
$$;

create or replace function reserve_mandate_policy(
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
set search_path = pg_catalog, public
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

  if exists (select 1 from mandate_policy_reservations where transaction_id = p_transaction_id) then
    raise exception 'MANDATE_IDEMPOTENCY';
  end if;

  select coalesce(sum(amount_minor), 0), count(*)
  into checkout_total, checkout_operations
  from mandate_policy_reservations
  where checkout_mandate_id = p_checkout_mandate_id
    and released_at is null;

  if checkout_total + p_amount_minor > p_checkout_total_budget_minor then raise exception 'POLICY_BUDGET'; end if;
  if checkout_operations >= p_checkout_max_operations then raise exception 'POLICY_OPERATIONS'; end if;

  select count(*) into checkout_window_operations
  from mandate_policy_reservations
  where checkout_mandate_id = p_checkout_mandate_id
    and released_at is null
    and reserved_at >= p_reserved_at - make_interval(secs => p_checkout_frequency_window_seconds);

  if checkout_window_operations >= p_checkout_max_operations_per_window then raise exception 'POLICY_FREQUENCY'; end if;

  select coalesce(sum(amount_minor), 0), count(*)
  into payment_total, payment_operations
  from mandate_policy_reservations
  where payment_mandate_id = p_payment_mandate_id
    and released_at is null;

  if payment_total + p_amount_minor > p_payment_total_budget_minor then raise exception 'POLICY_BUDGET'; end if;
  if payment_operations >= p_payment_max_operations then raise exception 'POLICY_OPERATIONS'; end if;

  select count(*) into payment_window_operations
  from mandate_policy_reservations
  where payment_mandate_id = p_payment_mandate_id
    and released_at is null
    and reserved_at >= p_reserved_at - make_interval(secs => p_payment_frequency_window_seconds);

  if payment_window_operations >= p_payment_max_operations_per_window then raise exception 'POLICY_FREQUENCY'; end if;

  insert into mandate_policy_reservations (
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

create or replace function release_mandate_policy_reservation(p_transaction_id text)
returns void language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  checkout_id text;
  payment_id text;
  lock_a text;
  lock_b text;
begin
  select checkout_mandate_id, payment_mandate_id
  into checkout_id, payment_id
  from mandate_policy_reservations
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

  update mandate_policy_reservations
  set released_at = now()
  where transaction_id = p_transaction_id and released_at is null;
end;
$$;
