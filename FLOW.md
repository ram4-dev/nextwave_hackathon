# FLOW — Autenticación KYA y descubrimiento de catálogo Juno

> **Nota de alcance:** este documento describe el **diseño objetivo** del producto. El build actual en este repositorio implementa la ceremonia de identidad **completamente mockeada** para demo (sin wallet real, sin SIWE, sin proveedor KYC externo, sin escritura on-chain — ver [`docs/IMPLEMENTATION.md`](./docs/IMPLEMENTATION.md) para lo que existe hoy). Todo lo marcado abajo como "diseño objetivo" o "planificado" **no** está implementado en este build.

## Decisión ejecutiva

**KYC es solo para personas** y, en condiciones normales, **se hace una sola vez**. La persona autoriza uno o más agentes compradores locales que corren en su PC. La plataforma KYA vincula un **Principal ID** seudónimo verificado a un **Agent ID ERC-8004** y a la **clave pública local** del agente.

En el diseño objetivo (live, no implementado en este build), la única conexión de
wallet sería **`BrowserWalletConnector`**: descubre providers inyectados, autentica
con SIWE y envía directamente `register(agentURI)` desde la misma dirección
verificada, sin abstracción de cuenta ni sponsorship de gas. En este build, el
sign-in y el register son pasos mockeados y etiquetados como tales.

La siguiente capacidad planificada usa esa identidad para que un agente comprador
consulte, en lenguaje natural, un catálogo agregado de comercios que aceptan
**Juno** como proveedor o método de pago. El primer alcance usa una **API mock de
Juno**, datos sintéticos y un índice vectorial generado offline. No conecta con
Juno real ni ejecuta compras o pagos.

| Implementado hoy (mock) | Diseño objetivo / planificado | Fuera de alcance |
| --- | --- | --- |
| Ceremonia de identidad end-to-end mockeada (persona ↔ agente local ↔ KYA) | Wallet real + SIWE; KYC hospedado real; `register` on-chain real | Integración con la API real de Juno |
| Enrollment, credencial KYA real (JWS ES256), autenticación challenge del agente | API mock de comercios y productos Juno | Checkout, captura, pago y liquidación |
| Clave local P-256 real (WebCrypto), nunca sale del dispositivo | Pipeline offline de normalización e indexación vectorial; búsqueda semántica | AP2 y otros protocolos de pago |
| Referencia display-only al Identity Registry curated (sin lectura/escritura on-chain) | Consumo real del Identity Registry curated | Deploy de registry propio; Hardhat/Foundry en runtime |

**Actores de la ceremonia (4):** Usuario · Agente local · Plataforma KYA · Proveedor KYC.  
ERC-8004 es **infraestructura interna** de Plataforma KYA, no un quinto actor de negocio.

---

## Flujo principal (happy path)

```mermaid
sequenceDiagram
  autonumber
  participant U as Usuario
  participant A as Agente local
  participant K as Plataforma KYA
  participant KYC as Proveedor KYC
  participant BW as Browser wallet<br/>(EIP-1193)
  participant IR as ERC-8004<br/>Identity Registry

  A->>A: Genera clave P-256<br/>(HW keystore o fallback cifrado)
  A->>K: Solicita enrollment (thumbprint público)
  K->>K: Crea código de enrollment de dispositivo
  U->>BW: Selecciona wallet y conecta cuenta
  BW->>BW: Cambia/agrega Base Sepolia (84532)
  U->>BW: Firma mensaje SIWE canónico
  BW->>K: SIWE message + signature
  alt Sin Principal verificado o KYC expirado
    U->>KYC: Completa KYC hospedado
    KYC->>K: Webhook firmado (estado verified)
  end
  K->>K: Crea o reutiliza Principal ID seudónimo
  K->>U: Muestra fingerprint de la clave del agente
  U->>K: Aprueba fingerprint
  U->>BW: Confirma transacción directa
  BW->>IR: register(agentURI)<br/>(msg.sender = browser wallet)
  IR-->>K: Evento Registered(agentId, ...)
  K->>K: watchContractEvent → Registered
  K->>K: Construye referencia completa<br/>agentRegistry + agentId
  K->>K: Emite JWS/JWT KYA de corta vida<br/>(cnf.jkt + Principal + ref ERC-8004)
  K->>A: Entrega material de identidad público
  A->>A: Almacena identidad pública<br/>(privada nunca sale del dispositivo)
```

