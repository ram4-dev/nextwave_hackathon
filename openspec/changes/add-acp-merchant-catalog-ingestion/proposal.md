# Propuesta: ingesta incremental de catálogo mediante ACP

## Intención

Los merchants, no Juno, mantienen productos, precio y stock. El
`PATCH` ACP actualiza el estado relacional y la búsqueda conserva pgvector/HNSW,
con indexación textual eventual.

## Alcance

### Incluido

- `PATCH /product_feeds/{id}/products` ACP parcial, idempotente y durable.
- Alta manual y API key hasheada; ownership separado de KYA y fail-closed.
- Outbox y worker de embeddings con retries.
- Mercado único AR/es-AR/ARS y búsqueda sin `catalog_version`, con tres revisiones.

### Fuera de alcance

KYC de merchants, login/portal, OAuth, checkout, promociones, pagos y sync con
Juno. URLs/media quedan fuera de proyección y respuesta MVP.

## Reglas, supuestos y restricciones

- Cada Variant vendible usa identidad `feed_id + product_id + variant_id`.
- Campos omitidos se conservan; productos/variants omitidos no se eliminan.
- `discontinued` o `available=false` produce tombstone y excluye búsqueda.
- Precio/stock hacen commit sin embedding. Cambios textuales encolan outbox;
  items existentes conservan el documento anterior; nuevos aparecen al indexarse.
- El equipo da de alta al merchant y entrega una API key Bearer una vez; sólo
  guarda su hash. La key resuelve merchant→feed y falla cerrado, sin KYA.
- La búsqueda usa datos duros SQL actuales aunque el documento esté `pending`;
  no toca KYA/KyaStore.
- `data_revision` cambia siempre; `search_revision` sólo con texto e
  `index_revision` al vectorizar. El contrato elimina la versión global.

## Capabilities

### Nueva

- `acp-merchant-feed-ingestion`: API key, feeds, PATCH parcial, idempotencia, ownership y aceptación.

### Modificadas

- `juno-catalog-ingestion`: abandona snapshot global/offline en runtime; la fixture queda como seed/test.
- `juno-catalog-search`: conserva retrieval/hidratación y reemplaza la versión global por revisiones por item.

## Enfoque

`PATCH → auth/ownership → transacción (merge + revisión + outbox) → accepted → worker (claim/embed/upsert) → HNSW/lexical → hidratación SQL`.

## Riesgos y rollback

| Riesgo | Mitigación |
|---|---|
| SQL y texto divergen | revisiones, estado pending/dead-letter y retries |
| replay o ownership incorrecto | hash, idempotencia y locks por feed |
| embedding atrasado pisa texto nuevo | upsert condicionado por revisión |

Rollback: pausar feeds y worker, conservar SQL, ocultar proyecciones inválidas y
restaurar la última revisión válida; retirar rutas/outbox antes de revertir migraciones.

## Criterios de éxito

- [x] PATCH válido actualiza SQL y responde aceptado sin esperar embedding.
- [x] Replay idéntico no duplica; misma clave con body distinto falla.
- [x] Búsqueda devuelve datos actuales, tres revisiones y ningún `catalog_version`.
- [x] Fallas del worker no pierden aceptaciones ni producen resultados huérfanos.

## Decisiones cerradas

Variant identifica el item; el documento anterior se conserva durante `pending`;
las bajas explícitas ocultan; URL/media quedan relacionales. El MVP acepta sólo
Argentina, español y ARS, sin versión global de catálogo.

Fuente: https://developers.openai.com/commerce/specs/api/overview
