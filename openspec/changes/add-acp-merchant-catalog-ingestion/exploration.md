# Exploración: ingesta de catálogo de merchants mediante ACP

## Estado actual

El cambio propuesto reemplaza únicamente la fuente y el mecanismo de ingesta del
catálogo. La búsqueda debe conservar PostgreSQL + pgvector, la proyección mínima
(`item_id`, nombre, descripción, `item_info` y embedding), HNSW como camino
primario, fallback vectorial exacto e hidratación SQL de los datos duros.

Hoy el sistema está diseñado como un catálogo Juno sintético de snapshots
completos:

- `src/catalog/loader.ts:7-45` valida una fixture completa, genera un embedding
  por oferta y llama a `CatalogRepository.publish`.
- `src/catalog/postgres-repository.ts:67-203` escribe merchants, productos y
  documentos de búsqueda bajo un `catalog_version_id` nuevo, y cambia la versión
  publicada de forma atómica. El modelo actual presupone que una carga contiene
  todo el catálogo.
- `migrations/001_juno_catalog.sql:13-73` ata las tablas relacionales y los
  documentos vectoriales a una versión inmutable. `catalog_one_published_version`
  garantiza como máximo una versión publicada.
- `src/catalog/postgres-repository.ts:254-433` obtiene candidatos en una
  transacción `REPEATABLE READ`, combina HNSW/lexical, y rehidrata todos los IDs
  en una sola consulta SQL contra la misma versión.
- `src/server/catalog-routes.ts:8-19` expone sólo `POST /v1/catalog/search`, y
  `src/server/app.ts:75` lo monta sin KYA. El repositorio de identidad no participa.

Por lo tanto, un `PATCH` ACP no debería llamar a `publish` ni reconstruir la
versión global. Necesita un estado actual por feed/merchant, merge parcial,
revisión por cambio y una cola transaccional para actualizar la proyección.

