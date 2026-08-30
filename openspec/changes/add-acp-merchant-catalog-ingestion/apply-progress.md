# Apply Progress: ACP merchant catalog ingestion

**Status:** done
**Runtime harness:** PostgreSQL 16 + pgvector 0.8.1 at `127.0.0.1:55432`
**Rollback boundary:** `CATALOG_ACP_ENABLED=false` and `CATALOG_WORKER_ENABLED=false` pause routes/worker; versioned `001` tables stay; do not drop `002` until a later revert.

## TDD Cycle Evidence

| Task | Test file | Layer | Safety net | RED | GREEN | Triangulate | Refactor |
|---|---|---|---|---|---|---|---|
| 1.1 | `tests/catalog/migration.test.ts` | Unit | `npx vitest run tests/catalog/{contracts,projection,search-service,routes,loader,ranking,embedding}.test.ts` — 7 files, 25/25 | `npx vitest run tests/catalog/migration.test.ts` — 4 failed; `ENOENT` `migrations/002_acp_catalog_current.sql` | same command — 4/4 after additive `002` | tables present; identity PK; hash-only keys; outbox lease/dead_letter; no DROP of versioned tables | SQL kept additive |
| 1.2 | `tests/catalog/acp-auth.test.ts` | Unit | same 25/25 catalog unit safety net | `npx vitest run tests/catalog/acp-auth.test.ts` — suite fail `Cannot find module '../../src/catalog/acp-contract.js'` | `npx vitest run tests/catalog/migration.test.ts tests/catalog/acp-auth.test.ts` — 10/10 | active bearer; missing/unknown/revoked 401; foreign feed 404; raw key absent from record | hash via SHA-256 + timing-safe compare |
| 1.2c | `tests/catalog/acp-auth.test.ts` + `postgres.integration.test.ts` | Unit + Postgres | `npx vitest run tests/catalog/acp-auth.test.ts tests/catalog/acp-routes.test.ts` — 13/13 | revoke/rotate: `revokeMerchantApiKey is not a function`; rotate Postgres: `rotateMerchantApiKeyInPostgres is not a function` | same files — 7/7 unit; rotate/revoke integration 200→401→new bearer | raw absent from revoked/issued records; previous raw 401 after rotate | transactional rotate (`FOR UPDATE` + revoke + insert) |
| 2.2c | `tests/catalog/acp-routes.test.ts` + `postgres.integration.test.ts` | HTTP + Postgres | 1.2c green | mapper: `acpIngestionOptionsFromConfig is not a function`; Postgres second POST expected 429 received 200 | `npx vitest run tests/catalog` — 63/63; rate-limit 200 then 429 `RATE_LIMITED` | `CATALOG_ACP_RATE_LIMIT` maps to `maxRequestsPerWindow`; shared `AcpWriteGuard` across inner services | `index.ts` uses `acpIngestionOptionsFromConfig(config)` |
| 2.1 | `tests/catalog/acp-routes.test.ts` | HTTP unit | 1.1/1.2 green | `npx vitest run tests/catalog/acp-routes.test.ts` — suite fail `Cannot find module '../../src/catalog/ingestion.js'` | same command — 7/7 | POST 200; GET full array; expired Timestamp es-AR; US/USD 400; 413/429/503; merge; replay; 409 collision; foreign 404 | header validation extracted |
| 2.2 | `tests/catalog/acp-routes.test.ts` | HTTP + app wiring | `npx vitest run tests/catalog/acp-routes.test.ts tests/catalog/routes.test.ts` — 11/11 | covered by 2.1 RED | `200 {id,accepted:true}` and existing public search still 200 | two merchants; seller ignored; idempotent replay | GET reads do not persist |
| 3.1 | `tests/catalog/outbox-worker.test.ts` | Unit | 2.2 green | `npx vitest run tests/catalog/outbox-worker.test.ts` — suite fail `Cannot find module '../../src/catalog/reindex-worker.js'` | same command — 6/6 | lease exclusivity; retry→dead_letter; interrupt recover; stale revision; tombstone hide | claim/release API kept small |
| 3.2 | `tests/catalog/outbox-worker.test.ts` | Worker + projection | 3.1 green | covered by 3.1 RED | 6/6; `scripts/reindex-catalog-worker.ts` + `PostgresReindexWorker` | upsert conditioned on `search_revision`; delete tombstone | ACP searchable fields exclude price/merchant/URL |
| 4.1 | `tests/catalog/search-service.test.ts` | Unit | existing 6 search tests green | `npx vitest run tests/catalog/search-service.test.ts` — 2 failed: response still had `catalog_version`; `setRevision` missing | same command — 8/8 | revisions present; lagged text keeps current price | `SearchResponse` dropped `catalog_version` |
| 4.2 | `tests/catalog` | Unit + Postgres | first integration search failed `No current catalog is available` on idempotent publish | idempotent `publish()` skipped current seed | `npx vitest run tests/catalog` — 12 files, 59/59; integration PATCH→worker→search 200 and `data=search=index=1` | HNSW + exact_fallback; orphan 503; fixture seed item_ids preserved | idempotent publish now seeds current |
| 4.3 | suite + harness | Integration + docs | 59 catalog tests green | typecheck first failed (feeds visibility, merge types, Hono `request`) | `npm test` 105/105; `npm run typecheck` 0; `npm run lint` 0; `npm run build` 0 | harness JSON below | docs/flags/scripts only |
| R1 | `tests/catalog/acp-routes.test.ts` + `outbox-worker.test.ts` + `postgres.integration.test.ts` | Unit + Postgres | `npx vitest run tests/catalog/acp-routes.test.ts tests/catalog/outbox-worker.test.ts` — 3 failed (429 on replay, 400 on omitted variants, missing backoff lease) | same RED plus Postgres probes for 20-way POST, missing list_price, and uncovered atomic/filter paths | `npx vitest run tests/catalog` 65/65; `npm test` 111/111 | 20 concurrent POSTs → 1 feed; replay before rate-limit; omitted/empty variants keep variants and bump search_revision; list_price/unit_price round-trip; atomic PATCH rollback; two-merchant isolation; PATCH→SQL→search text/price; tombstone before worker; unknown vs in_stock; combined filters; 101 variants; RFC3339; worker backoff | replay-before-limit; advisory lock; optional variants; persist list/unit price |

