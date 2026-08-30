CREATE EXTENSION IF NOT EXISTS vector;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'catalog_version_status') THEN
    CREATE TYPE catalog_version_status AS ENUM ('building', 'published', 'superseded', 'failed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'catalog_availability') THEN
    CREATE TYPE catalog_availability AS ENUM ('in_stock', 'out_of_stock', 'unknown');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS catalog_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  version text NOT NULL,
  status catalog_version_status NOT NULL,
  embedding_model text NOT NULL,
  embedding_dimensions integer NOT NULL CHECK (embedding_dimensions = 384),
  source_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT catalog_versions_source_version UNIQUE (source, version),
  CONSTRAINT catalog_versions_published_at CHECK (
    (status = 'published' AND published_at IS NOT NULL) OR
    (status <> 'published' AND published_at IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS catalog_merchants (
  catalog_version_id uuid NOT NULL REFERENCES catalog_versions (id),
  merchant_id text NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  slug text NOT NULL CHECK (length(trim(slug)) > 0),
  category text NOT NULL,
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  locality text,
  accepts_juno boolean NOT NULL CHECK (accepts_juno = true),
  source_updated_at timestamptz NOT NULL,
  PRIMARY KEY (catalog_version_id, merchant_id)
);

CREATE TABLE IF NOT EXISTS catalog_products (
  catalog_version_id uuid NOT NULL REFERENCES catalog_versions (id),
  item_id text NOT NULL,
  merchant_id text NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  description text NOT NULL DEFAULT '',
  category text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  price_minor bigint NOT NULL CHECK (price_minor >= 0 AND price_minor <= 9007199254740991),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  availability catalog_availability NOT NULL,
  source_updated_at timestamptz NOT NULL,
  PRIMARY KEY (catalog_version_id, item_id),
  FOREIGN KEY (catalog_version_id, merchant_id)
    REFERENCES catalog_merchants (catalog_version_id, merchant_id)
);

CREATE TABLE IF NOT EXISTS catalog_search_documents (
  catalog_version_id uuid NOT NULL,
  item_id text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  item_info text NOT NULL,
  search_text text NOT NULL,
  search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  embedding vector(384) NOT NULL,
  is_published boolean NOT NULL DEFAULT false,
  PRIMARY KEY (catalog_version_id, item_id),
  FOREIGN KEY (catalog_version_id, item_id)
    REFERENCES catalog_products (catalog_version_id, item_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_one_published_version
  ON catalog_versions ((status))
  WHERE status = 'published';

CREATE UNIQUE INDEX IF NOT EXISTS catalog_merchants_source_id
  ON catalog_merchants (catalog_version_id, merchant_id);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_products_source_id
  ON catalog_products (catalog_version_id, item_id);

CREATE INDEX IF NOT EXISTS catalog_search_embedding_hnsw
  ON catalog_search_documents
  USING hnsw (embedding vector_cosine_ops)
  WHERE is_published = true;

CREATE INDEX IF NOT EXISTS catalog_search_lexical_gin
  ON catalog_search_documents
  USING gin (search_tsv)
  WHERE is_published = true;

CREATE INDEX IF NOT EXISTS catalog_items_merchant
  ON catalog_products (catalog_version_id, merchant_id);

CREATE INDEX IF NOT EXISTS catalog_items_category
  ON catalog_products (catalog_version_id, category);

CREATE INDEX IF NOT EXISTS catalog_items_price_availability
  ON catalog_products (catalog_version_id, currency, price_minor, availability);
