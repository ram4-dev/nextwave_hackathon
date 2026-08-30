# MCP de catálogo de partners

El módulo `src/mcp/catalog.ts` define la superficie MCP de sólo lectura que utilizará el agente antes de pedir autorización humana. No implementa transporte MCP, autenticación, base vectorial, base de datos, consultas a merchants ni llamadas a Yuno.

## Herramientas

| Herramienta | Entrada | Resultado | Uso permitido |
| --- | --- | --- | --- |
| `catalog_semantic_search` | `query`, filtros opcionales, `merchantId`, idioma y límite | `itemId`, merchant, score y campos coincidentes | Encontrar candidatos en el índice vectorial local. No devuelve detalle suficiente para compra. |
| `catalog_get_product` | `itemId` de una búsqueda anterior e idioma opcional | nombre, descripción, imágenes, atributos, precio, disponibilidad, variantes y políticas | Presentar información completa y actual al humano. |

La implementación futura debe seguir exactamente esta secuencia: búsqueda semántica local → `itemId` → lectura exacta en la base propia. Ni el agente ni esta capa consultan al merchant para presentar resultados.

Después de que el humano apruebe mediante la Trusted Surface, otro módulo —fuera de este MCP— confirmará el ítem/precio/disponibilidad con el merchant y sólo entonces iniciará el pago con Yuno. No exponer identificadores de pago, tokens de procesador, datos de tarjeta, secretos de merchant, prompts ni mandatos en las respuestas de estas herramientas.

## Integración futura

Implementar `CatalogReadModel` con los dos métodos `semanticSearch` y `getProduct`, inyectarlo en `createCatalogMcpToolHandlers()`, y registrar `catalogMcpToolDefinitions` en el host MCP elegido. El host debe aplicar la identidad del agente, tenant y permisos antes de ejecutar el adaptador; `merchantId` suministrado por el modelo no es autorización por sí mismo.