---

## Flujo planificado: búsqueda de productos con Juno mock

```mermaid
sequenceDiagram
  autonumber
  participant JM as API mock de Juno
  participant P as Pipeline offline
  participant C as Catálogo normalizado
  participant V as Índice vectorial
  participant A as Agente comprador
  participant S as API de búsqueda

  P->>JM: Descarga snapshot paginado de merchants y productos
  JM-->>P: Comercios + aceptación Juno + catálogo + versión
  P->>P: Valida, normaliza, deduplica y detecta bajas
  P->>C: Publica snapshot estructurado versionado
  P->>V: Publica embeddings por oferta + metadata exacta
  A->>S: Credencial KYA + query "papas fritas" + filtros opcionales
  S->>V: Vectoriza query y recupera top-k candidatos
  V-->>S: IDs de ofertas + relevancia
  S->>C: Rehidrata precio, moneda, disponibilidad y merchant
  C-->>S: Datos exactos de la versión publicada
  S-->>A: Resultados rankeados + updated_at + catalog_version
```

### Contrato conceptual de la API mock de Juno

La API define el contrato sintético que consumirá el MVP en lugar de una
integración real con Juno. Las rutas exactas se definirán al implementar, pero
el mock debe ofrecer estas capacidades:

| Recurso | Datos mínimos |
| --- | --- |
| Merchant | `merchant_id`, nombre, categoría, ubicación y `payment_methods` con Juno explícito |
| Producto | `product_id`, `merchant_id`, nombre, descripción, categoría y etiquetas |
| Oferta | precio, moneda, disponibilidad y referencia al producto/merchant |
| Snapshot | `catalog_version`, `updated_at`, paginación y bajas desde la versión anterior |

El mock debe permitir listar merchants, obtener el detalle de un merchant y
paginar sus productos/ofertas. Todos los datos son sintéticos: no requiere
credenciales reales de Juno ni representa disponibilidad comercial real.

### Pipeline offline e índice vectorial

1. Descarga un snapshot completo o los cambios posteriores a una versión.
2. Valida el esquema, normaliza categorías/monedas y deduplica IDs canónicos.
3. Guarda el catálogo estructurado como fuente de verdad.
4. Construye un documento de búsqueda por oferta combinando nombre, descripción,
   categoría, etiquetas y contexto del merchant.
5. Genera embeddings y publica una nueva versión del índice de forma atómica.
6. Elimina o marca como no disponibles las ofertas ausentes o dadas de baja.

El pipeline corre fuera del request de búsqueda, es repetible e idempotente. El
índice vectorial es derivado y reconstruible; no sustituye al catálogo
estructurado ni se usa como fuente de precio o disponibilidad.

### Contrato de búsqueda para agentes

| Entrada | Salida |
| --- | --- |
| `query` libre, por ejemplo `papas fritas` | Merchant y producto/oferta canónicos |
| `top_k` opcional | Precio y moneda exactos |
| Filtros opcionales de merchant, categoría, moneda, precio o disponibilidad | Disponibilidad y aceptación de Juno |
| Credencial KYA del agente | Relevancia, `updated_at` y `catalog_version` |

La relevancia semántica sirve para recuperar candidatos; los filtros exactos se
aplican sobre metadata estructurada. La respuesta nunca inventa productos,
precios o stock que no existan en el último snapshot publicado.

Ejemplo esperado: `papas fritas` puede recuperar ofertas llamadas “Papas
clásicas”, “French fries” o productos equivalentes por significado, y devolver
cada resultado con el merchant que lo vende y su precio vigente en el snapshot.

---

## 1. Alcance y no-objetivos

### Alcance
- Autenticar agentes compradores **locales** en el PC del usuario.
- Vincular persona verificada (Principal ID) ↔ Agent ID ERC-8004 ↔ clave pública local.
- Enrollment, rotación, revocación y autenticación challenge-response del agente ante Plataforma KYA.
- Consumir el **Identity Registry curated** ya desplegado y su ABI oficial.
- Planificar una API mock con merchants que aceptan Juno y sus productos, precios y disponibilidad.
- Planificar un pipeline offline que normaliza el catálogo y publica un índice vectorial versionado.
- Permitir que un agente autenticado recupere ofertas relevantes mediante una query libre.

