# Tasks: ingesta ACP incremental

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 2.200–3.000 (incluye store/worker PostgreSQL y tests) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 persistencia/auth → PR 2 ingesta → PR 3 worker/búsqueda → PR 4 integración/docs |
| Delivery strategy | ask-on-risk; `size:exception` accepted |
| Chain strategy | size-exception |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: size-exception
400-line budget risk: High

### Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Current-state, revisiones, API keys | PR 1 | `npx vitest run tests/catalog/{acp-auth,migration}.test.ts` | `catalog:up` + `catalog:migrate` | Migración/auth |
| 2 | Rutas ACP, merge, ownership | PR 2 | `npx vitest run tests/catalog/acp-routes.test.ts` | `curl` PATCH/GET, dos merchants | Rutas/wiring |
| 3 | Outbox, worker y búsqueda current | PR 3 | `npx vitest run tests/catalog/{outbox-worker,search-service}.test.ts` | PATCH → worker → search | Worker/proyección/search |
| 4 | Integración, seed, rollback, docs | PR 4 | `npm test && npm run typecheck && npm run lint && npm run build` | PostgreSQL integration | Scripts/docs/flag |

## Phase 1: Foundation y RED de persistencia

- [x] 1.1 RED: probar esquema current-state, identidad `(feed_id, product_id, variant_id)` y tres revisiones en `tests/catalog/migration.test.ts` (dep: ninguna; acepta migración; verificar: `npx vitest run tests/catalog/migration.test.ts`; rollback: tests).
- [x] 1.2 RED→GREEN: probar e implementar API key hash-only, revocación y ownership en `tests/catalog/acp-auth.test.ts`, `src/catalog/acp-contract.ts`, dominio/repositorio y `migrations/002_acp_catalog_current.sql` (dep: 1.1; acepta 401/404 fail-closed; verificar: `npx vitest run tests/catalog/acp-auth.test.ts`; rollback: migración/módulos).

## Phase 2: Ingesta ACP y RED de contrato

- [x] 2.1 RED: cubrir rutas ACP, headers, AR/es-AR/ARS, límites, errores, merge y replay/colisión en `tests/catalog/acp-routes.test.ts` (dep: 1.2; acepta contrato verificable; verificar: `npx vitest run tests/catalog/acp-routes.test.ts`; rollback: tests).
- [x] 2.2 GREEN: implementar `src/catalog/ingestion.ts`, `src/server/acp-catalog-routes.ts` y `src/server/{app,index}.ts` con transacción, receipt y outbox (dep: 2.1; acepta `200 {id,accepted:true}`; verificar: mismo comando; rollback: rutas/wiring).

## Phase 3: Proyección eventual y RED de concurrencia

- [x] 3.1 RED: probar outbox durable, lease/`SKIP LOCKED`, retries/dead-letter, interrupción, stale revisions y tombstones en `tests/catalog/outbox-worker.test.ts` (dep: 2.2; acepta recuperación sin huérfanos; verificar: `npx vitest run tests/catalog/outbox-worker.test.ts`; rollback: tests).
- [x] 3.2 GREEN: implementar `src/catalog/reindex-worker.ts`, `projection.ts`, documentos current y comando worker (dep: 3.1; acepta upsert condicionado por `search_revision`; verificar: mismo comando; rollback: worker/proyección).

## Phase 4: Búsqueda y entrega

- [x] 4.1 RED: probar HNSW/fallback, hidratación SQL, revisiones, ausencia de `catalog_version`, filtros AR/ARS/in_stock y errores en `tests/catalog/{search-service,postgres.integration}.test.ts` (dep: 3.2; acepta datos actuales; verificar: `npx vitest run tests/catalog/search-service.test.ts`; rollback: tests).
- [x] 4.2 GREEN: adaptar `src/catalog/{domain,repository,postgres-repository,search}.ts`, tests y fixture/seed Juno (dep: 4.1; acepta búsqueda HNSW y fallback; verificar: `npx vitest run tests/catalog`; rollback: catálogo/search).
- [x] 4.3 Integrar y documentar rollback (pausar rutas/worker, conservar SQL), actualizar scripts, `README.md`, `FLOW.md`, `docs/IMPLEMENTATION.md` y ejecutar suite completa (dep: 4.2; evidencia: PATCH→worker→search; verificar: `npm test && npm run typecheck && npm run lint && npm run build`; rollback: scripts/docs/flag).

## Threat matrix

Todas las filas del diseño están marcadas `N/A`; no requieren RED.