ACP define `POST /product_feeds` y `GET /product_feeds/{id}` para feeds, además de
`GET /product_feeds/{id}/products` y
`PATCH /product_feeds/{id}/products` para productos. El PATCH hace upsert por
`Product.id`; los productos omitidos permanecen sin cambios. Un producto tiene
variants y cada variant tiene un `id` estable, precio en unidades menores,
moneda, disponibilidad, categorías y metadatos opcionales. Ver:
[`overview`](https://developers.openai.com/commerce/specs/api/overview),
[`feeds`](https://developers.openai.com/commerce/specs/api/feeds) y
[`products`](https://developers.openai.com/commerce/specs/api/products).

## Áreas afectadas

- `src/catalog/domain.ts` — separar snapshot histórico de estado mutable, definir
  feed/merchant, revisión, estado de indexación y el resultado de aceptación ACP.
- `src/catalog/schema.ts` — validar el subconjunto ACP soportado, incluyendo
  `Product.id`, variants, precio/moneda, disponibilidad y límites de tamaño; no
  asumir que un PATCH representa el catálogo completo.
- `src/catalog/postgres-repository.ts` y `src/catalog/repository.ts` — agregar
  operaciones transaccionales de merge, idempotencia, outbox y lectura del estado
  actual; conservar la ruta de búsqueda y su hidratación setwise.
- `src/catalog/projection.ts` y `src/catalog/embedding.ts` — construir el texto
  searchable desde el producto/variant normalizado y procesar fuera del request
  HTTP mediante un worker.
- `migrations/` — introducir feed ownership, estado actual, revisiones,
  idempotency keys y `catalog_reindex_outbox`; revisar la relación entre
  `catalog_search_documents` y el estado actual.
- `src/server/catalog-routes.ts` y `src/server/app.ts` — agregar el boundary ACP
  separado de `/v1/catalog/search`; la autorización debe ser un puerto explícito
  y fail-closed mientras no exista registro/auth de merchants.
- `src/config/env.ts`, `src/server/index.ts` y scripts/worker — configurar el
  procesamiento de outbox, límites y apagado ordenado sin acoplarlo a KYA.
- `tests/catalog/` — probar merge parcial, replay, ownership, revisión,
  publicación de embedding, baja/discontinuación, errores y consistencia de
  búsqueda durante la indexación.
- `FLOW.md`, `README.md` y `docs/JUNO_CATALOG_SEARCH_SPEC.md` — actualizar la
  fuente de verdad sólo después de aprobar la nueva spec; este change no los
  modifica durante la exploración.

## Comparación de enfoques

### A. Reconstruir un snapshot global ante cada PATCH

Cada request ACP leería todo el estado, fusionaría el PATCH, regeneraría todos los
embeddings y publicaría otra versión inmutable usando el mecanismo actual.

- **Ventajas:** conserva casi intacto el ciclo de publicación actual; cada lectura
  ve una versión completa y coherente; rollback y auditoría son sencillos.
- **Desventajas:** un cambio de stock de un solo variant reescribe y re-embebe
  todo el catálogo; la latencia y el costo crecen con merchants y productos; un
  merchant lento o inválido bloquea cambios ajenos; aparecen carreras entre
  snapshots globales; no respeta bien la semántica de actualización frecuente de
  stock.
- **Complejidad:** media al inicio, alta en operación por amplificación de carga.

### B. Estado actual incremental + outbox transaccional + worker de embeddings

El PATCH valida y, en una transacción, resuelve el feed propietario, aplica el
merge parcial al estado relacional actual, incrementa la revisión y registra una
operación de reindexación en una outbox. Un worker reclama eventos, calcula el
embedding localmente y actualiza la proyección. Precio, moneda, disponibilidad y
otros datos duros quedan disponibles después del commit; un item nuevo aparece en
búsqueda cuando su documento termina de indexarse.

- **Ventajas:** trabajo proporcional al cambio; stock y precio no esperan al
  modelo; reintentos durables y atomicidad entre estado y evento; aislamiento entre
  merchants; permite batching/concurrencia controlada; mantiene intacta la lógica
  de HNSW, ranking, filtros e hidratación.
- **Desventajas:** introduce consistencia eventual entre SQL y búsqueda; exige
  estados de outbox, retries, dead-letter y observabilidad; requiere decidir qué
  ocurre con un documento anterior mientras llega el nuevo embedding.
- **Complejidad:** media-alta, pero con límites claros y adecuada para evolución.

### C. Embedding síncrono dentro del PATCH

El request aplica el merge y calcula el embedding antes de responder, actualizando
SQL y la proyección en la misma operación lógica.

- **Ventajas:** el item queda searchable inmediatamente; no requiere un worker ni
  una cola persistente para el caso feliz.
- **Desventajas:** acopla disponibilidad y latencia de la ingesta al modelo; un
  timeout o cache local corrupto hace fallar un update de stock; dificulta retries,
  batching y límites de concurrencia; deja una ventana compleja entre commit SQL y
  actualización vectorial si ambas no comparten una transacción; no conviene para
  merchants que mantendrán stock con frecuencia.
- **Complejidad:** baja en componentes, alta en fallos y operación.

## Recomendación

Recomiendo **B**. El boundary ACP debe ser una API de proveedor de catálogo: un
merchant envía `PATCH /product_feeds/{feed_id}/products`, el sistema autentica el
request mediante el mecanismo de merchant que se defina, valida headers y body,
deriva el merchant desde `feed_id` + credencial, y nunca acepta ownership desde
`seller` ni desde un campo enviado por el merchant.

El flujo recomendado es:

```text
merchant
  -> ACP PATCH + Idempotency-Key
  -> autenticación/ownership del feed (fail-closed)
  -> transacción: idempotencia + merge actual + revision + outbox
  -> 200 accepted
  -> worker: claim outbox -> embed local -> upsert projection -> mark done
  -> búsqueda: HNSW/lexical -> IDs -> una hidratación SQL actual
```

La unidad indexable debe ser un **variant vendible**. El identificador interno
debe ser estable y no colisionar entre feeds; puede derivarse como una clave
canónica `(feed_id, product_id, variant_id)` aunque el body ACP conserve sus IDs
originales. El texto indexado combina título/descripción/categorías/opciones del
producto y variant; precio, moneda, disponibilidad, merchant y ownership no se
copian a la proyección searchable.

El merge debe seguir estas reglas:

1. `Product.id` identifica el producto y una variant se identifica por su `id`.
2. Campos presentes reemplazan el estado actual; campos ausentes se conservan.
3. Productos y variants omitidos del PATCH no se eliminan.
4. Una baja debe ser explícita (`availability.status = discontinued` o una
   operación de delete que el contrato local defina); se conserva un tombstone y
   se oculta de la búsqueda, sin borrar inmediatamente el historial necesario
   para replay/auditoría.
5. El estado duro se actualiza en el commit del PATCH. Si cambia el texto
   searchable, se encola una nueva revisión. Un item nuevo no es candidato hasta
   que exista su documento vectorial; para un item existente se debe decidir si se
   conserva temporalmente el último documento completo o si se lo oculta durante
   `pending`.
6. La revisión debe ser monotónica por feed y asignada por la base bajo lock; no
   se debe confiar en el reloj del merchant para ordenar concurrencia. Cada evento
   de outbox lleva feed, item, revisión, operación (`upsert`/`delete`), intentos y
   estado.

La lectura de búsqueda puede abandonar `catalog_version_id` como única noción de
actualidad y pasar a un `catalog_revision`/watermark de estado actual. Debe seguir
usando una transacción repeatable-read y una única hidratación, pero verificando
que el documento candidato no sea huérfano, no pertenezca a otro feed y no esté
marcado eliminado. La respuesta debería hacer explícita la eventualidad, por
ejemplo con `data_revision` e `index_revision` o una frescura equivalente, sin
devolver embeddings.

## Límites de ownership y KYA

No existe hoy una tabla de merchant registration, credencial de merchant ni
middleware de autenticación para catálogo. KYA sólo modela personas/agentes
compradores y su ruta de búsqueda es pública (`src/server/app.ts:75`). No hay que
reutilizar `requireSession`, Principal ID, KYC ni `KyaStore` para autorizar
merchants por defecto.

La nueva ruta debe depender de una interfaz separada, por ejemplo un resolver
`resolveFeedOwner(feedId, credentialContext)`, que falle cerrado si no hay
registro, credencial válida o asociación feed→merchant. En el MVP de esta spec se
puede usar un adapter/mock de credenciales, pero no una ruta de ingesta anónima que
escriba cualquier merchant. El diseño debe dejar la implementación de auth de
merchant como una decisión explícita posterior, sin mezclarla con KYA.

## Riesgos y preguntas abiertas

- La documentación ACP confirma PATCH parcial a nivel de productos, pero el
  contrato exacto para merge de campos internos de una `Variant`, reemplazo de la
  lista `variants` y eliminación explícita debe quedar fijado en la spec local.
- ACP admite estados como `backorder`, `preorder` y `discontinued`; el enum
  actual sólo tiene `in_stock`, `out_of_stock` y `unknown`. Hay que definir
  normalización para búsqueda, compra futura y tombstones.
- Un payload puede contener `url` y media. La proyección searchable no debe
  inventar URLs, pero el modelo relacional debe decidir si las conserva para una
  futura superficie de checkout o las descarta en este MVP.
- Una misma `Product.id` podría aparecer en más de un feed. Ownership e identidad
  deben usar feed + product + variant, no sólo `Product.id` global, salvo que el
  boundary de registro garantice unicidad global.
- `Idempotency-Key` requiere guardar hash del request y resultado; reutilizar la
  misma clave con un body distinto debe rechazarse, no reaplicar el PATCH.
- El worker puede terminar después de un PATCH posterior. El upsert vectorial
  debe comparar revisiones y descartar eventos atrasados; si no, una búsqueda puede
  volver a texto viejo.
- Un error permanente de embedding no debe revertir precio/stock ya aceptados.
  Debe dejar el evento en retry/dead-letter y exponer un estado de indexación
  observable.
- La ingesta ACP puede recibir reintentos, requests concurrentes y timestamps
  fuera de orden. Hay que definir ventana de replay, límites de payload, rate
  limiting y si el `Timestamp` del header sólo se valida o también ordena eventos.
- La migración desde el fixture mock necesita una estrategia explícita: mantener
  el fixture sólo como seed de desarrollo, importarlo una vez como feed mock, o
  eliminarlo del camino de runtime.
- El endpoint de búsqueda actual filtra `in_stock` por defecto. Debe continuar
  usando disponibilidad SQL actual aunque el documento vectorial esté pendiente.

## Listo para propuesta

**Sí, con una decisión pendiente de contrato:** aprobar B como arquitectura y
definir antes de la spec el boundary mínimo de autenticación/registro de feeds,
la semántica exacta de merge/delete de variants y la política de visibilidad
durante `index_pending`. El cambio puede conservar la búsqueda HNSW, el fallback
exacto, el ranking y la hidratación SQL; debe reemplazar la publicación global
offline por estado actual incremental y outbox.

## Key Learnings

1. El esquema actual versiona todo el catálogo y no soporta directamente PATCH incrementales por merchant.
2. ACP mantiene productos omitidos en un PATCH, por lo que ausencia no debe interpretarse como eliminación.
3. La opción incremental necesita outbox transaccional para no perder reindexaciones después del commit.
4. Un variant ACP es la unidad vendible más segura para enlazar precio, stock, merchant y búsqueda.
5. La autorización de merchants debe ser un boundary separado de KYA y fallar cerrado si falta registro.
