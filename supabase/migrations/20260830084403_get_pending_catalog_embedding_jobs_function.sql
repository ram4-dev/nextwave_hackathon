-- Read-only counterpart to upsert_catalog_product_embedding, so
-- scripts/backfill_catalog_embeddings.py can read pending work over REST
-- (service_role key) without a direct Postgres connection, matching the
-- existing get_catalog_product / match_catalog_products access pattern.
create or replace function public.get_pending_catalog_embedding_jobs(p_limit int default 100)
returns table (item_id text, search_document text)
language sql
stable
security definer
set search_path to 'public'
as $$
  select p.item_id, p.search_document
  from public.catalog_embedding_jobs j
  join public.catalog_products p on p.item_id = j.item_id
  where j.status = 'pending'
  order by p.item_id
  limit greatest(p_limit, 1);
$$;

grant execute on function public.get_pending_catalog_embedding_jobs(int) to service_role;
;
