```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:6aad0725caf7a3f4b6617528b202ad7dc9c548a95bbeb95ae4de748a8d033d20
verdict: pass
blockers: 0
critical_findings: 0
requirements: 10/10
scenarios: 26/26
test_command: npm test
test_exit_code: 0
test_output_hash: sha256:e0f80774a40d26643419ed16257a58d931939c5f652de758c42fad0bd58d92de
build_command: npm run typecheck && npm run lint && npm run build && git diff --check
build_exit_code: 0
build_output_hash: sha256:a11d7023fe363ba99374b55aec3da4e15a657cc2502230380076d672185394e1
```

## Verification Report

**Change**: `add-juno-catalog-search`
**Version**: N/A
**Mode**: Strict TDD

### Completeness

| Metric | Value |
|---|---:|
| Requirements total | 10 |
| Scenarios total | 26 |
| Tasks total | 10 |
| Tasks complete | 10 |
| Tasks incomplete | 0 |

### Build & Tests Execution

**Tests**: PASS — 10 files and 79 tests passed; the PostgreSQL/pgvector suite executed rather than skipping.

```text
npm test
Test Files  10 passed (10)
Tests       79 passed (79)
Exit code   0
Output SHA-256 e0f80774a40d26643419ed16257a58d931939c5f652de758c42fad0bd58d92de
```

**Build and static checks**: PASS.

```text
npm run typecheck && npm run lint && npm run build && git diff --check
TypeScript typecheck passed.
ESLint passed with zero warnings.
Server and Vite/React production builds passed.
git diff --check passed.
Exit code 0
Output SHA-256 a11d7023fe363ba99374b55aec3da4e15a657cc2502230380076d672185394e1
```

**Fresh runtime evidence**:

- Docker Compose reported `pgvector/pgvector:0.8.1-pg16` healthy; PostgreSQL reported vector extension `0.8.1`, exactly one published version, 10 active products, and 10 published search documents.
- A fresh `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` imported and executed the exact exported `HNSW_CANDIDATES_QUERY` under `REPEATABLE READ READ ONLY` and the production planner settings. Its parsed plan contained `catalog_search_embedding_hnsw`. Runtime evidence SHA-256: `c5e81a67492e80b4f116021251b71eea0135783e678eb4c71bf21be9acf557fd`.
- A fresh offline-cache Transformers run set `env.allowRemoteModels=false` and produced a normalized 384-dimensional vector for Spanish text with `Xenova/paraphrase-multilingual-MiniLM-L12-v2`. Runtime evidence SHA-256: `4d84958e1e1706dcccacab0d708ef220f88fd2ca897b2932ff385bb2013e73f1`.
- A clean temporary PostgreSQL database was migrated and loaded with the real Transformers provider, then exercised through Hono. `POST /v1/catalog/search` returned `200`, `search_mode: hnsw`, five ARS results, and no URL or embedding. The exact temporary database was dropped afterward. Runtime evidence SHA-256: `10e3916a5db484a836ee9334d3249b5787a75eae06bcf99d949b72f9e1e67cfc`.

**Coverage**: Not available — no coverage tool or script is configured.

### Spec Compliance Matrix

