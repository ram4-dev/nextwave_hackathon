# Especificación: búsqueda sobre catálogo incremental

## Requisitos

### Requirement: JCS-API-001 — Contrato público

La ruta MUST seguir pública, con query libre y sin KYA. MUST conservar request,
filtros y validaciones. Cada resultado MUST exponer `data_revision`,
`search_revision` e `index_revision`; MUST NOT devolver `catalog_version`, URL ni
media. Sólo catálogo AR/ARS en español MUST ser elegible.

#### Scenario: Búsqueda

- GIVEN query libre 2–200 y catálogo AR/ARS en español
- WHEN se solicita hasta 10 resultados por defecto
- THEN MUST responder `200` con las tres revisiones y sin `catalog_version`

#### Scenario: Sin coincidencias

- GIVEN una búsqueda válida sin items elegibles
- WHEN se ejecuta
- THEN MUST responder `200` con `results: []`

#### Scenario: Request inválido

- GIVEN query, límites, rangos o campos desconocidos inválidos
- WHEN se envía el body
- THEN MUST responder `400 INVALID_SEARCH_REQUEST`

### Requirement: JCS-RETRIEVAL-002 — HNSW primario y ranking híbrido

El sistema MUST usar HNSW coseno como camino primario, complementar con ranking
lexical y fusionar determinísticamente. MUST sobre-recuperar antes de hidratar y
desempatar por `item_id`.

#### Scenario: Camino normal

- GIVEN HNSW listo y una query como `papas fritas`
- WHEN se busca
- THEN MUST usar HNSW, combinar candidatos lexicales y devolver `search_mode: hnsw`

### Requirement: JCS-FALLBACK-003 — Fallback exacto controlado

La búsqueda exacta MUST activarse sólo si readiness declara HNSW no disponible.
Errores de consulta, conexión o transacción MUST NOT activarla. El camino exacto
MUST conservar filtros, ranking lexical e hidratación, e informar
`search_mode: exact_fallback`.

#### Scenario: Índice no disponible

- GIVEN un probe explícito `unavailable`
- WHEN se ejecuta una búsqueda válida
- THEN MUST usar comparación exacta y marcar el modo de fallback

#### Scenario: Falla del fallback

- GIVEN el fallback ya seleccionado
- WHEN su consulta exacta falla
- THEN MUST responder `503 SEARCH_UNAVAILABLE` sin un segundo fallback

### Requirement: JCS-HYDRATION-004 — Datos duros actuales

El sistema MUST rehidratar candidatos por `item_id` en una lectura SQL. Filtros,
merchant, precio, moneda y disponibilidad MUST provenir del estado actual, nunca
del vector. Un huérfano MUST invalidar todo con `503 SEARCH_UNAVAILABLE`.

#### Scenario: Precio actualizado sin lag searchable

- GIVEN un candidato cuyo embedding anterior sigue vigente
- WHEN cambió sólo su precio en SQL
- THEN MUST devolverlo con `data_revision > search_revision = index_revision`

#### Scenario: Texto actualizado pendiente

- GIVEN un candidato cuyo texto nuevo espera indexación
- WHEN el documento anterior todavía lo recupera
- THEN MUST devolver datos actuales con `data_revision = search_revision > index_revision`

#### Scenario: Candidato huérfano

- GIVEN un ID sin fila relacional válida
- WHEN se hidrata el lote
- THEN MUST fallar sin entregar resultados parciales

### Requirement: JCS-FILTER-005 — Visibilidad y filtros autoritativos

El resultado MUST excluir tombstones, `discontinued`, `available=false`, mercados
fuera de AR/ARS e items fuera de filtros. `in_stock` MUST excluir `backorder`,
`preorder`, `out_of_stock` y `unknown`. `top_k` MUST aplicarse después.

#### Scenario: Documento anterior de item dado de baja

- GIVEN un item con documento searchable y tombstone actual
- WHEN coincide semánticamente
- THEN MUST quedar excluido del resultado

#### Scenario: Filtros combinados

- GIVEN filtros de merchant, moneda, precio y disponibilidad
- WHEN se buscan candidatos
- THEN cada resultado MUST satisfacer todos los filtros contra SQL actual

### Requirement: JCS-FAILURE-006 — Fallos sanitizados

Sin catálogo el sistema MUST responder `503 CATALOG_UNAVAILABLE`; sin embedding,
`503 EMBEDDING_UNAVAILABLE`; sin recuperación, `503 SEARCH_UNAVAILABLE`. Fallas
inesperadas MUST responder `500 INTERNAL_ERROR` sin exponer detalles internos.

#### Scenario: Embedding indisponible

- GIVEN un request válido
- WHEN no puede vectorizarse la query
- THEN MUST responder el error sanitizado correspondiente

### Requirement: JCS-SCOPE-007 — Aislamiento y ausencia de efectos comerciales

Buscar MUST NOT requerir API key, sesión, KYC ni KYA; MUST NOT leer o modificar
`KyaStore`; y MUST NOT crear promociones, checkout, órdenes, pagos ni
liquidaciones.

#### Scenario: Consumidor anónimo

- GIVEN un request sin `Authorization`
- WHEN consulta el catálogo
- THEN MUST poder buscar sin provocar efectos comerciales o de identidad
