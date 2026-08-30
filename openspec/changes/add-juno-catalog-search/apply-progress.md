# Apply Progress: Juno Catalog Search

## Work Unit 1: Projection Contracts and Embedding Pipeline

**Status:** Complete

The unit establishes the isolated catalog domain, strict synthetic-fixture and
search-request validation, a minimal searchable projection, a local 384-d
embedding contract, and deterministic hybrid ranking. It does not access
`KyaStore`, auth state, PostgreSQL, or HTTP routing.

### Completed Tasks

- [x] 1.1 RED projection, contract, and deterministic-ranking tests
- [x] 1.2 GREEN catalog domain/schema/embedding/projection implementation and fixture
- [x] 1.3 REFACTOR linkage isolation and TypeScript verification

### TDD Cycle Evidence

| Task | Test file | Layer | Safety net | RED | GREEN | Triangulate | Refactor |
|---|---|---|---|---|---|---|---|
| 1.1 | `tests/catalog/{projection,contracts,ranking}.test.ts` | Unit | N/A: new catalog test files | Cursor chronology: tests preceded catalog modules and the initial focused run failed on missing imports; independently inspected | `npm test -- tests/catalog/projection.test.ts tests/catalog/contracts.test.ts tests/catalog/ranking.test.ts` passed 10/10 | Fixture accept/reject cases, payload versus hard-field cases, and multi-list RRF/tie cases | Ranking comparator keeps `item_id ASC` as the deterministic tie-breaker |
| 1.2 | `tests/catalog/{projection,contracts}.test.ts` | Unit | Same focused suite above | Same RED contract evidence as 1.1 | Same focused suite passed 10/10 after the minimum modules and fixture existed | Valid fixture and malformed count/market/currency/URL/Juno/ID-reference variants | Projection payload remains separate from technical linkage |
| 1.3 | `tests/catalog/{projection,contracts,ranking}.test.ts` | Unit | Focused suite passed 10/10 before verification | Approval coverage from the completed unit tests | `npm run typecheck` exited 0 | KYA-isolation scan found no KYA/auth imports in Unit 1 files | No behavior-changing refactor required after the deterministic comparator audit |

### Work Unit Evidence

| Evidence | Result |
|---|---|
| Focused test command | `npm test -- tests/catalog/projection.test.ts tests/catalog/contracts.test.ts tests/catalog/ranking.test.ts` — exit 0; 3 files and 10 tests passed |
| Runtime harness | `npx tsx --eval "...validate fixture, build projection, verify payload keys/dimensions, and repeat deterministic embedding..."` — exit 0; `{\"offers\":10,\"payloadKeys\":[\"description\",\"embedding\",\"item_id\",\"item_info\",\"name\"],\"dimensions\":384,\"deterministic\":true}` |
| Type safety | `npm run typecheck` — exit 0 |
| Rollback boundary | Revert `src/catalog/{domain,schema,embedding,projection,ranking}.ts`, `fixtures/juno/catalog.json`, the three Unit 1 tests, and the Unit 1 package dependencies; this does not remove KYA behavior or later catalog persistence/routing work |

### PR Boundary

- Mode: chained PR slice (`feature-branch-chain`)
- Intended boundary: PR 1, base `feat/juno-catalog`, head `feat/juno-catalog-projection`
- No commit or branch operation was performed by this apply unit.

### Remaining Work

- [ ] 2.1–2.3 PostgreSQL and ingestion
- [ ] 3.1–3.3 retrieval and HTTP
- [ ] 4.1 release evidence

### Notes

The first ad-hoc runtime attempt used top-level `await` in `tsx --eval`, which
the CJS eval mode rejects. Retrying the identical invariant inside an async IIFE
completed successfully; no product code changed for that harness correction.

## Work Unit 2: Versioned PostgreSQL Ingestion and Publication

**Status:** Complete

The one-database PostgreSQL/pgvector slice persists versioned merchants,
products, and minimal projections; publishes them atomically; and retains only
complete snapshots as rollback targets. It remains independent of KYA storage.

### Completed Tasks

- [x] 2.1 RED real PostgreSQL publication, FK, migration, lifecycle, and index tests
- [x] 2.2 GREEN safe persistence behavior and reproducible pgvector harness
- [x] 2.3 REFACTOR parameterized SQL, transaction audit, lint, and typecheck

### TDD Cycle Evidence

