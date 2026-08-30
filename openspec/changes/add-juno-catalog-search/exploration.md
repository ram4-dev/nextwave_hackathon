## Exploration: Juno catalog search

### Current State

The repository currently implements the KYA ceremony as a TypeScript/Node.js
application with a Hono API, a Vite client, and Vitest tests. The server is
constructed by `createApp(repo, config)` (`src/server/app.ts:23`), where `repo`
is the KYA-specific `Repository`; the production entry point always supplies a
`JsonFileRepository` backed by `.kya-data/store.json`
(`src/server/index.ts:51-56`). `KyaStore` contains principals, enrollments,
credentials, nonces, KYC sessions, event cursors, and public signing-key
metadata only (`src/persistence/repository.ts:14-40`). There is no catalog
module, SQL migration, PostgreSQL client, pgvector integration, embedding
provider, HNSW index, or catalog route in the codebase.

The existing HTTP error handler maps `DomainError` to 400/401/403/404 and
unexpected errors to 500 (`src/server/app.ts:40-54`); it has no catalog-specific
503 mapping. App tests use `app.request(...)` with `InMemoryRepository`
(`tests/kya.test.ts:1423-1454`), which is a useful route-level pattern but does
not provide PostgreSQL or pgvector integration.

The approved product context is `docs/JUNO_CATALOG_SEARCH_SPEC.md` and the
corresponding FLOW/README sections. It calls for a synthetic Juno snapshot
loaded offline into versioned relational tables, derived embeddings and search
documents, HNSW as the primary vector path, an explicit exact-vector fallback,
lexical search with `tsvector`/GIN, deterministic hybrid ranking, and only
`POST /v1/catalog/search` as the catalog HTTP surface. The route is public in
this slice: no KYC, SIWE, session, KYA credential, payment, or real Juno call.
The spec intentionally leaves the embedding model/dimension and some runtime
provisioning decisions open.

CodeGraph was attempted first as required, but `codegraph status` failed with
`unable to open database file`; the findings below therefore use a bounded
filesystem inspection after that documented fallback. No main OpenSpec domain
specs currently exist under `openspec/specs/`; only project config, change
state, and the existing technical context are present.

### Affected Areas

- `src/catalog/` (new) — domain types, strict request/response validation,
  embedding port, search service, repository port, and offline loader should be
  isolated from KYA state and business rules.
- `src/server/catalog-routes.ts` (new, or equivalent router) — expose the one
  public POST route and map catalog errors without putting SQL/ranking logic in
  `src/server/app.ts`.
- `src/server/app.ts` — accept/inject the catalog search service or router while
  preserving the existing KYA repository and middleware behavior; add a safe
  mapping for catalog 503 errors if they are represented as domain errors.
- `src/server/index.ts` — construct the PostgreSQL catalog adapter and embedding
  provider for the runtime, and decide how readiness/connection failures affect
  startup versus request availability.
- `src/config/env.ts` — likely add non-secret database and catalog settings only
  after the connection, embedding, and versioning contract is resolved.
- `migrations/` (new) — create `pgvector`, versioned catalog/merchant/product/
  search-document tables, constraints, publication invariant, and HNSW/GIN/
  partial B-tree indexes described by the technical spec.
- `fixtures/juno/` (new) — deterministic synthetic merchants, products, offers,
  payment-method/Juno acceptance, and snapshot metadata for loader and tests.
- `tests/catalog/` (new) — pure normalization/ranking tests, loader idempotency
  tests, route contract tests, and PostgreSQL integration/plan tests where an
  actual pgvector service is available.
- `package.json` and `package-lock.json` — currently contain no PostgreSQL
  driver, migration tool, or embedding SDK; the implementation must choose and
  document these dependencies.
- `docs/JUNO_CATALOG_SEARCH_SPEC.md` — source context already defines the
  logical schema and API contract; implementation should resolve only its
  explicitly deferred choices rather than duplicate or silently change it.

### Approaches

1. **Separate catalog ports and PostgreSQL adapter injected into Hono** — keep
   `Repository`/`KyaStore` unchanged, define a catalog repository/search-service
   boundary, implement SQL/pgvector behind it, and inject the service into a
   dedicated Hono router.
   - Pros: preserves KYA isolation; permits in-memory fakes for route tests and
     a real PostgreSQL adapter for HNSW behavior; supports future auth as route
     middleware; keeps embeddings and SQL out of handlers.
   - Cons: introduces explicit dependency wiring and a new database lifecycle;
     requires a decision on PostgreSQL provisioning, migrations, driver, and
     embedding implementation.
   - Effort: Medium/High