## Work Unit Evidence

| Unit | Goal | Focused test command | Result | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | Current-state + API keys | `npx vitest run tests/catalog/migration.test.ts tests/catalog/acp-auth.test.ts` | exit 0; 10/10 | `CATALOG_DATABASE_URL=postgres://catalog:catalog@127.0.0.1:55432/juno_catalog npm run catalog:migrate` | revert `002` + `acp-contract.ts` |
| 2 | ACP routes/merge/ownership | `npx vitest run tests/catalog/acp-routes.test.ts` | exit 0; 7/7 | in-process Hono POST/PATCH/GET | disable `CATALOG_ACP_ENABLED` |
| 3 | Outbox worker + current search | `npx vitest run tests/catalog/outbox-worker.test.ts tests/catalog/search-service.test.ts` | exit 0; 14/14 | `npm run catalog:worker` | disable `CATALOG_WORKER_ENABLED` |
| 4 | Integration, seed, docs | `npx vitest run tests/catalog` then `npm test && npm run typecheck && npm run lint && npm run build` | 59/59 catalog; 105/105 full; typecheck/lint/build exit 0 | `CATALOG_DATABASE_URL=postgres://catalog:catalog@127.0.0.1:55432/juno_catalog CATALOG_EMBEDDING_PROVIDER=deterministic npm run catalog:harness` → `{"feed_status":200,"patch_status":200,"search_status":200,"catalog_version_absent":true,"result_count":1,"revisions":{"data_revision":1,"search_revision":1,"index_revision":1}}` | pause flags; keep SQL |
| 4c | Rate-limit wiring + named revoke/rotate | `npx vitest run tests/catalog` then `npm test && npm run typecheck && npm run lint && npm run build` | 63/63 catalog; 109/109 full; typecheck/lint/build exit 0 | same harness JSON success after continuation | pause flags; `catalog:revoke` / `catalog:rotate` |
| R | remediate-verified-blockers | `npx vitest run tests/catalog` then `npm test && npm run typecheck && npm run lint && npm run build` | 65/65 catalog; 111/111 full; typecheck/lint/build exit 0 | harness re-run after remediation | pause flags; keep SQL |

### Exact final verification

```text
npm test
# Test Files  14 passed (14)
# Tests  111 passed (111)

npm run typecheck   # exit 0
npm run lint        # exit 0
npm run build       # tsc server + vite web; exit 0
```

Remediation `remediate-verified-blockers` re-ran: `npm test` 111/111; typecheck/lint/build exit 0; harness JSON unchanged (`feed/patch/search` 200, no `catalog_version`, revisions 1/1/1). Independent `verify-report.md` FAIL was left in place.

### Harness

```text
CATALOG_DATABASE_URL=postgres://catalog:catalog@127.0.0.1:55432/juno_catalog \
CATALOG_EMBEDDING_PROVIDER=deterministic \
npm run catalog:harness
# {"feed_status":200,"patch_status":200,"search_status":200,"catalog_version_absent":true,"result_count":1,"revisions":{"data_revision":1,"search_revision":1,"index_revision":1}}
```

PostgreSQL was already healthy from `docker-compose.catalog.yml` (`pgvector/pgvector:0.8.1-pg16`). No external blocker.

## Deviations

- Postgres ACP reuses the memory merge/idempotency engine behind a transactional load/persist adapter instead of a second SQL merge implementation.
- Idempotent fixture `publish()` also upserts current-state so search does not depend on a versioned snapshot after a replayed load.
- GET feed/products are read-only (no persist) to avoid rewriting `updated_at`.
- Juno fixture remains seed/test via `catalog:load`; it is not a runtime merchant source.
- No login, portal, OAuth, merchant KYC, promotions, checkout, or payments.
- Raw API keys are never stored; provision/harness print a key once to stdout only.
- Continuation closed the apply-honest gaps: `CATALOG_ACP_RATE_LIMIT` now reaches `PostgresAcpIngestionService` through a process-scoped `AcpWriteGuard` (a fresh inner service per request no longer resets the window); `revokeMerchantApiKey` / `rotateMerchantApiKey` plus `catalog:revoke` / `catalog:rotate` persist only hash/prefix/status.

## Size exception (accepted)

Attempt 2 finished **passed / apply_complete**. The user authorized `size:exception`; the resolved estimate **2550–2950** covers the **2828** measured apply lines. The 1600-line attempt bound and 900–1400 forecast remain historical context only.

Measured ACP apply implementation, excluding OpenSpec propose/spec/design artifacts and excluding the prior `add-juno-catalog-search` tree:

| Bucket | Lines |
|---|---|
| Production (SQL + modules + scripts) | 1964 |
| Tests (`acp-auth`, `acp-routes`, `outbox-worker`, `migration`) | 727 |
| Required ACP doc | 137 |
| **Total** | **2828** |

## Remaining

None for this change. Archive/verify bookkeeping is out of this apply ordinal.