| Task | Test file | Layer | Safety net | RED | GREEN | Triangulate | Refactor |
|---|---|---|---|---|---|---|---|
| 2.1 | `tests/catalog/{postgres.integration,loader}.test.ts` | PostgreSQL integration + unit | `npm test -- tests/catalog/postgres.integration.test.ts tests/catalog/loader.test.ts` — 6/6 passed before the new assertions | New lifecycle test first failed because a superseded version was reported as `published`; it also defined rejection of a `building` rollback target | Focused command passed 9/9 after the contract/repository correction | Failed projection FK preserves active snapshot; malformed migration remains unrecorded and leaves no probe table; a newly published version has 10 products/documents and valid HNSW/GIN/B-tree indexes | Test cleanup removes temporary versions, rows, migration directory, and probe table without altering the fixture version |
| 2.2 | `tests/catalog/{postgres.integration,loader}.test.ts` | PostgreSQL integration + unit | Same 6/6 baseline | Acceptance coverage was added before correcting the misleading status/unsafe rollback behavior | Same focused command passed 9/9 against `pgvector/pgvector:0.8.1-pg16` | Repeated active version, retained superseded version, invalid building target, projection FK failure, and dropped-index fallback cases | `PublishResult.status` now reports the actual retained lifecycle status; publication SQL remains parameterized |
| 2.3 | `tests/catalog/postgres.integration.test.ts` | Integration | Focused suite passed 9/9 before audit | Approval coverage from the green integration tests | `npm run lint` and `npm run typecheck` both exited 0 | Migration failure and version mutation checks execute through real PostgreSQL | No behavior-changing refactor beyond the minimal lifecycle-contract correction |

### Work Unit Evidence

| Evidence | Result |
|---|---|
| Focused test command | `npm test -- tests/catalog/postgres.integration.test.ts tests/catalog/loader.test.ts` — exit 0; 2 files and 9 tests passed |
| Runtime harness | `npm run catalog:up` — exit 0; Docker service healthy. `psql` confirmed `vector` extension `0.8.1` and `hnsw:true` for `catalog_search_embedding_hnsw` |
| Static verification | `npm run lint` — exit 0; `npm run typecheck` — exit 0 |
| Rollback boundary | Revert `migrations/001_juno_catalog.sql`, `src/catalog/{postgres-repository,loader,migrate}.ts`, `scripts/{load-juno-catalog,migrate-juno-catalog}.ts`, `docker-compose.catalog.yml`, Unit 2 tests, and required PostgreSQL dependencies; KYA and later route/search wiring remain intact |

### Cross-Unit Contract Correction

`src/catalog/domain.ts` is owned by Unit 1, but Unit 2's real lifecycle test
proved that its `PublishResult.status: 'published'` contract was misleading for
an idempotent retained `superseded` snapshot. With explicit coordinator approval,
the status is now `CatalogVersionStatus`; the PostgreSQL adapter returns the
actual status. `rollback()` now locks and accepts only `published` or
`superseded` versions, rejecting `building` and `failed` candidates.

### PR Boundary

- Mode: chained PR slice (`feature-branch-chain`)
- Intended boundary: PR 2, base `feat/juno-catalog-projection`, head `feat/juno-catalog-postgres`
- No commit or branch operation was performed by this apply unit.

### Remaining Work

- [ ] 3.1–3.3 retrieval and HTTP
- [ ] 4.1 release evidence

## Work Unit 3: Retrieval and Public HTTP Search

**Status:** Complete

HNSW discovery is now a real transaction-local primary path: the repository
disables sequential and bitmap scans only for the primary vector query, while
the exact path remains an explicit probe-based fallback. Both paths converge on
the same ranked-ID hydration transaction and authoritative filters.

### Completed Tasks

- [x] 3.1 RED retrieval, hydration, public-route, integrity, and error tests
- [x] 3.2 GREEN explicit-probe fallback and transaction-local HNSW primary path
- [x] 3.3 REFACTOR sanitized public errors and route wiring verification

### TDD Cycle Evidence

| Task | Test file | Layer | Safety net | RED | GREEN | Triangulate | Refactor |
|---|---|---|---|---|---|---|---|
| 3.1 | `tests/catalog/{search-service,routes,postgres.integration}.test.ts` | Unit, Hono `app.request`, PostgreSQL integration | Existing focused suite passed before new fallback assertion | Explicit-readiness test first failed because a ready index with an HNSW-named query error still selected exact fallback | Focused suite passed 15/15 after fallback classification changed | HNSW primary and dropped-index fallback, one hydration, hard-field authority, filters/rank/top-k, missing candidate, no active catalog, and no KYA mutation | Existing pure service and route seams required no abstraction change |
| 3.2 | `tests/catalog/postgres.integration.test.ts` | PostgreSQL integration | Same focused suite | The red readiness assertion constrained fallback before repository changes | HNSW path reports `hnsw`; dropped index reports `exact_fallback` with identical results | Real `EXPLAIN (ANALYZE)` with the same local planner settings produced `Index Scan using catalog_search_embedding_hnsw` | Removed error-string fallback; primary settings are scoped to the active transaction |
| 3.3 | `tests/catalog/routes.test.ts` | Hono `app.request` | Route tests passed before response assertion tightening | Existing candidate route coverage was tightened to the generic 503 contract; no separate historical RED execution was available | Focused suite passed 15/15 | Public request, invalid request, empty result, 503, 500, and KYA-store preservation | Catalog 503 messages are mapped to stable generic text |