2. **Extend the existing `Repository` and `KyaStore` with catalog state** — add
   catalog arrays or database methods to the current persistence abstraction and
   use the same repository in the new route.
   - Pros: fewer constructor parameters and superficially simpler tests.
   - Cons: couples catalog lifecycle to identity/KYC persistence, conflicts with
     the approved requirement not to modify `KyaStore`, cannot model PostgreSQL
     transactions/HNSW naturally, and risks contaminating identity data paths.
   - Effort: Medium initially, High to undo

3. **Run a separate catalog HTTP service** — put PostgreSQL/search behind a
   second process and have the current Hono API proxy the route.
   - Pros: strong runtime isolation and independent scaling.
   - Cons: adds an internal network contract, process/deployment complexity,
     proxy failure modes, and more work for a single MVP endpoint; it does not
     remove the need for the same schema and search boundaries.
   - Effort: High

### Recommendation

Use Approach 1. Define a catalog-specific port and service, implement a real
PostgreSQL/pgvector adapter with HNSW as the normal path and an explicit exact
scan fallback, and mount a dedicated public router from `createApp`. Keep the
existing JSON KYA repository untouched. The loader should publish a complete
candidate snapshot transactionally, and the search service should read only the
active version, apply exact filters in SQL, fuse semantic and lexical rankings,
and rehydrate response fields from relational tables. This matches the approved
spec while making every future boundary (auth middleware, real Juno feed, and
embedding provider) replaceable.

For tests, start with deterministic pure tests and an injected fake repository/
embedding provider, then add PostgreSQL integration tests for migrations,
constraints, HNSW readiness/fallback, publication atomicity, and `EXPLAIN` plans
when a pgvector-capable database is available. Do not claim HNSW behavior from
an in-memory fake alone.

### Risks

- The embedding model and vector dimension are unresolved; a physical
  `vector(D)` migration cannot be finalized until they are fixed.
- PostgreSQL/pgvector is not currently part of the repository runtime or local
  test setup. Without a reproducible database service, migrations and HNSW
  behavior cannot be fully verified.
- HNSW filtering and planner behavior depend on explicit published predicates,
  iterative scans, candidate sizing, and index configuration; a small fixture
  can hide recall or latency problems.
- The current generic error mapper would otherwise turn catalog availability,
  embedding, and search failures into the wrong HTTP status; this must be
  covered by route tests without leaking SQL/provider details.
- Atomic publication must keep the previous version readable if loading,
  validation, embedding, or index preparation fails; cleanup/purge must remain
  outside the publication transaction.
- Public search has no auth or rate limiting in this slice. Exposing it beyond
  local/demo use before the later auth decision could create abuse and cost
  risk.
- Exact fallback must be activated only by an explicit readiness/index failure,
  not by an unobservable planner sequential scan or a general database outage.
- `npm test` cannot currently run because `node_modules` is absent and the
  `vitest` binary is unavailable; baseline test results require dependency
  installation before implementation verification.

### Unresolved Questions

- Which embedding model/provider and vector dimension are authorized for the
  first migration, and is the provider local/deterministic or external?
- Which PostgreSQL client and migration mechanism should the repository adopt?
- How will local development and CI provision PostgreSQL with `pgvector >= 0.8`
  reproducibly (container, managed instance, or another approved mechanism)?
- Should catalog database unavailability fail application startup or return the
  specified 503 responses while KYA routes remain available?
- What exact readiness probe proves the HNSW index is available, and which
  database errors qualify for the controlled exact fallback?
- What fixture size and fixed query corpus are required to make HNSW recall and
  `EXPLAIN` assertions meaningful?
- What is the intended offline loader command and its source format/versioning
  behavior for full snapshots, updates, and deletions?
- Does the response freshness field use the minimum timestamp across merchant,
  product, and offer, or a separately defined snapshot timestamp?

### Ready for Proposal

Yes, with the unresolved choices above surfaced to the proposal/review round.
The next SDD phase should turn this recommendation into a focused proposal that
explicitly records scope, rollback of a failed catalog publication, dependency
and database provisioning decisions, and the review gate before spec/design or
implementation.