| Requirement | Scenario | Passing runtime evidence | Result |
|---|---|---|---|
| ING-001 | Accepted fixture | `contracts.test.ts > accepts a fixture...`; `projection.test.ts > accepts exactly 10...` | ✅ COMPLIANT |
| ING-001 | Rejected fixture | `contracts.test.ts > rejects the whole candidate...` | ✅ COMPLIANT |
| ING-002 | Invalid offer | `contracts.test.ts > rejects the whole candidate...` covers duplicate and orphan offers | ✅ COMPLIANT |
| ING-003 | Complete derivation | `loader.test.ts > publishes exactly 10 projections...`; projection key test | ✅ COMPLIANT |
| ING-003 | Commerce values stay authoritative | Projection hard-field exclusion plus service authoritative-value test | ✅ COMPLIANT |
| ING-003 | Projection mismatch | Real PostgreSQL same-version FK failure test | ✅ COMPLIANT |
| ING-003 | Derivation failure | `loader.test.ts > rejects the complete candidate when embedding derivation fails` | ✅ COMPLIANT |
| ING-004 | Successful publication | Real PostgreSQL publication and active-version assertions | ✅ COMPLIANT |
| ING-004 | Repeated load | Loader fake and real PostgreSQL idempotency assertions | ✅ COMPLIANT |
| ING-004 | Failed load preservation | Real PostgreSQL projection-FK failure preserves the active snapshot | ✅ COMPLIANT |
| ING-004 | Rollback | Real adapter publishes a newer snapshot, rolls back, checks both versions' document flags, checks one active version, and searches the restored version | ✅ COMPLIANT |
| SEARCH-001 | Public valid request | Hono `app.request` without credentials plus clean real-provider/real-DB runtime | ✅ COMPLIANT |
| SEARCH-001 | Invalid request | Contract and Hono route validation tests cover strict fields, query, and bounds; malformed JSON is mapped by the same route boundary | ✅ COMPLIANT |
| SEARCH-002 | Authoritative values override projection text | `search-service.test.ts > uses authoritative hard fields...` | ✅ COMPLIANT |
| SEARCH-002 | One bulk hydration | Service fake and real repository diagnostic both assert one hydration | ✅ COMPLIANT |
| SEARCH-002 | Hydration integrity failure | `search-service.test.ts > returns SEARCH_UNAVAILABLE without partials...` | ✅ COMPLIANT |
| SEARCH-002 | No matches | Hono route returns `200` with an empty result list after exact filters exclude every candidate | ✅ COMPLIANT |
| SEARCH-002 | No active catalog | Service no-published-version test returns `CATALOG_UNAVAILABLE` | ✅ COMPLIANT |
| SEARCH-003 | Semantic discovery | Real PostgreSQL search finds `item_bastones_crocantes` for `papas fritas` | ✅ COMPLIANT |
| SEARCH-003 | Exact filters | Service and route tests assert authoritative merchant/currency filters, order, and `top_k` | ✅ COMPLIANT |
| SEARCH-004 | Primary path | Exact production SQL constant has a fresh real plan containing `catalog_search_embedding_hnsw`; runtime reports `hnsw` | ✅ COMPLIANT |
| SEARCH-004 | Explicit degradation | Real PostgreSQL test drops HNSW, gets identical results through `exact_fallback`, and restores the index | ✅ COMPLIANT |
| SEARCH-004 | Both paths fail | Explicit unreadiness plus exact-query failure returns sanitized `SEARCH_UNAVAILABLE`; route maps it to 503 | ✅ COMPLIANT |
| SEARCH-005 | Query vectorization failure | Service prevents repository search; provider error boundary returns sanitized `EMBEDDING_UNAVAILABLE` | ✅ COMPLIANT |
| SEARCH-006 | Search has no commerce side effects | Read-only real transaction plus catalog fingerprints before/after and route-level `KyaStore` before/after assertions | ✅ COMPLIANT |
| SEARCH-006 | Unexpected failure | Ready-HNSW unexpected failure does not fallback; route returns sanitized `500 INTERNAL_ERROR` | ✅ COMPLIANT |

**Compliance summary**: 26/26 scenarios compliant and 10/10 requirements complete.

### Correctness (Static Evidence)

| Requirement | Status | Notes |
|---|---|---|
| ING-001 | ✅ Implemented | Strict fixture schema enforces 10 offers, multiple AR merchants, ARS, Juno acceptance, and no URL. |
| ING-002 | ✅ Implemented | Unique IDs, merchant linkage, integer safe prices, and availability are validated and constrained. |
| ING-003 | ✅ Implemented | Search payload is minimal; relational foreign keys bind document and product by version and item ID. |
| ING-004 | ✅ Implemented | Publication, idempotency, failure preservation, single-active-version invariant, and rollback are transactional. |
| SEARCH-001 | ✅ Implemented | The only catalog route is the unauthenticated strict `POST /v1/catalog/search`. |
| SEARCH-002 | ✅ Implemented | Ranked IDs hydrate once from authoritative relational rows in the same transaction. |
| SEARCH-003 | ✅ Implemented | Weighted RRF, stable tie-breaking, authoritative post-hydration filters, and `top_k` are present. |
| SEARCH-004 | ✅ Implemented | HNSW uses the verified production query; exact fallback is readiness-only and shares hydration/ranking. |
| SEARCH-005 | ✅ Implemented | Provider/model/dimension failures are sanitized and retrieval does not start after vectorization failure. |
| SEARCH-006 | ✅ Implemented | Search is read-only, isolated from KYA and commerce operations, and sanitizes unexpected failures. |