### Work Unit Evidence

| Evidence | Result |
|---|---|
| Focused tests | `npm test -- tests/catalog/search-service.test.ts tests/catalog/routes.test.ts tests/catalog/postgres.integration.test.ts` — exit 0; 3 files and 15 tests passed |
| Runtime harness | `docker compose ... psql ... EXPLAIN (ANALYZE)` with `SET LOCAL enable_seqscan = off` and `enable_bitmapscan = off` — actual plan included `Index Scan using catalog_search_embedding_hnsw`; the test suite also exercised real dropped-index `exact_fallback` |
| Static verification | `npm run typecheck` and `npm run lint` — both exit 0 |
| Rollback boundary | Revert Unit 3 changes to `src/catalog/{hnsw,postgres-repository,search,filters,repository}.ts`, `src/server/{catalog-routes,app,index}.ts`, Unit 3 tests, and catalog wiring; no KYA persistence change is required |

### PR Boundary

- Mode: chained PR slice (`feature-branch-chain`)
- Intended boundary: PR 3, base `feat/juno-catalog-postgres`, head `feat/juno-catalog-search`
- No commit or branch operation was performed by this apply unit.

### Remaining Work

- [ ] 4.1 release evidence

## Work Unit 4: Release Evidence

**Status:** Complete — implemented, release-evidenced, pending independent SDD verification.

### Completed Task

- [x] 4.1 Release wiring, docs, real model/load/search evidence, and full repository verification

### TDD Cycle Evidence

| Task | Test file | Layer | Safety net | RED | GREEN | Triangulate | Refactor |
|---|---|---|---|---|---|---|---|
| 4.1 | `tests/catalog/embedding.test.ts` | Unit + real local runtime | Full repository suite | With the boundary temporarily made transparent, the new test failed and exposed `internal ONNX model path and runtime detail` rather than a stable catalog error | Restored the stable `CatalogError('Embedding unavailable', 'EMBEDDING_UNAVAILABLE')`; focused test passed | Real Node 22 execution embedded two Spanish texts to 384 dimensions with L2 norms approximately 1; a second process set `env.allowRemoteModels=false` and embedded from the cached model | Kept the error boundary small; catalog pool remains independently owned by startup/shutdown and docs distinguish release model from deterministic test substitute |

### Work Unit Evidence

