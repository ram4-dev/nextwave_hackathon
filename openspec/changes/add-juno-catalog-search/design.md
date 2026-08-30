# Design: Juno Catalog Search

## Technical Approach

Add a catalog module beside KYA. Existing Hono `createApp(repo, config)` remains thin; catalog dependencies stay separate from identity `Repository`/`KyaStore`. One PostgreSQL database stores authoritative tables and pgvector projections—there is no separate vector database.

## Architecture Decisions

| Decision | Choice | Alternative | Rationale |
|---|---|---|---|
| Runtime | Router in existing Hono | Separate service | One endpoint does not justify another deployment. |
| Persistence | Catalog port over PostgreSQL/pgvector | Extend `KyaStore` | SQL catalog state does not belong in identity JSON. |
| Search storage | Minimal projection: `item_id`, Spanish `name`, `description`, `item_info`, `embedding` | Copy commerce fields | Merchant, price, currency, availability, and filters stay relational; version/status are nonsearchable linkage. |
| Retrieval | HNSW/lexical IDs; exact fallback only for recognized HNSW index failure | Exact-only/silent fallback | Simulates the index and exposes `search_mode`. |
| Consistency | Discovery and bulk hydration share one active-version transaction/snapshot | Independent queries | Publication cannot mix candidate and authoritative versions. |
| Publication | Immutable candidates; atomic active-version switch | In-place updates | Prevents partial reads and enables version rollback. |

## Data Flow

```text
10 Spanish ARS offers -> validate/normalize -> build minimal text -> embed
  -> hidden version in PostgreSQL -> atomic publish

query -> embed -> PostgreSQL active-version transaction
  -> HNSW + lexical ranked item_ids (over-fetch; exact fallback if eligible)
  -> one bulk hydrate by (catalog_version_id, item_id)
  -> exact authoritative filters -> preserve candidate order -> top_k
```

The adapter runs both stages in one transaction, breaks ranking ties by `item_id ASC`, and hydrates setwise. Missing/version-mismatched candidates return `503 SEARCH_UNAVAILABLE` without partial results. HNSW and exact modes share the hydration/filter stage. Connection or transaction failures never trigger fallback.

PostgreSQL automatically maintains HNSW, GIN, and B-tree after mutations. The offline pipeline owns source sync, Spanish projections, embeddings, validation, and publication—not index synchronization.

## Interfaces / Contracts

```ts
interface SearchProjection {
  catalog_version_id: string; item_id: string;
  name: string; description: string; item_info: string;
  embedding: readonly number[]; is_published: boolean;
}
interface EmbeddingProvider {
  readonly model: string; readonly dimensions: number;
  embed(texts: readonly string[]): Promise<readonly number[][]>;
}
interface CatalogRepository {
  searchActive(input: RepositorySearchInput): Promise<HydratedSearchResult>;
  publish(snapshot: DerivedCatalogSnapshot): Promise<PublishResult>;
  rollback(version: string): Promise<void>;
}
```

`RepositorySearchInput` carries query/vector, provider identity, filters, `candidate_k`, and `top_k`. `HydratedSearchResult` contains version/freshness, ordered authoritative items, and mode. The service maps typed failures to specified 400/503 responses or sanitized `500 INTERNAL_ERROR`.

## File Changes

| Path | Responsibility |
|---|---|
| `src/catalog/{domain,schema,embedding,repository,search,loader}.ts` | Types, strict validation, ports, service, projection, publication. |
| `src/catalog/postgres-repository.ts` | One-snapshot discovery, bulk hydration, filters, fallback classification. |
| `src/server/catalog-routes.ts` | Sole public `POST /v1/catalog/search`; no auth/KYC. |
| `src/server/{app,index}.ts`, `src/config/env.ts` | Dependency wiring, configuration, sanitized errors. |
| `migrations/<version>_juno_catalog.sql` | pgvector extension, versioned tables, constraints, HNSW/GIN/B-tree. |
| `fixtures/juno/catalog.json`, `scripts/load-juno-catalog.ts` | Deterministic fixture and internal offline command. |
| `tests/catalog/`, `package.json`, `package-lock.json`, `README.md`, `FLOW.md`, `docs/JUNO_CATALOG_SEARCH_SPEC.md` | RED tests, dependencies, commands, resolved documentation. |

## Security and Observability

Use strict Zod, bounded input, parameterized SQL, sanitized errors, and environment-only secrets. The unauthenticated route stays local/demo until later auth/rate limiting. External embeddings require query-data egress approval. Log version, latency, counts, mode, and fallback reason; never query, vectors, secrets, or SQL.

## Testing Strategy

Strict TDD: unit-test projection, RRF/order, validation, filters, and errors; route-test with fakes. PostgreSQL tests cover migrations/index mutation, atomic publication, one bulk query, concurrent snapshot consistency, integrity failures, and fallback classification. `EXPLAIN (ANALYZE, BUFFERS)` proves plans; fixed Spanish queries compare HNSW/exact. Run test, typecheck, lint, and build scripts. No E2E/coverage runner exists.

## Threat Matrix

| Boundary | Applicability | Response | RED tests |
|---|---|---|---|
| Documentation-like paths | N/A: fixed JSON input is not executable | No execution boundary | — |
| Git repository selection | N/A: no Git commands | None | — |
| Commit state | N/A: no commit automation | None | — |
| Push state | N/A: no push automation | None | — |
| PR commands | N/A: no PR automation | None | — |

HTTP request/error boundaries are covered by route RED tests; the matrix concerns execution/VCS automation.

## Migration / Rollout

Resolve blockers, provision PostgreSQL/pgvector, migrate, publish the fixture, verify plans/modes/snapshot integrity, then mount locally. Failed loads preserve the prior version. Rollback unmounts the router or republishes the retained version; additive tables remain until reviewed cleanup.

## Apply-Blocking Open Questions

- [ ] Select embedding provider, model, dimension, and data-egress policy.
- [ ] Select PostgreSQL client and migration mechanism.
- [ ] Define reproducible PostgreSQL/pgvector provisioning for local development and CI.
- [ ] Approve exact adapter error classification for HNSW fallback after client selection.