### Coherence (Design)

| Decision | Followed? | Notes |
|---|---|---|
| Catalog isolated from `KyaStore` | ✅ Yes | No catalog persistence was added to identity JSON; KyaStore behavior is unchanged by catalog requests. |
| Minimal vector projection plus SQL hydration | ✅ Yes | Commerce fields remain authoritative in PostgreSQL and are bulk-hydrated. |
| Atomic immutable publication and rollback | ✅ Yes | Version/document publication flags switch in a transaction; retained complete snapshots can be restored. |
| HNSW primary, explicit exact fallback | ✅ Yes | Readiness alone selects fallback; ready-path unexpected errors never degrade silently. |
| One active-version snapshot | ✅ Yes | Search starts `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`; discovery and hydration share the client. |
| Local 384-dimensional multilingual embeddings | ✅ Yes | Fresh cached offline Transformers execution and a clean real endpoint run passed. |

### TDD Compliance

| Check | Result | Details |
|---|---|---|
| TDD evidence reported | ✅ | Work units 1–4 and corrections C1–C4 are recorded in `apply-progress.md`. |
| All tasks have tests | ✅ | 10/10 implementation tasks reference existing test files. |
| RED confirmed | ⚠️ | Test files and correction RED evidence exist; task 3.3 records that no separate historical RED execution was available. |
| GREEN confirmed | ✅ | All 33 catalog tests and all 79 repository tests pass now. |
| Triangulation adequate | ✅ | Alternate fixture, validation, lifecycle, HNSW/fallback, hydration, HTTP, and error cases have distinct expectations. |
| Safety net for modified files | ✅ | Focused baselines and fresh full-suite/static checks are recorded. |

**TDD Compliance**: 5/6 checks passed without qualification; the remaining item is historical process evidence, not a current behavior defect.

### Test Layer Distribution

| Layer | Tests | Files | Tools |
|---|---:|---:|---|
| Unit | 25 | 7 | Vitest |
| Integration | 8 | 2 | Vitest, Hono `app.request`, PostgreSQL/pgvector |
| E2E | 0 | 0 | Not installed |
| **Catalog total** | **33** | **8** | |

### Changed File Coverage

Coverage analysis skipped — no coverage tool detected.

### Assertion Quality

**Assertion quality**: ✅ All assertions verify real behavior. Fixed-size loops have non-empty preconditions, the HNSW assertion imports production SQL, database provisioning fails visibly, and KYA/catalog state assertions compare observable before/after values.

### Quality Metrics

**Linter**: ✅ No errors or warnings.
**Type Checker**: ✅ No errors.
**Build**: ✅ Server and web production builds passed.
**Diff hygiene**: ✅ `git diff --check` passed.

### Issues Found

**CRITICAL**: None.

**WARNING**:

1. Strict TDD chronology for task 3.3 is not independently reproducible: `apply-progress.md` records that no separate historical RED execution was available. Current route behavior is fully green.
2. The contextual technical document still leaves a fixed-corpus HNSW-versus-exact recall benchmark unchecked. The authoritative 10 requirements and 26 scenarios are covered, and the current real test compares HNSW and exact results for the fixed `papas fritas` query, but there is no broader recall metric.

**SUGGESTION**: Add a larger fixed Spanish query corpus and an explicit recall threshold when the catalog grows beyond the approved 10-offer MVP.

### Verdict

PASS WITH WARNINGS

All 10 requirements and 26 scenarios pass with fresh runtime evidence. The four former blockers are corrected, the implementation is archive-ready, and the remaining findings concern historical TDD chronology and future recall benchmarking rather than current acceptance behavior.
