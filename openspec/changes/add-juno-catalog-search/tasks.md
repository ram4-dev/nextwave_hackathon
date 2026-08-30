# Tasks: Juno Catalog Search

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | 700–950 lines |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 projection → PR 2 SQL → PR 3 retrieval/HTTP → PR 4 wiring/docs |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | Projection contracts and embedding pipeline | PR 1 | `npm test -- tests/catalog/projection.test.ts tests/catalog/contracts.test.ts` | `app.request` fakes; no DB | Revert projection, fixture, unit tests |
| 2 | Versioned rows, same-DB projection, indexes, loader | PR 2 | `npm test -- tests/catalog/postgres.integration.test.ts tests/catalog/loader.test.ts` | Approved pgvector >=0.8 harness; blocked until chosen | Revert migrations, adapter, loader, provisioning |
| 3 | Retrieval, hydration, fallback, route | PR 3 | `npm test -- tests/catalog/search-service.test.ts tests/catalog/routes.test.ts` | `app.request` plus real-DB HNSW/fallback | Remove catalog route/service; retain KYA |
| 4 | Wiring, docs, release evidence | PR 4 | `npm test && npm run typecheck && npm run lint && npm run build` | Load fixture, then local `POST /v1/catalog/search` | Revert config/docs; retain prior version |

## Execution Order and Parallel Safety

Apply 1→2→3→4. Unit 1 is parallel-safe; later units depend on `item_id`. Resolve embedding model/dimension, PostgreSQL client/migrations, provisioning, and HNSW error classification before apply; do not guess.

## Phase 1: Projection and Pipeline (PR 1)

- [x] 1.1 **RED:** Test exactly 10 Argentine Spanish ARS offers, multiple merchants, no URLs; projection contains only `item_id`, name, description, item_info, embedding; assert no hard fields, strict input, deterministic rank (`tests/catalog/{projection,contracts,ranking}.test.ts`).
- [x] 1.2 **GREEN:** Add `src/catalog/{domain,schema,embedding,projection}.ts` and `fixtures/juno/catalog.json`; generate compatible embeddings; pass RED and rollback these files only.
- [x] 1.3 **REFACTOR:** Keep linkage separate; preserve KyaStore isolation; verify `npm run typecheck`.

## Phase 2: PostgreSQL and Ingestion (PR 2)

- [x] 2.1 **RED:** Test authoritative versioned merchant/`item_id` rows and same-DB projections, constraints, atomic/idempotent publication, and index mutation/readiness after row/version changes (`tests/catalog/{postgres.integration,loader}.test.ts`); document DB harness first.
- [x] 2.2 **GREEN:** Add `migrations/<version>_juno_catalog.sql`, `src/catalog/{postgres-repository,loader}.ts`, and `scripts/load-juno-catalog.ts`; generate embeddings, publish stages atomically; PostgreSQL auto-maintains HNSW/GIN/B-tree.
- [x] 2.3 **REFACTOR:** Verify parameterized SQL and transaction boundaries with `npm run lint`; revert persistence files only.

## Phase 3: Retrieval and HTTP (PR 3)

- [x] 3.1 **RED:** Test `item_id` over-fetch, exactly one bulk hydrate by version+`item_id`s in one transaction/snapshot, authoritative post-hydration filters, preserved order/top_k, no N+1, projection cannot override hard values, missing/mismatched 503/no partials, no side effects (`tests/catalog/{search-service,routes}.test.ts`).
- [x] 3.2 **GREEN:** Implement HNSW-primary discovery/hydration in `src/catalog/{search,postgres-repository}.ts`; share hydration with exact fallback, never fallback on general DB failures; add `src/server/catalog-routes.ts` errors.
- [x] 3.3 **REFACTOR:** Wire `src/server/{app,index}.ts` and `src/config/env.ts`; verify focused tests/`app.request`, only public route and no auth/KYA access.

## Phase 4: Release Evidence (PR 4)

- [x] 4.1 Update `README.md`, `FLOW.md`, and `docs/JUNO_CATALOG_SEARCH_SPEC.md`; run Unit 4 and record load/search plus HNSW/fallback evidence.

### Post-verify correction record

The original ten tasks remain complete. These checked records remediate the
historical `verify-report.md` FAIL and require a fresh independent verify pass.

- [x] C1 Prove the exact production HNSW SQL shape with a real `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` and use a repeatable-read read-only search snapshot.
- [x] C2 Map failed exact retrieval after explicit unreadiness, and general database connection failure, to sanitized `SEARCH_UNAVAILABLE` without converting ready-HNSW failures into fallback.
- [x] C3 Add real PostgreSQL rollback success coverage, including one published version, projection publication flags, and restored search version.
- [x] C4 Replace vacuous side-effect/route assertions with real authoritative state before/after search, KyaStore preservation, and mandatory PostgreSQL provisioning.
