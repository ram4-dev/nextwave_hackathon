DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'catalog_api_key_status') THEN
    CREATE TYPE catalog_api_key_status AS ENUM ('active', 'revoked');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'catalog_outbox_status') THEN
    CREATE TYPE catalog_outbox_status AS ENUM ('pending', 'leased', 'done', 'dead_letter');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'catalog_acp_availability') THEN
    CREATE TYPE catalog_acp_availability AS ENUM (
      'in_stock',
      'backorder',
      'preorder',
      'out_of_stock',
      'discontinued',
      'unknown'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS catalog_merchants_current (
  merchant_id text PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  slug text NOT NULL CHECK (length(trim(slug)) > 0),
  category text NOT NULL DEFAULT 'comercio',
  country_code text NOT NULL CHECK (country_code = 'AR'),
  locality text,
  accepts_juno boolean NOT NULL CHECK (accepts_juno = true),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_product_feeds (
  feed_id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES catalog_merchants_current (merchant_id),
  target_country text NOT NULL CHECK (target_country = 'AR'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_merchant_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id text NOT NULL REFERENCES catalog_merchants_current (merchant_id),
  key_prefix text NOT NULL CHECK (length(key_prefix) = 8),
  key_hash text NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  status catalog_api_key_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT catalog_merchant_api_keys_revoked CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL) OR
    (status = 'active' AND revoked_at IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS catalog_products_current (
  feed_id text NOT NULL REFERENCES catalog_product_feeds (feed_id),
  external_product_id text NOT NULL,
  title text,
  description_plain text,
  url text,
  media jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feed_id, external_product_id)
);

CREATE TABLE IF NOT EXISTS catalog_variants_current (
  feed_id text NOT NULL,
  external_product_id text NOT NULL,
  external_variant_id text NOT NULL,
  item_id text NOT NULL UNIQUE,
  title text NOT NULL,
  description_plain text,
  url text,
  media jsonb NOT NULL DEFAULT '[]'::jsonb,
  categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  variant_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  price_minor bigint CHECK (price_minor IS NULL OR (price_minor >= 0 AND price_minor <= 9007199254740991)),
  list_price_minor bigint CHECK (list_price_minor IS NULL OR list_price_minor >= 0),
  unit_price jsonb,
  currency text CHECK (currency IS NULL OR currency = 'ARS'),
  available boolean,
  availability_status catalog_acp_availability,
  tombstoned boolean NOT NULL DEFAULT false,
  data_revision bigint NOT NULL CHECK (data_revision >= 1),
  search_revision bigint NOT NULL CHECK (search_revision >= 0),
  index_revision bigint NOT NULL DEFAULT 0 CHECK (index_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feed_id, external_product_id, external_variant_id),
  FOREIGN KEY (feed_id, external_product_id)
    REFERENCES catalog_products_current (feed_id, external_product_id)
);

CREATE TABLE IF NOT EXISTS catalog_ingest_receipts (
  merchant_id text NOT NULL,
  idempotency_key text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  body_hash text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, idempotency_key, method, path)
);

CREATE TABLE IF NOT EXISTS catalog_reindex_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id text NOT NULL,
  feed_id text NOT NULL,
  external_product_id text NOT NULL,
  external_variant_id text NOT NULL,
  search_revision bigint NOT NULL,
  operation text NOT NULL CHECK (operation IN ('upsert', 'delete')),
  status catalog_outbox_status NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_search_documents_current (
  item_id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL,
  item_info text NOT NULL,
  search_text text NOT NULL,
  search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  embedding vector(384) NOT NULL,
  index_revision bigint NOT NULL,
  embedding_model text NOT NULL,
  embedding_dimensions integer NOT NULL CHECK (embedding_dimensions = 384),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (item_id) REFERENCES catalog_variants_current (item_id)
);

CREATE INDEX IF NOT EXISTS catalog_feeds_merchant
  ON catalog_product_feeds (merchant_id);

CREATE INDEX IF NOT EXISTS catalog_api_keys_hash
  ON catalog_merchant_api_keys (key_hash);

CREATE INDEX IF NOT EXISTS catalog_api_keys_merchant
  ON catalog_merchant_api_keys (merchant_id, status);

CREATE INDEX IF NOT EXISTS catalog_variants_item
  ON catalog_variants_current (item_id);

CREATE INDEX IF NOT EXISTS catalog_variants_visibility
  ON catalog_variants_current (tombstoned, available, availability_status, currency, price_minor);

CREATE INDEX IF NOT EXISTS catalog_outbox_claim
  ON catalog_reindex_outbox (status, lease_until, created_at);

CREATE INDEX IF NOT EXISTS catalog_search_current_embedding_hnsw
  ON catalog_search_documents_current
  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS catalog_search_current_lexical_gin
  ON catalog_search_documents_current
  USING gin (search_tsv);
