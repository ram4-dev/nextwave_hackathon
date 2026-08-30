-- Migration 20260830090000.
-- KYA live persistence: single CAS aggregate authority (no multi-table replaceAll).
-- Service-role only. Pattern: RLS enabled + revoke anon/authenticated.
-- Fresh install: only schema_meta + kya_state + durable replay/rate + RPCs.

create table if not exists public.kya_schema_meta (
  key text primary key,
  value text not null
);

create table if not exists public.kya_state (
  id text primary key check (id = 'singleton'),
  version bigint not null default 0,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.kya_state (id, version, state)
values ('singleton', 0, '{}'::jsonb)
on conflict (id) do nothing;

-- Durable DPoP replay jti hashes (separate from aggregate for atomic consume)
create table if not exists public.kya_dpop_replays (
  jti_hash text primary key,
  consumed_at timestamptz not null,
  expires_at timestamptz not null
);

-- Durable rate-limit buckets for live multi-instance
create table if not exists public.kya_rate_limits (
  bucket_key text primary key,
  count int not null default 0,
  reset_at timestamptz not null
);

alter table public.kya_schema_meta enable row level security;
alter table public.kya_state enable row level security;
alter table public.kya_dpop_replays enable row level security;
alter table public.kya_rate_limits enable row level security;

revoke all on table public.kya_schema_meta from anon, authenticated;
revoke all on table public.kya_state from anon, authenticated;
revoke all on table public.kya_dpop_replays from anon, authenticated;
revoke all on table public.kya_rate_limits from anon, authenticated;

grant select on table public.kya_schema_meta to service_role;
grant select, insert, update on table public.kya_state to service_role;
grant select, insert, update, delete on table public.kya_dpop_replays to service_role;
grant select, insert, update, delete on table public.kya_rate_limits to service_role;

create or replace function public.kya_compare_and_swap_state(
  p_expected_version bigint,
  p_state jsonb
) returns table (ok boolean, version bigint, current_version bigint)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_current bigint;
  v_new bigint;
begin
  select s.version into v_current from public.kya_state s where s.id = 'singleton' for update;
  if v_current is null then
    insert into public.kya_state (id, version, state)
    values ('singleton', 0, '{}'::jsonb)
    on conflict (id) do nothing;
    select s.version into v_current from public.kya_state s where s.id = 'singleton' for update;
  end if;

  if v_current is distinct from p_expected_version then
    ok := false;
    version := v_current;
    current_version := v_current;
    return next;
    return;
  end if;

  v_new := v_current + 1;
  update public.kya_state
    set version = v_new, state = p_state, updated_at = now()
    where id = 'singleton' and public.kya_state.version = p_expected_version;

  if not found then
    select s.version into v_current from public.kya_state s where s.id = 'singleton';
    ok := false;
    version := v_current;
    current_version := v_current;
    return next;
    return;
  end if;

  ok := true;
  version := v_new;
  current_version := v_new;
  return next;
end;
$$;

revoke all on function public.kya_compare_and_swap_state(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.kya_compare_and_swap_state(bigint, jsonb) to service_role;

-- Atomic DPoP replay: true=consumed, false=replay (boolean kept for CREATE OR REPLACE compatibility)
create or replace function public.kya_consume_dpop_replay(
  p_jti_hash text,
  p_consumed_at timestamptz,
  p_expires_at timestamptz
) returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  delete from public.kya_dpop_replays where expires_at <= now();
  insert into public.kya_dpop_replays (jti_hash, consumed_at, expires_at)
  values (p_jti_hash, p_consumed_at, p_expires_at)
  on conflict (jti_hash) do nothing;
  if found then
    return true;
  end if;
  return false;
end;
$$;

revoke all on function public.kya_consume_dpop_replay(text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.kya_consume_dpop_replay(text, timestamptz, timestamptz) to service_role;

-- Atomic bucket increment: single INSERT ... ON CONFLICT DO UPDATE ... RETURNING.
-- Serializes concurrent requests on the same bucket_key (no lost update).
create or replace function public.kya_check_rate_limit(
  p_bucket_key text,
  p_limit int,
  p_window_ms bigint,
  p_now timestamptz default now()
) returns table (allowed boolean, remaining int)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count int;
  v_window interval;
begin
  v_window := make_interval(secs => greatest(p_window_ms, 1)::double precision / 1000.0);
  insert into public.kya_rate_limits (bucket_key, count, reset_at)
  values (p_bucket_key, 1, p_now + v_window)
  on conflict (bucket_key) do update
    set
      count = case
        when public.kya_rate_limits.reset_at <= p_now then 1
        else least(public.kya_rate_limits.count + 1, p_limit + 1)
      end,
      reset_at = case
        when public.kya_rate_limits.reset_at <= p_now then p_now + v_window
        else public.kya_rate_limits.reset_at
      end
  returning public.kya_rate_limits.count into v_count;

  if v_count > p_limit then
    allowed := false;
    remaining := 0;
    return next;
    return;
  end if;
  allowed := true;
  remaining := greatest(p_limit - v_count, 0);
  return next;
end;
$$;

revoke all on function public.kya_check_rate_limit(text, int, bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.kya_check_rate_limit(text, int, bigint, timestamptz) to service_role;

insert into public.kya_schema_meta (key, value)
values ('kya_core_version', '20260830_02')
on conflict (key) do update set value = excluded.value;