### No-objetivos
- Integración con Juno real o datos comerciales reales en esta fase.
- Onboarding u operación interna de merchants.
- Checkout, creación de órdenes, captura de pago o liquidación.
- AP2 u otros protocolos de pago.
- Crawling o embeddings en tiempo real dentro del request de búsqueda.
- Reputation Registry / Validation Registry de ERC-8004.
- Desplegar un registry ERC-8004 propio (Hardhat/Foundry **no** están en el path de runtime).
- Almacenar documentos KYC, biometría o PII en cadena o en `agentURI`.

---

## 2. Responsabilidades de los actores

| Actor | Responsabilidad | No hace |
| --- | --- | --- |
| **Usuario** | Seleccionar browser wallet, firmar SIWE, KYC (si falta o expiró), aprobar fingerprint/binding y confirmar la transacción | Operar la clave privada del agente |
| **Agente local** | Generar/usar clave P-256; firmar challenges; guardar identidad pública | Completar KYC; poseer el NFT Agent ID; exponer endpoint público |
| **Plataforma KYA** | Orquestar enrollment, adaptar KYC, hospedar `agentURI`, emitir/revocar JWS KYA, indexar eventos | Ver/autorizar al agente en lugar del usuario; llamar `register` desde su wallet; desplegar registry |
| **Proveedor KYC** | Verificar **solo a la persona**; webhook firmado con estado normalizado | Ver, registrar o autorizar al agente |

---

## 3. Enrutamiento de proveedores KYC

| Rol | Proveedor | Motivo |
| --- | --- | --- |
| Primario MVP | **Didit** | Velocidad de integración y cobertura MVP |
| Primario producción (Colombia) | **Incode** | Validación contra registros gubernamentales |
| Fallback / benchmark global | **Veriff** | Cobertura internacional y referencia de calidad |

**Adapter único** — estados normalizados: `pending` · `verified` · `needs_review` · `rejected` · `expired`.

| Regla | Detalle |
| --- | --- |
| Separación | El proveedor verifica a la persona; **nunca** ve ni autoriza al agente |
| Retener | Refs de sesión/proveedor + metadatos de assurance |
| Prohibido | Documentos crudos, selfies, biometría, plantillas |
| Frecuencia | KYC **normalmente una vez**; un Principal verificado autoriza **varios** agentes |
| Re-KYC | Solo si la persona **no** tiene verificación activa o está `expired` |

---

## 4. Enrollment (camino feliz) — checklist

1. Agente genera clave P-256: **no exportable** si el keystore hardware del SO lo soporta; si no, **fallback** en keystore cifrado del SO. La privada **nunca sale del dispositivo**.
2. Plataforma crea código de enrollment de dispositivo.
3. Usuario selecciona una browser wallet, cambia/agrega Base Sepolia y firma SIWE.
4. Si no hay Principal verificado activo o el KYC expiró: KYC hospedado → webhook → `verified`.
5. Plataforma crea o reutiliza **Principal ID** seudónimo.
6. Usuario ve y aprueba el fingerprint de la clave del agente.
7. La browser wallet autenticada simula y ejecuta `register(agentURI)`; el usuario paga gas de Base Sepolia.
8. Plataforma indexa `Registered` (`viem` `watchContractEvent`) y arma `agentRegistry` + `agentId`.
9. Plataforma emite credencial KYA JWS/JWT de corta vida (ver §6).
10. Agente guarda solo material público; la privada no se transmite nunca.

---

## 5. Herramientas para ERC-8004

### Decisión de producto