| Evidence | Result |
|---|---|
| Runtime and provider | Node `v22.23.2` via `npx -y node@22`. `TransformersEmbeddingProvider` embedded `papas fritas crocantes` and `yerba mate suave`: dimensions `[384,384]`, norms `[1.0000001792463387,0.9999997671315274]`. A new Node 22 process with `env.allowRemoteModels=false` returned one 384-d vector with norm `0.9999999157958571`, proving cached local inference without a model-network request. A corrupt partial ONNX cache was moved recoverably before the successful download. |
| Real PostgreSQL load | `npm run catalog:up`; Node 22 `scripts/migrate-juno-catalog.ts` returned `catalog migrations applied=none`; Node 22 `scripts/load-juno-catalog.ts` published the 10-offer fixture using `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, 384 dimensions, version `juno-mock-2026-08-29-001`. |
| Public endpoint | A local Node 22 server with the same `CATALOG_DATABASE_URL` and model returned `200` for `POST /v1/catalog/search` with `{"query":"papas fritas","top_k":5}`. Response used `search_mode: "hnsw"`, contained ARS hard data and no URL, embedding, or auth field. |
| Explicit fallback and restore | On `pgvector/pgvector:0.8.1-pg16`, dropping `catalog_search_embedding_hnsw` yielded the same public query with `search_mode: "exact_fallback"`; recreating the partial HNSW index yielded `search_mode: "hnsw"`. `SELECT extversion ...` confirmed `0.8.1` and a restored index. |
| Full verification | `npm test` — exit 0, 10 files / 76 tests; `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` — all exit 0. The dedicated catalog database was restored to the deterministic fixture after the real-model smoke so the integration harness remains reproducible. |
| Documentation/config | `.env.example`, `README.md`, `FLOW.md`, `docs/{JUNO_CATALOG_SEARCH_SPEC,IMPLEMENTATION,SOURCES}.md` now state Node >=20, AR/ARS/Spanish/10-offer mock, offline projection versus SQL hydration, HNSW primary, readiness-only exact fallback, public endpoint, and deferred auth. |
| Rollback boundary | Revert Unit 4 edits to `src/server/index.ts`, `src/catalog/embedding.ts`, Unit 4 test, config/package/docs, and SDD bookkeeping. This leaves the prior catalog domain, persistence, and route behavior intact. |

### Lifecycle Note

`src/server/index.ts` keeps a dedicated catalog `pg.Pool` only when
`CATALOG_DATABASE_URL` is configured. On `SIGINT`/`SIGTERM`, it stops existing
KYA watchers, awaits `catalogPool.end()`, then exits; it does not change KYA
watcher ownership or storage.

### PR Boundary

- Mode: chained PR slice (`feature-branch-chain`)
- Intended boundary: PR 4, base `feat/juno-catalog-search`, head `feat/juno-catalog-release`
- No commit or branch operation was performed by this apply unit.

### Remaining Work

- [ ] Independent SDD verification and archival only; implementation tasks 1.1–4.1 are complete.

## Post-Verify Correction Batch: `verify-report.md` FAIL Remediation

**Status:** Complete — the historical verification report remains FAIL evidence;
this apply batch is `implemented_pending_verify`, not a verification verdict.

### Completed Correction Records

- [x] C1 Production HNSW query shape, exact-plan evidence, and repeatable-read snapshot
- [x] C2 Explicit-fallback and general-database error mapping
- [x] C3 Successful PostgreSQL rollback coverage
- [x] C4 Meaningful read-only side-effect coverage and visible provisioning behavior

### TDD Correction Evidence

| Record | Test layer | Safety net | RED | GREEN | Triangulation / refactor |
|---|---|---|---|---|---|
| C1 | Real PostgreSQL/pgvector integration | Prior focused catalog command passed 15/15 | New assertions first failed because `lastSearch.snapshotIsolation` was absent; the exact-production SQL export was also absent | Production starts `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, records `SHOW transaction_isolation`, and shares `HNSW_CANDIDATES_QUERY` with real `EXPLAIN` | The real plan contains `catalog_search_embedding_hnsw`; the outer query preserves `catalog_version_id` and `distance,item_id` determinism; test provisioning now fails explicitly rather than silently returning |
| C2 | Repository fake-Pool boundary tests | Same 15/15 focused baseline | Explicit unreadiness plus an exact-vector error returned the raw error; a connection `ECONNREFUSED` escaped before the transaction catch | Exact fallback maps its query failure to `SEARCH_UNAVAILABLE`; `searchActive` owns pool acquisition so general DB connection failure also maps to 503 | Ready-HNSW unknown executor failure still reaches the service as `INTERNAL_ERROR`, proving no error-string fallback was reintroduced |
| C3 | Real PostgreSQL integration | Existing retained-version test passed before coverage expansion | The new success scenario was added before implementation audit; the pre-existing rollback implementation satisfied it | Publishing a newer version, rolling back to the retained complete fixture version, and searching through the adapter passes | Asserts exactly one published version and both versions' `is_published` document counts; cleanup restores the fixture and removes temporary versions |
| C4 | Real PostgreSQL integration + Hono route | Existing focused tests passed | Replaced the vacuous `junoCalls += 0` assertion and type-only `CatalogError` route assertion with stateful checks | Search leaves deterministic fingerprints of catalog versions, authoritative products, and projections unchanged; route preserves `KyaStore` through catalog and unexpected failures | PostgreSQL availability is now a visible prerequisite (configured DB, Docker provision, or clear failure), not an early-return pass |

### Correction Work Unit Evidence

| Evidence | Result |
|---|---|
| Focused command | `npm test -- tests/catalog/postgres.integration.test.ts tests/catalog/search-service.test.ts tests/catalog/routes.test.ts` — exit 0; 3 files / 18 tests. The real pgvector suite executed (no skipped/early-return integration path). |
| HNSW runtime harness | The focused real-DB test runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` over the exported `HNSW_CANDIDATES_QUERY` used in production, within the same repeatable-read transaction and planner settings. Its parsed plan contained `catalog_search_embedding_hnsw`; normal search reported `hnsw`, dropped-index search reported `exact_fallback`. |
| Rollback and no-side-effects harness | Real database test publishes a temporary version, rolls back to the retained fixture version, proves one active version and correct document publication flags, then searches the restored version. The search test compares version/product/document counts and deterministic fingerprints before/after. |
| Full verification | `npm test` — exit 0, 10 files / 79 tests; `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` — all exit 0. |
| Rollback boundary | Revert this correction's changes to `src/catalog/postgres-repository.ts`, `tests/catalog/{postgres.integration,search-service,routes,fakes}.test.ts`, `docs/JUNO_CATALOG_SEARCH_SPEC.md`, and the OpenSpec bookkeeping. This retains the prior catalog implementation but removes the correction evidence. |

### Remaining Work

- [ ] Run an independent SDD verification pass. Do not mark `verify-report.md` PASS or archive until that pass succeeds.
