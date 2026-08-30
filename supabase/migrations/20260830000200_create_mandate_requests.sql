create table if not exists public.mandate_requests (
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

alter table public.mandate_requests enable row level security;
revoke all on table public.mandate_requests from anon, authenticated;

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

revoke all on function public.create_mandate_request(text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.create_mandate_request(text, text, text, text, text, text, timestamptz) to service_role;
