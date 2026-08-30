# Especificación: proyección incremental del catálogo Juno

## Requisitos

### Requirement: JCI-SOURCE-001 — Fuente runtime mantenida por merchants

El runtime MUST usar feeds ACP actuales y MUST NOT reconstruir snapshots globales.
La fixture Juno MAY usarse sólo como seed/test y MUST NOT representar una fuente
runtime ni integración real.

#### Scenario: Actualización aislada

- GIVEN feeds de dos merchants
- WHEN uno actualiza una variant
- THEN el sistema MUST conservar intacto el estado del otro merchant

### Requirement: JCI-PROJECTION-002 — Documento mínimo derivado

La proyección por Variant MUST contener `item_id`, nombre, descripción,
`item_info`, texto en español, embedding y revisión indexada. Precio, moneda,
disponibilidad, merchant, URL y media MUST quedar fuera del vector; URL/media MAY
guardarse relacionalmente. Sólo feeds `AR`, precios `ARS` y contenido español MUST
ser elegibles en el MVP.

#### Scenario: Construcción de documento

- GIVEN una variant AR/ARS con contenido español
- WHEN se genera su documento
- THEN esos campos searchables MUST componerse en orden estable
- AND precio, stock, merchant, URL y media MUST quedar excluidos

### Requirement: JCI-OUTBOX-003 — Entrega eventual durable

Todo cambio searchable aceptado MUST producir trabajo durable junto al estado
relacional. El procesamiento MUST reintentar, recuperarse y pasar a dead-letter
al agotar intentos, sin revertir datos duros.

#### Scenario: Indexación exitosa

- GIVEN un item con trabajo pendiente
- WHEN se genera y publica correctamente su embedding
- THEN `index_revision` MUST igualar la revisión searchable procesada

#### Scenario: Falla repetida del embedding

- GIVEN un trabajo que agota sus reintentos
- WHEN vuelve a fallar
- THEN MUST quedar en dead-letter y el precio/stock MUST conservarse

### Requirement: JCI-REVISION-004 — Protección contra eventos obsoletos

Cada item MUST tener `data_revision`, `search_revision` e `index_revision`
monotónicas. Data MUST cambiar ante cualquier cambio; search, sólo ante contenido
searchable; index MUST señalar la search revision vectorizada. Eventos anteriores
MUST NOT sobrescribir texto nuevo.

#### Scenario: Procesamiento fuera de orden

- GIVEN eventos de `search_revision` 4 y 5 para un item
- WHEN la revisión 4 termina después de la 5
- THEN la proyección MUST conservar la revisión 5

#### Scenario: Cambio sólo comercial

- GIVEN `search_revision = index_revision`
- WHEN cambia sólo precio o stock
- THEN MUST quedar `data_revision > search_revision = index_revision` sin nuevo embedding

#### Scenario: Item nuevo pendiente

- GIVEN un item nuevo con `data_revision = search_revision > index_revision`
- WHEN todavía no fue indexado
- THEN MUST permanecer fuera de candidatos de búsqueda

### Requirement: JCI-CONTINUITY-005 — Continuidad durante reindexación

Un item existente pendiente MUST conservar el último documento válido. La
búsqueda MUST hidratar datos duros actuales; el lag MUST NOT restaurar valores
anteriores.

#### Scenario: Texto pendiente con precio nuevo

- GIVEN un item indexado cuya descripción y precio cambiaron
- WHEN se busca antes de completar la nueva indexación
- THEN MAY recuperarse por el documento anterior
- AND MUST mostrar `data_revision = search_revision > index_revision` y precio actual

### Requirement: JCI-VISIBILITY-006 — Bajas y estados de disponibilidad

`discontinued` o `available=false` MUST crear tombstone y ocultar inmediatamente.
`backorder`, `preorder`, `out_of_stock` y `unknown` MUST NOT satisfacer
`in_stock`, pero MUST NOT crear tombstone por sí solos. Las bajas MUST NOT exigir
borrado físico.

#### Scenario: Baja explícita

- GIVEN un item recuperable
- WHEN se actualiza a `discontinued`
- THEN MUST dejar de aparecer al commit aunque su documento permanezca

#### Scenario: Stock desconocido

- GIVEN un item con estado `unknown`
- WHEN se busca con disponibilidad `in_stock`
- THEN MUST quedar filtrado sin ser eliminado

### Requirement: JCI-FAILURE-007 — Ciclo de vida seguro

Una interrupción MUST dejar trabajos recuperables. La indexación MUST NOT crear
documentos huérfanos ni cambiar KYA.

#### Scenario: Interrupción del worker

- GIVEN un trabajo reclamado y no confirmado
- WHEN el procesador se interrumpe
- THEN otro procesamiento posterior MUST poder recuperarlo sin duplicar el documento
