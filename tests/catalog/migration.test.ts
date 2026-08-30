import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION_002 = path.resolve(process.cwd(), 'migrations/002_acp_catalog_current.sql');

function loadMigration002(): string {
  return readFileSync(MIGRATION_002, 'utf8');
}

describe('002 current-state catalog schema', () => {
  it('adds additive current-state tables without dropping versioned catalog tables', () => {
    const sql = loadMigration002();
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS catalog_merchants_current/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS catalog_product_feeds/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS catalog_merchant_api_keys/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS catalog_products_current/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS catalog_variants_current/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS catalog_ingest_receipts/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS catalog_reindex_outbox/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS catalog_search_documents_current/i);
    expect(sql).not.toMatch(/DROP TABLE\s+catalog_versions/i);
    expect(sql).not.toMatch(/DROP TABLE\s+catalog_products/i);
    expect(sql).not.toMatch(/DROP TABLE\s+catalog_search_documents/i);
  });

  it('identifies each sellable item by (feed_id, product_id, variant_id) and tracks three revisions', () => {
    const sql = loadMigration002();
    expect(sql).toMatch(/PRIMARY KEY\s*\(\s*feed_id\s*,\s*external_product_id\s*,\s*external_variant_id\s*\)/i);
    expect(sql).toMatch(/item_id\s+text\s+NOT NULL/i);
    expect(sql).toMatch(/data_revision\s+bigint\s+NOT NULL/i);
    expect(sql).toMatch(/search_revision\s+bigint\s+NOT NULL/i);
    expect(sql).toMatch(/index_revision\s+bigint\s+NOT NULL/i);
    expect(sql).toMatch(/tombstoned\s+boolean\s+NOT NULL/i);
  });

  it('stores API keys as prefix + hash only and keeps raw secrets out of the schema', () => {
    const sql = loadMigration002();
    expect(sql).toMatch(/key_prefix\s+text\s+NOT NULL/i);
    expect(sql).toMatch(/key_hash\s+text\s+NOT NULL/i);
    expect(sql).toMatch(/catalog_merchant_api_keys[\s\S]*status/i);
    expect(sql).not.toMatch(/raw_api_key|api_key_plain|plaintext_key/i);
  });

  it('adds a durable outbox with lease, attempts, and dead-letter state', () => {
    const sql = loadMigration002();
    expect(sql).toMatch(/catalog_reindex_outbox/i);
    expect(sql).toMatch(/lease_until/i);
    expect(sql).toMatch(/attempts/i);
    expect(sql).toMatch(/dead_letter|dead-letter|deadletter/i);
    expect(sql).toMatch(/search_revision/i);
  });
});
