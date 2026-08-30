# Especificación: ingesta ACP de feeds de merchants

## Requisitos

### Requirement: ACP-AUTH-001 — API key

Cada merchant MUST provisionarse manualmente y recibir una API key mostrada una
vez. MUST guardarse prefijo, hash, estado y `merchant_id`; MUST NOT guardar
ni registrar la key cruda. Login, OAuth, KYC y KYA MUST NOT participar.

#### Scenario: Key activa

- GIVEN un merchant provisionado con una key activa
- WHEN envía `Authorization: Bearer <api_key>`
- THEN MUST autenticar el `merchant_id` asociado

#### Scenario: Key inválida o revocada

- GIVEN una key ausente, desconocida o revocada
- WHEN se solicita una superficie ACP protegida
- THEN MUST responder `401` sin revelar secretos

### Requirement: ACP-FEED-002 — Ownership de feeds

El sistema MUST soportar `POST /product_feeds`, `GET /product_feeds/{feed_id}` y
PATCH/GET `/product_feeds/{feed_id}/products`. POST MUST responder `200` con
metadata; GET products MUST devolver el array completo sin paginación. MUST
derivar el merchant de la key y MUST NOT confiar en `seller`.

#### Scenario: Creación

- GIVEN una key activa
- WHEN crea un feed y consulta sus productos
- THEN POST MUST devolver metadata y GET el array actual completo

#### Scenario: Ajeno

- GIVEN una key válida de otro merchant
- WHEN consulta o modifica el feed
- THEN el sistema MUST responder `404` sin confirmar su existencia

### Requirement: ACP-CONTRACT-003 — Contrato ACP

Las mutaciones MUST exigir bearer, JSON, versión, idempotencia, request ID y
`Timestamp` RFC3339 dentro de cinco minutos. El feed MUST usar `target_country=AR`;
`price`, `list_price` y `unit_price` MUST usar ARS. Otro país, moneda o contrato
MUST responder `400`; más de 1 MiB, `413`; límites, `429`; y almacenamiento
indisponible, `503`. Un PATCH
MUST limitarse a 100 productos y 100 variants/producto. `Accept-Language` MUST
localizar sólo mensajes; el MVP MUST usar `es-AR`.

#### Scenario: Timestamp

- GIVEN `Accept-Language: es-AR` y un `Timestamp` vencido
- WHEN se envía una mutación
- THEN MUST rechazarla sin efectos y localizar el error como `es-AR`

#### Scenario: Mercado

- GIVEN `target_country` distinto de `AR` o algún precio no `ARS`
- WHEN se crea o actualiza el feed
- THEN MUST responder `400` sin modificar datos

### Requirement: ACP-MERGE-004 — Merge parcial

El sistema MUST identificar cada item por `(feed_id, product_id, variant_id)`.
Campos presentes MUST reemplazar; campos, productos y variants omitidos MUST
conservarse. Arrays presentes, salvo `variants`, MUST reemplazarse; variants MUST
fusionarse por `id`.

#### Scenario: Cambio parcial

- GIVEN un feed con varios productos y variants
- WHEN un PATCH cambia precio de una sola variant
- THEN MUST cambiar sólo esa variant y conservar todo lo omitido

### Requirement: ACP-COMMIT-005 — Commit eventual

Un PATCH MUST confirmar datos y revisiones monotónicas. Data MUST cambiar siempre;
search, sólo ante texto searchable; index MUST indicar la search vectorizada. MUST
responder `200 {id, accepted:true}` sin esperar embeddings. Cambios searchables
MUST dejar trabajo durable; cambios comerciales SHOULD NOT duplicarlo.
MUST NOT crear pagos ni modificar KYA.

#### Scenario: Cambio comercial

- GIVEN una variant ya indexada
- WHEN cambia sólo precio o stock
- THEN MUST quedar `data_revision > search_revision = index_revision`

#### Scenario: Texto pendiente

- GIVEN una variant indexada
- WHEN cambia texto searchable
- THEN MUST quedar `data_revision = search_revision > index_revision` hasta indexarse

#### Scenario: Falla atómica

- GIVEN una falla antes del commit
- WHEN se procesa el PATCH
- THEN MUST persistirse todo o nada, sin aceptación ni trabajo huérfano

### Requirement: ACP-IDEMP-006 — Idempotencia

La idempotencia MUST vincular merchant, `Idempotency-Key`, método, path y hash
del body. Un replay idéntico MUST devolver la respuesta original;
la misma `Idempotency-Key` con otro contenido MUST responder `409`. Requests
concurrentes MUST observar igual regla.

#### Scenario: Replay

- GIVEN un PATCH previamente aceptado
- WHEN se repite con la misma `Idempotency-Key` y contenido
- THEN MUST devolverse el receipt previo sin nueva revisión

#### Scenario: Colisión

- GIVEN una idempotency key ya consumida
- WHEN se reutiliza con otro body
- THEN MUST responder `409` sin modificar el catálogo
