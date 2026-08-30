-- RPC used by mcp.py's catalog() tool over PostgREST (service_role key), since the
-- app connects via REST instead of a direct Postgres connection.
create or replace function public.match_catalog_products(
  query_embedding vector(1536),
  match_count int default 20
)
returns table (
  item_id text,
  name text,
  brand text,
  amount_minor bigint,
  currency character(3),
  availability_status text,
  available_quantity integer,
  merchant_id text,
  merchant_name text,
  category_name text,
  similarity double precision
)
language sql
stable
as $$
  select
    p.item_id,
    p.name,
    p.brand,
    p.amount_minor,
    p.currency,
    p.availability_status,
    p.available_quantity,
    m.id as merchant_id,
    m.display_name as merchant_name,
    c.display_name as category_name,
    1 - (p.embedding <=> query_embedding) as similarity
  from catalog_products p
  join catalog_merchants m on m.id = p.merchant_id
  left join catalog_categories c on c.id = p.category_id
  where p.embedding is not null
    and m.catalog_status = 'active'
  order by p.embedding <=> query_embedding
  limit match_count;
$$;

grant execute on function public.match_catalog_products(vector, int) to service_role;
;
