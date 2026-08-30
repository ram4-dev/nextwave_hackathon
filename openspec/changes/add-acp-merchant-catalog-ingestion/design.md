# Diseño: ingesta incremental de catálogo mediante ACP

## Enfoque técnico

Se conserva PostgreSQL/pgvector, HNSW, ranking híbrido e hidratación SQL. `publish(snapshot)` se reemplaza por estado actual por feed y una outbox: el request confirma datos duros y el worker actualiza la proyección.

```text
merchant → ACP + API key Bearer → authorizer → transacción merge/revision/receipt/outbox → accepted
                                                              ↓
búsqueda ← hidratación SQL actual ← IDs HNSW+lexical ← documento actual ← worker local
```

## Decisiones de arquitectura

| Tema | Elección y razón | Alternativa descartada |
|---|---|---|
| Persistencia | Mismo PostgreSQL; tablas current-state y outbox. Evita otra fuente de verdad. | Nueva DB/vector store. |
| Unidad | Variant vendible; `item_id` interno referencia la clave única `(feed_id, external_product_id, external_variant_id)`. IDs ACP se preservan. | `Product.id` global, que colisiona entre feeds. |
| Consistencia | SQL inmediato; item nuevo espera índice y el existente conserva documento. La respuesta usa `data_revision`, `search_revision` e `index_revision`, sin `catalog_version`. | Embedding dentro del PATCH. |
| Merge | Campos presentes reemplazan; ausentes y productos/variants omitidos permanecen. Arrays presentes, salvo `variants`, reemplazan completos; variants se fusionan por `id`. | Reemplazo del feed completo. |
| Baja | `discontinued` o `available=false` oculta inmediatamente mediante SQL; queda tombstone. URL/media se guardan fuera del texto/vector y no salen en búsqueda MVP. | Borrado físico o datos duros en la proyección. |

## Componentes, contratos y fallos

Las rutas oficiales son POST/GET feed y PATCH/GET products según [Overview](https://developers.openai.com/commerce/specs/api/overview), [Feeds](https://developers.openai.com/commerce/specs/api/feeds) y [Products](https://developers.openai.com/commerce/specs/api/products). POST feed devuelve `200`; GET products entrega el array completo, sin paginación ACP. El boundary procesa headers comunes; mutaciones exigen bearer, JSON, versión, idempotencia, request ID y timestamp. El MVP exige feed `target_country=AR`, precios ARS y `Accept-Language: es-AR`; el contenido searchable es español.

`MerchantFeedAuthorizer` recibe la API key Bearer y, para acceso, `feed_id`; valida su hash/estado y devuelve `merchant_id`. El alta y entrega son manuales; el secreto se muestra una vez y nunca se persiste ni registra. Nunca usa `seller` ni ownership del body, no depende de KYA/KyaStore y falla cerrado si falta o se revocó la key. Un feed ajeno se trata como no encontrado. No hay login, portal, OAuth ni KYC de merchants.

El PATCH valida límites, ownership y replay; bloquea feed/receipt, compara hash, aplica merge y asigna revisiones. `data_revision` cambia siempre; `search_revision`, sólo con texto; la outbox publica esa revisión y `index_revision` la confirma. Devuelve `200 {id, accepted:true}`. Replay idéntico reutiliza receipt; colisión da `409`. Errores: `400/401/404/409/413/429/503`. Defaults: 1 MiB, 100 productos, 100 variants/producto y Timestamp de 5 minutos.

El worker reclama outbox con `FOR UPDATE SKIP LOCKED`, lease, backoff y dead-letter. Calcula embeddings localmente, descarta `search_revision` obsoleta y hace upsert condicional. PostgreSQL mantiene HNSW. SIGTERM deja de reclamar, termina el item acotadamente y libera el lease.

La búsqueda mantiene query→embedding→HNSW+lexical→IDs→una hidratación SQL. La hidratación filtra disponibilidad/precio actuales y rechaza huérfanos; precio/stock son inmediatos aunque el índice esté atrasado.

## Modelo y migración

`002_acp_catalog_current.sql` agrega merchants, API keys hasheadas, feeds, productos, variants, receipts, outbox y documentos actuales. Elimina `catalog_version_id`; relaciones y respuestas usan revisiones por item.

Rollout: migración aditiva con rutas apagadas; importar Juno como seed/test; backfill y comparar; iniciar worker; provisionar merchant/API key manualmente; cambiar búsqueda a current. Juno deja de ser fuente runtime. Rollback deshabilita rutas/worker y vuelve a tablas versionadas retenidas.

## Archivos y observabilidad

Crear `src/catalog/{acp-contract,ingestion,reindex-worker}.ts`, `src/server/acp-catalog-routes.ts`, migración 002, script de worker/import y tests ACP. Modificar `domain.ts`, `repository.ts`, `postgres-repository.ts`, `projection.ts`, `search.ts`, `server/{app,index}.ts`, `config/env.ts`, scripts/docs/comandos actuales. Métricas/logs estructurados: aceptación/replay/rechazo, latencia, outbox depth/age/retries/dead-letter, lag de revisiones, modo/fallback de búsqueda y shutdown; nunca bearer, body, query ni vector.

## Estrategia de pruebas

TDD estricto: headers/schema AR/es-AR/ARS, API key, merge, identidad, replay, tres revisiones, ausencia de `catalog_version` y stale guard; integración para concurrencia, atomicidad, outbox, HNSW e hidratación; E2E PATCH→worker→search. Ejecutar test, typecheck, lint y build.

## Threat Matrix

| Boundary | Aplicabilidad |
|---|---|
| Documentation-like paths | N/A: HTTP JSON no clasifica ni ejecuta archivos. |
| Git repository selection | N/A: no ejecuta Git ni elige repositorios. |
| Commit state | N/A: no opera index/worktree. |
| Push state | N/A: no resuelve refs ni destinos. |
| PR commands | N/A: no compone comandos de PR. |

## Decisiones cerradas

- Alta manual/API key; mercado AR/es-AR/ARS; tres revisiones por item; sin
  `catalog_version`; estados no-in-stock se filtran y sólo bajas explícitas crean tombstone.
