# Propuesta: búsqueda de catálogo Juno

## Intención

Crear una base reproducible para descubrir ofertas de merchants que aceptan Juno
mediante lenguaje natural. El MVP demuestra el flujo con 10 ofertas sintéticas,
sin Juno real ni mezclar el catálogo con la persistencia de KYA.

## Alcance

### Incluido

- Mock offline con 10 ofertas, varios merchants, Argentina y precios ARS.
- Catálogo PostgreSQL/pgvector versionado, publicación atómica y datos en español.
- Embeddings, HNSW primario y fallback exacto controlado.
- Búsqueda híbrida detrás de `POST /v1/catalog/search`, con filtros y pruebas.

### Fuera de alcance

- KYC, autenticación, sesiones, autorización y rate limiting.
- API real de Juno, checkout, órdenes o pagos.
- Endpoints de administración, UI y URL para continuar la compra en un merchant.
- Traducción o soporte multilingüe en este MVP.

## Capacidades

### Nuevas capacidades

- `juno-catalog-ingestion`: validar, normalizar, vectorizar y publicar snapshots sintéticos versionados con rollback.
- `juno-catalog-search`: consultar ofertas en español mediante ranking híbrido, HNSW primario y fallback exacto.

### Capacidades modificadas

- Ninguna; no existen specs de dominio principales y `KyaStore` permanece sin cambios.

## Enfoque

Definir puertos `CatalogLoader`, `CatalogRepository` y `EmbeddingProvider`, un
servicio independiente y un adaptador PostgreSQL/pgvector. Hono validará y
mapeará errores. El loader publicará una versión completa en una transacción; la
búsqueda leerá la activa y rehidratará precio, merchant y disponibilidad.

## Áreas afectadas

| Área | Impacto | Descripción |
|---|---|---|
| `src/catalog/` | Nueva | Dominio, puertos, loader y búsqueda. |
| `src/server/` | Modificada | Router e inyección, aislados de KYA. |
| `migrations/`, `fixtures/juno/` | Nuevas | Esquema, índices y fixture. |
| `tests/catalog/` | Nueva | Contratos, publicación, fallback y ranking. |
| `package.json` | Modificada | Cliente y migraciones PostgreSQL. |

## Riesgos

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| PostgreSQL/pgvector no reproducible | Media | Fijar versiones y documentar provisioning. |
| Filtros degradan recall HNSW | Media | Probe explícito, fallback y queries fijas. |
| Endpoint público genera abuso/costo | Media | Mantenerlo local/demo; auth después. |

## Rollback

Si falla una carga, conservar la última versión publicada y marcar la candidata
como fallida. Si el cambio causa problemas, retirar router y migraciones; activar
el snapshot previo.

## Dependencias

- PostgreSQL con `pgvector >= 0.8`, cliente y migraciones.
- Proveedor/modelo de embeddings y dimensión vectorial definidos antes de migrar.
- Entorno reproducible para probar HNSW.

## Criterios de éxito

- [ ] Las 10 ofertas se cargan idempotentemente y solo una versión queda publicada.
- [ ] El endpoint devuelve resultados ARS en español con datos exactos.
- [ ] La respuesta identifica `hnsw` o `exact_fallback` determinísticamente.
- [ ] Fallas de carga preservan el snapshot publicado y tienen pruebas.