| Tema | Decisión MVP | Notas |
| --- | --- | --- |
| Modelo de contratos | **No** deploy custom | Consume Identity Registry curated + ABI oficial |
| Tooling de deploy | Hardhat / Foundry **fuera** del runtime | Solo consumo on-chain vía cliente EVM |
| Registries | Solo **Identity Registry** | Reputation y Validation: fuera de alcance |
| Red MVP | **Base Sepolia** · chain ID **84532** | Pruebas y enrollment |
| IdentityRegistry MVP | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | Curated oficial; **reverificar al integrar** |
| Red producción (plan) | **Base Mainnet** · chain ID **8453** | Promoción con gate de verificación |
| IdentityRegistry prod (plan) | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | Curated oficial; **reverificar al promover** |
| Estado del estándar | ERC-8004 **Draft** | Gate: dirección + versión de contrato |
| ABI oficial | [erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts) | Fuente de ABI |
| EIP | [EIP-8004](https://eips.ethereum.org/EIPS/eip-8004) | Especificación |
| Cliente EVM TS | **`viem`** | `simulateContract`, `writeContract`, `readContract`, decode, EIP-712, **`watchContractEvent`** (`Registered`, `Transfer`) |
| Wallet live | **`BrowserWalletConnector`** | EIP-6963 para discovery + EIP-1193 sobre el provider elegido |
| Login humano | **SIWE / ERC-4361** | La misma dirección autenticada queda ligada al Principal y al registro |
| Gas | ETH de Base Sepolia del usuario | La browser wallet (no el relayer) es `owner` del Agent ID |
| RPC | Provider Base de producción | RPC público solo para desarrollo local |
| `agentURI` | HTTPS versionado hospedado por KYA | IPFS = portabilidad posterior |
| Firmas / thumbprints | **`jose`** | ES256/JWS; thumbprint JWK **RFC 7638** (`cnf.jkt`) |
| Clave privada local | HW keystore si existe; si no, keystore cifrado del SO | Nunca transmitir ni exportar fuera del dispositivo |

> **Nota de verificación:** las direcciones se tomaron del repositorio oficial de contratos curated y **deben reverificarse** al integrar/promover. No inventar hashes de deploy ni secretos de API.

### Por qué la plataforma no llama `register`

`register` mintea la propiedad a `msg.sender`. Si el relayer llama desde su wallet, `ownerOf(agentId)` apuntaría a la plataforma.

La transacción directa debe enviarse desde la **browser wallet autenticada de la
persona**, para que `ownerOf(agentId)` resuelva a la misma dirección que firmó
SIWE y completó KYC.

| Quién ejecuta | `ownerOf` | ¿Válido? |
| --- | --- | --- |
| Browser wallet autenticada | Cuenta de la persona | Sí |
| Wallet/relayer de KYA | Wallet de KYA | No |

### Operaciones on-chain (Identity Registry)

| Operación | Uso en KYA |
| --- | --- |
| `register(agentURI)` | Alta del Agent ID; ownership = browser wallet autenticada |
| `ownerOf(agentId)` | Comprobar ownership actual |
| `tokenURI` / lectura de URI | Resolver metadatos / `agentURI` |
| `setAgentURI` | Actualizar URI versionada (sin PII) |
| `Transfer` (vía `watchContractEvent`) | Suspender binding hasta Principal verificado activo + aprobación explícita; KYC solo si falta o expiró |

### Propósito mínimo de `agentURI` (agente local)

El PC del agente **no** necesita endpoint público entrante: **la plataforma hospeda** el archivo de registro ERC-8004.

| Incluye | Nunca incluye |
| --- | --- |
| Metadatos de registro ERC-8004 requeridos | Principal ID |
| Referencia completa `agentRegistry` + `agentId` (cuando exista) | Proveedor KYC |
| Estado activo del registro | Datos documentales |
| DID o servicio resolutor KYA | Biometría / PII |

---

## 6. Credencial KYA (MVP) y campos canónicos

### Formato MVP — JWS/JWT de corta vida firmado por la plataforma

Bound a la clave pública del agente vía **`cnf.jkt`** (thumbprint JWK RFC 7638). **Sin PII.**

| Claim / campo | Contenido |
| --- | --- |
| `cnf.jkt` | Thumbprint de la clave pública del agente |
| Principal ID | Seudónimo verificado |
| `agentRegistry` + `agentId` | Referencia ERC-8004 completa |
| `iss` | Emisor = Plataforma KYA |
| `aud` | Audience del consumidor previsto |
| `iat` / `exp` | Emisión y expiración (corta vida) |
| Credential ID | Identificador de la credencial |
| Status reference | Puntero/estado (activa, suspendida, revocada, expirada) |

Perfil externo **W3C VC** o **SD-JWT VC** puede añadirse después **sin cambiar** el modelo de binding (Principal + ref ERC-8004 + `cnf.jkt`).

### Campos canónicos de identidad

| Campo | Descripción |
| --- | --- |
| `agent_uuid` | UUID interno de plataforma |
| `agentRegistry` | `eip155:84532:<identityRegistryAddress>` (MVP) o `eip155:8453:...` (prod) |
| `agentId` | ID on-chain (ERC-721 token id) |
| `owner` | Browser wallet dueña y autenticada por SIWE |
| `agentURI` | URI HTTPS del archivo de registro hospedado por KYA |
| `local_key_thumbprint` / `cnf.jkt` | Thumbprint JWK RFC 7638 |
| `principal_id` | Seudónimo de la persona verificada |
| `kya_credential_id` | ID de la credencial |
| `kya_credential_status` | activa / suspendida / revocada / expirada |
| `kya_credential_expiry` | Expiración del JWS/JWT |

**Unicidad:** `agentId` solo **no** es globalmente único. Canónico: **`agentRegistry` + `agentId`**.

---

## 7. Autenticación del agente ante la plataforma

Challenge firmado por la clave operativa local (ES256 vía `jose`):

| Campo | Rol |
| --- | --- |
| `nonce` | Anti-replay |
| `audience` | Destino = Plataforma KYA |
| `timestamp` | Ventana de validez |
| `intent_hash` | Hash del intent firmado |

1. Agente solicita challenge (`agent_uuid` o ref completa + thumbprint).
2. Plataforma emite nonce + audience + ventana temporal.
3. Agente firma con la clave P-256 local (nunca sale del dispositivo).
4. Plataforma verifica firma, `cnf.jkt`, estado de credencial y ownership on-chain.
5. Emite/renueva sesión o JWS operativo de corta vida.

| Tipo de clave | Quién | Vida útil |
| --- | --- | --- |
| Browser wallet / autorización SIWE | Humano | Sesión acotada; enrollment y actos sensibles |
| Clave operativa del agente | Agente local | Corta / rotable; challenges autónomos |

Credencial **copiada es inútil** sin la clave privada local.

---

## 8. Rotación, revocación, pérdida de dispositivo y transferencias

| Evento | Comportamiento |
| --- | --- |
| Rotación de clave (mismo PC) | Aprobar nuevo fingerprint; nuevo JWS; revocar el anterior |
| Cambio de PC | Nueva clave + revocar la vieja; **sin KYC** salvo política o expiración |
| Revocación voluntaria | Credencial → `revocada`; agente deja de autenticarse |
| Pérdida de dispositivo | Revocar credencial del thumbprint; enrollar nuevo dispositivo |
| `Transfer` del ERC-721 | **Suspender** binding KYA hasta que el nuevo owner esté ligado a un **Principal ID verificado activo** y **apruebe explícitamente** el binding; ejecutar KYC **solo** si esa persona no está verificada o la verificación expiró; luego emitir nueva credencial |
| Expiración KYC/credencial | No usable hasta renovación (re-KYC solo si el Principal no está `verified`) |

---

## 9. Datos almacenados vs prohibidos

| Almacenar | Prohibido |
| --- | --- |
| Principal ID seudónimo | PII en cadena o en JWS |
| Refs KYC + assurance | Documentos / biometría / selfies |
| `agentRegistry` + `agentId` + `owner` | Evidencia KYC en `agentURI` |
| `cnf.jkt` / thumbprint público | Clave privada del agente |
| JWS KYA (id/status/exp) | Secretos de API en este documento |
| `agentURI` hospedado (sin PII) | Principal ID / proveedor KYC en `agentURI` |

---

## 10. Fases de implementación

### Identidad KYA

| Fase | Entrega |
| --- | --- |
| **F0** | Adapter KYC (Didit) + estados normalizados + browser wallet / SIWE |
| **F1** | Enrollment dispositivo + fingerprint + Principal ID (KYC solo si falta/expiró) |
| **F2** | `BrowserWalletConnector` + `viem` + simulación/escritura directa de `register` contra registry curated (Sepolia) |
| **F3** | `watchContractEvent` (`Registered`/`Transfer`) + JWS KYA (`jose`, `cnf.jkt`) + auth challenge |
| **F4** | Rotación/revocación/device loss + Incode (CO) + Veriff fallback |
| **F5** | Gate dirección/versión → Base Mainnet (sigue sin deploy propio) |

### Extensión de catálogo Juno (planificada; sin código todavía)

| Fase | Entrega |
| --- | --- |
| **J0** | Contrato de datos + API mock paginada para merchants, productos, ofertas y versiones de catálogo |
| **J1** | Pipeline offline idempotente + catálogo normalizado + publicación atómica del índice vectorial |
| **J2** | API de búsqueda para agentes + filtros exactos + ranking semántico + demo con queries como `papas fritas` |

---

## 11. Checklist de aceptación

- [ ] KYC solo verifica personas; normalmente una vez; el proveedor no ve al agente.
- [ ] Un Principal verificado puede autorizar múltiples agentes.
- [ ] P-256: HW no exportable si el SO lo soporta; si no, keystore cifrado; privada nunca sale del dispositivo.
- [ ] Usuario aprueba fingerprint antes del binding.
- [ ] MVP consume Identity Registry curated + ABI oficial; sin deploy propio; Hardhat/Foundry fuera del runtime.
- [ ] `register` vía la misma browser wallet que firmó SIWE; simulación previa y gas pagado por el usuario.
- [ ] `ownerOf(agentId)` = browser wallet autenticada de la persona, no la plataforma.
- [ ] Referencia canónica = `agentRegistry` + `agentId`.
- [ ] Credencial MVP = JWS/JWT corta vida con `cnf.jkt`, Principal, ref completa, `iss`/`aud`/`iat`/`exp`, id y status ref; sin PII.
- [ ] `agentURI` hospedado por KYA; sin Principal ID, KYC, documentos ni biometría.
- [ ] Indexación con `viem` `watchContractEvent` para `Registered` y `Transfer`.
- [ ] Auth: nonce + audience + timestamp + intent hash firmado (`jose` ES256).
- [ ] Transfer: suspende hasta Principal verificado activo + aprobación explícita; KYC solo si falta o expiró.
- [ ] Cambio de PC: nueva clave + revocación; KYC solo si política/expiración.
- [ ] La extensión de catálogo no acopla el núcleo de identidad KYA a checkout o pagos.
- [ ] Direcciones curated reverificadas antes de integrar/promover.

### Extensión de catálogo Juno (planificada)

- [ ] El mock expone solo datos sintéticos y marca explícitamente qué merchants aceptan Juno.
- [ ] Cada oferta tiene IDs canónicos, merchant, producto, precio, moneda, disponibilidad y `updated_at`.
- [ ] El pipeline offline es paginado, idempotente, versionado y procesa altas, cambios y bajas.
- [ ] El catálogo estructurado es la fuente de verdad; embeddings e índice vectorial son derivados y reconstruibles.
- [ ] Una query como `papas fritas` devuelve productos semánticamente relevantes entre múltiples merchants.
- [ ] Precio, moneda y disponibilidad provienen del snapshot publicado, no de texto generado.
- [ ] Cada respuesta incluye relevancia y frescura (`updated_at` + `catalog_version`).
- [ ] Buscar no crea una orden ni autoriza o ejecuta un pago.

---

## 12. Decisiones de seguridad (resumen)

1. KYC normalmente una vez; un Principal autoriza muchos agentes.
2. Credencial copiada ≠ acceso: falta la clave local.
3. Separar autorización SIWE de la persona de las claves operativas del agente.
4. Transfer ERC-721 → suspender binding hasta Principal verificado activo + aprobación explícita; KYC solo si la persona no está verificada o expiró.
5. Nunca PII ni evidencia KYC on-chain, en `agentURI` ni en el JWS.
6. Cambio de PC → nueva clave + revocación; KYC solo si política o expiración.
7. El relayer no es `msg.sender` de `register`.
8. MVP no despliega registry; solo consume el curated.

---

## 13. Referencias autoritativas

| Recurso | URL / valor |
| --- | --- |
| EIP-8004 | https://eips.ethereum.org/EIPS/eip-8004 |
| Contratos / ABI oficiales | https://github.com/erc-8004/erc-8004-contracts |
| IdentityRegistry Base Sepolia (84532) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| IdentityRegistry Base Mainnet (8453) | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Cliente EVM | `viem` (`watchContractEvent`, simulate/write/read, EIP-712) |
| Browser wallet | `BrowserWalletConnector` (`viem` custom transport, EIP-1193/EIP-6963) |
| Login humano | SIWE / ERC-4361 |
| Firmas / JWS / thumbprints | `jose` (ES256, JWS/JWT, RFC 7638 `jkt`) |
| KYC MVP | Didit |
| KYC prod Colombia | Incode |
| KYC fallback global | Veriff |

---

*Documento autocontenido de arquitectura. KYA cubre identidad y autenticación; la extensión planificada de Juno cubre descubrimiento de catálogo con datos sintéticos. Checkout, ejecución de pagos, liquidación y AP2 permanecen fuera de alcance.*
