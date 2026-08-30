create table if not exists public.mandate_requests (
  id text primary key,
  transaction_id text not null unique,
  agent_id text not null,
  tenant_id text not null,
  prompt text not null,
  prompt_hash text not null,
  received_at timestamptz not null,
  status text not null default 'received' check (status = 'received'),
  created_at timestamptz not null default now()
);

alter table public.mandate_requests enable row level security;
revoke all on table public.mandate_requests from anon, authenticated;

create or replace function public.create_mandate_request(
  p_id text, p_transaction_id text, p_agent_id text, p_tenant_id text,
  p_prompt text, p_prompt_hash text, p_received_at timestamptz
) returns public.mandate_requests
language sql
security invoker
set search_path = public
as $$
  insert into public.mandate_requests (
    id, transaction_id, agent_id, tenant_id, prompt, prompt_hash, received_at
  ) values (
    p_id, p_transaction_id, p_agent_id, p_tenant_id, p_prompt, p_prompt_hash, p_received_at
  ) returning *;
$$;

revoke all on function public.create_mandate_request(text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.create_mandate_request(text, text, text, text, text, text, timestamptz) to service_role;
