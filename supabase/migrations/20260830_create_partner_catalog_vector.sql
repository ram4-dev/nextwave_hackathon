-- Partner catalog read model for the agent MCP.
-- Run once in Supabase SQL Editor or through the Supabase migration workflow.
-- The 10,000 products below are clearly synthetic development data. Replace them
-- with partner-supplied catalog data before enabling user-facing search.

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

create table public.catalog_merchants (
  id text primary key check (id ~ '^[A-Za-z0-9._:-]+$'),
  display_name text not null,
  catalog_status text not null default 'active' check (catalog_status in ('active', 'paused', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.catalog_categories (
  id text primary key check (id ~ '^[A-Za-z0-9._:-]+$'),
  display_name text not null,
  created_at timestamptz not null default now()
);

create table public.catalog_products (
  item_id text primary key check (item_id ~ '^[A-Za-z0-9._:-]+$'),
  merchant_id text not null references public.catalog_merchants(id),
  category_id text not null references public.catalog_categories(id),
  name text not null,
  description text not null,
  brand text,
  attributes jsonb not null default '{}'::jsonb,
  image_urls jsonb not null default '[]'::jsonb,
  amount_minor bigint not null check (amount_minor >= 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  availability_status text not null check (availability_status in ('in_stock', 'low_stock', 'out_of_stock', 'preorder', 'unknown')),
  available_quantity integer check (available_quantity >= 0),
  variant_summary text,
  return_policy_summary text,
  merchant_product_reference text not null check (merchant_product_reference ~ '^[A-Za-z0-9._:-]+$'),
  catalog_version text not null,
  search_document text not null,
  embedding extensions.vector(1536),
  embedding_model text,
  embedding_updated_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.catalog_embedding_jobs (
  item_id text primary key references public.catalog_products(item_id) on delete cascade,
  content_hash text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index catalog_products_merchant_category_idx on public.catalog_products (merchant_id, category_id);
create index catalog_products_price_idx on public.catalog_products (currency, amount_minor);
-- Cosine distance (<=>) is used by match_catalog_products, so this operator
-- class must match the function's operator.
create index catalog_products_embedding_hnsw_idx
  on public.catalog_products using hnsw (embedding extensions.vector_cosine_ops)
  where embedding is not null;
create index catalog_embedding_jobs_pending_idx on public.catalog_embedding_jobs (status, updated_at)
  where status in ('pending', 'failed');

insert into public.catalog_categories (id, display_name) values
  ('category_01', 'Electrónica'), ('category_02', 'Computación'),
  ('category_03', 'Hogar y cocina'), ('category_04', 'Deportes'),
  ('category_05', 'Moda'), ('category_06', 'Belleza'),
  ('category_07', 'Libros'), ('category_08', 'Juguetes'),
  ('category_09', 'Mascotas'), ('category_10', 'Bebés'),
  ('category_11', 'Automotor'), ('category_12', 'Jardín'),
  ('category_13', 'Oficina'), ('category_14', 'Alimentos'),
  ('category_15', 'Música'), ('category_16', 'Viajes'),
  ('category_17', 'Salud'), ('category_18', 'Herramientas'),
  ('category_19', 'Gaming'), ('category_20', 'Accesorios')
on conflict (id) do nothing;

insert into public.catalog_merchants (id, display_name)
select format('merchant_%s', lpad(n::text, 2, '0')), format('Partner Merchant %s', lpad(n::text, 2, '0'))
from generate_series(1, 25) as n
on conflict (id) do nothing;

-- Development seed: 10,000 fake products across 25 merchants and 20 categories.
with generated as (
  select
    n,
    format('item_%s', lpad(n::text, 5, '0')) as item_id,
    format('merchant_%s', lpad((((n - 1) % 25) + 1)::text, 2, '0')) as merchant_id,
    format('category_%s', lpad((((n - 1) % 20) + 1)::text, 2, '0')) as category_id
  from generate_series(1, 10000) as n
)
insert into public.catalog_products (
  item_id, merchant_id, category_id, name, description, brand, attributes,
  image_urls, amount_minor, currency, availability_status, available_quantity,
  variant_summary, return_policy_summary, merchant_product_reference,
  catalog_version, search_document
)
select
  g.item_id,
  g.merchant_id,
  g.category_id,
  format('%s selección partner %s', c.display_name, lpad(g.n::text, 5, '0')),
  format('Artículo de %s para catálogo partner. Opción %s con información descriptiva para pruebas de búsqueda semántica.', c.display_name, g.n),
  format('Marca %s', ((g.n - 1) % 40) + 1),
  jsonb_build_object('color', (array['negro', 'blanco', 'azul', 'verde', 'rojo'])[((g.n - 1) % 5) + 1], 'sku', format('SKU-%s', lpad(g.n::text, 5, '0'))),
  jsonb_build_array(format('https://images.example.invalid/catalog/%s.jpg', g.item_id)),
  500 + ((g.n * 137) % 250000),
  (array['USD', 'ARS', 'BRL'])[((g.n - 1) % 3) + 1],
  (array['in_stock', 'in_stock', 'in_stock', 'low_stock', 'out_of_stock'])[((g.n - 1) % 5) + 1],
  case when g.n % 5 = 0 then 0 else 1 + (g.n % 40) end,
  format('Variante estándar %s', ((g.n - 1) % 8) + 1),
  'Devolución según política del merchant partner.',
  format('partner_product_%s', lpad(g.n::text, 5, '0')),
  'seed-v1',
  format('%s. %s. Marca %s. Color %s.',
    format('%s selección partner %s', c.display_name, lpad(g.n::text, 5, '0')),
    format('Artículo de %s para catálogo partner.', c.display_name),
    format('Marca %s', ((g.n - 1) % 40) + 1),
    (array['negro', 'blanco', 'azul', 'verde', 'rojo'])[((g.n - 1) % 5) + 1]
  )
from generated g
join public.catalog_categories c on c.id = g.category_id
on conflict (item_id) do nothing;

insert into public.catalog_embedding_jobs (item_id, content_hash)
select item_id, md5(search_document)
from public.catalog_products
on conflict (item_id) do nothing;

-- Called only by the trusted embedding worker after it embeds search_document
-- using one stable, normalized 1536-dimension embedding model.
create or replace function public.upsert_catalog_product_embedding(
  p_item_id text,
  p_embedding extensions.vector(1536),
  p_embedding_model text
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  update public.catalog_products
  set embedding = p_embedding,
      embedding_model = p_embedding_model,
      embedding_updated_at = now(),
      updated_at = now()
  where item_id = p_item_id;
  if not found then
    raise exception 'Unknown catalog item: %', p_item_id using errcode = 'P0002';
  end if;

  update public.catalog_embedding_jobs
  set status = 'completed', attempts = attempts + 1, last_error = null, updated_at = now()
  where item_id = p_item_id;
end;
$$;

-- Semantic retrieval. Query embeddings must be generated by the same model as
-- product embeddings. The MCP should return these minimal results, then read
-- the full item data by item_id.
create or replace function public.match_catalog_products(
  p_query_embedding extensions.vector(1536),
  p_match_count integer default 10,
  p_match_threshold double precision default 0.70,
  p_merchant_id text default null,
  p_category_ids text[] default null,
  p_currency char(3) default null,
  p_min_price_minor bigint default null,
  p_max_price_minor bigint default null,
  p_in_stock_only boolean default false
) returns table (
  item_id text,
  merchant_id text,
  score double precision,
  matched_fields text[]
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    p.item_id,
    p.merchant_id,
    1 - (p.embedding <=> p_query_embedding) as score,
    array['name', 'description', 'category', 'attributes']::text[] as matched_fields
  from public.catalog_products p
  join public.catalog_merchants m on m.id = p.merchant_id
  where p.embedding is not null
    and m.catalog_status = 'active'
    and (p_merchant_id is null or p.merchant_id = p_merchant_id)
    and (p_category_ids is null or cardinality(p_category_ids) = 0 or p.category_id = any(p_category_ids))
    and (p_currency is null or p.currency = p_currency)
    and (p_min_price_minor is null or p.amount_minor >= p_min_price_minor)
    and (p_max_price_minor is null or p.amount_minor <= p_max_price_minor)
    and (not p_in_stock_only or p.availability_status in ('in_stock', 'low_stock'))
    and 1 - (p.embedding <=> p_query_embedding) >= p_match_threshold
  order by p.embedding <=> p_query_embedding
  limit least(greatest(p_match_count, 1), 20);
$$;

-- Exact lookup after semantic search. This is the data source for
-- catalog_get_product; it intentionally does not contact the merchant.
create or replace function public.get_catalog_product(p_item_id text)
returns table (
  item_id text,
  merchant_id text,
  name text,
  description text,
  brand text,
  category_id text,
  attributes jsonb,
  image_urls jsonb,
  amount_minor bigint,
  currency char(3),
  availability_status text,
  available_quantity integer,
  variant_summary text,
  return_policy_summary text,
  merchant_product_reference text,
  catalog_version text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select p.item_id, p.merchant_id, p.name, p.description, p.brand, p.category_id,
    p.attributes, p.image_urls, p.amount_minor, p.currency, p.availability_status,
    p.available_quantity, p.variant_summary, p.return_policy_summary,
    p.merchant_product_reference, p.catalog_version, p.updated_at
  from public.catalog_products p
  join public.catalog_merchants m on m.id = p.merchant_id
  where p.item_id = p_item_id and m.catalog_status = 'active';
$$;

alter table public.catalog_merchants enable row level security;
alter table public.catalog_categories enable row level security;
alter table public.catalog_products enable row level security;
alter table public.catalog_embedding_jobs enable row level security;

revoke all on public.catalog_merchants, public.catalog_categories, public.catalog_products, public.catalog_embedding_jobs from anon, authenticated;
revoke all on function public.upsert_catalog_product_embedding(text, extensions.vector, text) from public, anon, authenticated;
revoke all on function public.match_catalog_products(extensions.vector, integer, double precision, text, text[], char, bigint, bigint, boolean) from public, anon, authenticated;
revoke all on function public.get_catalog_product(text) from public, anon, authenticated;
grant execute on function public.upsert_catalog_product_embedding(text, extensions.vector, text) to service_role;
grant execute on function public.match_catalog_products(extensions.vector, integer, double precision, text, text[], char, bigint, bigint, boolean) to service_role;
grant execute on function public.get_catalog_product(text) to service_role;

do $$
begin
  if (select count(*) from public.catalog_products) < 10000 then
    raise exception 'Expected 10,000 catalog products after seed';
  end if;
end;
$$;
