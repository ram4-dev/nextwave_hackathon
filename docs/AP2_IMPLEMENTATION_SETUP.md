# Configuración para el flujo AP2 propuesto

## Flujo objetivo

1. El usuario conversa con su agente de IA.
2. El agente y el merchant intercambian el checkout mediante ACP. La aplicación recibe el estado estructurado de checkout, no usa el prompt como autorización. El prompt original se guarda, si hace falta, cifrado y fuera de blockchain; la aplicación conserva sólo su hash y una referencia.
3. La aplicación valida el checkout y crea el Checkout JWT del merchant.
4. La Trusted Surface presenta el mandato abierto al usuario y registra su firma explícita.
5. Si el agente KYA sigue autorizado y el checkout cumple los límites, el agente firma el mandato cerrado.
6. La aplicación verifica el resultado y encola **sólo hashes** para anclaje blockchain. Esto no ejecuta un pago.

## Configuración local actual

- Node.js 20 o superior.
- `KYA_MODE=demo` para trabajar sin KYC, pagos ni blockchain real.
- `KYA_DATA_DIR=.kya-data` para el store local KYA existente.
- Para emitir Checkout JWT en desarrollo: una JWK privada ES256 de merchant en `MERCHANT_SIGNING_PRIVATE_JWK`, o la clave efímera de desarrollo. Nunca usar una clave real en un fixture.
- Usar [`fixtures/mandate-store.example.json`](../fixtures/mandate-store.example.json) sólo como forma de los datos locales. No contiene secretos ni datos reales.

## Decisiones ya tomadas para el prototipo

- **Anclaje:** BSC Testnet, chain ID `97`. Su endpoint RPC y cualquier credencial del proveedor deben estar fuera del repositorio. BNB Chain publica la configuración de Testnet y endpoints de referencia en su [documentación oficial](https://docs.bnbchain.org/bnb-smart-chain/developers/wallet-configuration/).
- **Worker:** tendrá exclusivamente el rol on-chain de anclador. El administrador del contrato debe ser un multisig separado; el worker no debe ser admin ni tener capacidad de pago.
- **KYA y KMS:** KYA continúa siendo la fuente de identidad/attestation. Puede usarse el mismo *proveedor* KMS/HSM que KYA, pero con una clave distinta, propósito distinto y permisos distintos para la firma de mandatos del agente. La implementación KYA actual usa una JWK inyectada o archivo en modo live; todavía no es un adaptador KMS/HSM.
- **Agentes:** la futura tabla `agents` tendrá como mínimo `id`, `tenantId`, `agentKeyId`, `publicKeyJwk`, estado y referencia de attestation KYA; el fixture ya muestra esta forma.

## Antes de conectar blockchain

Debes decidir y configurar fuera del repositorio:

- Dirección del contrato de anclaje desplegado en BSC Testnet, RPC autenticado y número final de confirmaciones.
- Contrato de anclaje auditado, dirección desplegada, ABI, multisig administrador y cuenta/rol del worker anclador.
- KMS/HSM para la Agent Key: la clave privada no debe residir en variables de entorno, archivos, frontend ni logs.
- La Trusted Surface/Credential Provider concreta y su callback de firma, incluyendo cómo se publica/rota su clave de verificación. ACP es la capa de interacción de comercio agente↔merchant; no sustituye la firma explícita del usuario ni el binding de clave de KYA.
- Base de datos transaccional para mandatos, límites, auditoría y outbox; el JSON es sólo un prototipo local.
- Autenticación entre el agente de IA y la API interna (mTLS o workload identity) y rate limits.

## Qué se ancla

El contrato debe recibir solamente `closedCheckoutHash`, `closedPaymentHash`, `checkoutHash`, hashes opacos de `transactionId`/`agentId`/versión de política y timestamp. Nunca el prompt, JWT completo, mandato completo, usuario, tarjeta, token de procesador o instrumento de pago.

## Qué no hacer todavía

No conectar Yuno ni ejecutar pagos. Primero se debe tener firma explícita, verificación KYA, política determinista, persistencia durable y el anclaje auditado. Un estado `verified_pending_anchor` significa que la autorización fue verificada localmente pero aún no es evidencia on-chain.

## Persistencia de políticas

Ejecuta también `supabase/migrations/20260830_create_mandate_policy_ledger.sql` en el SQL Editor de Supabase. En producción, `createAutonomousClosedMandates` usa `SupabaseMandatePolicyLedger` por defecto y falla si faltan `SUPABASE_URL` o `SUPABASE_SECRET_KEY`. El RPC reserva presupuesto y frecuencia dentro de una transacción y evita carreras entre instancias.

## Trusted Surface EIP-712

La firma explícita del usuario usa la wallet ya vinculada por KYA, en Base Sepolia (`84532`) o Base (`8453`), nunca una clave privada en el backend. `Eip712TrustedSurfaceService.createApprovalChallenge()` comprueba que el mandato esté pendiente, que la wallet sea el `ownerAddress` del `Principal` KYA, que el enrollment esté `bound`, que KYC esté vigente y que el agente tenga una credencial KYA activa. Devuelve el `domain`, `types`, `primaryType` y `message` que el frontend debe enviar a la wallet mediante `eth_signTypedData_v4`.

`verifyAndRecordApproval()` verifica esa firma usando el RPC de Base y `publicClient.verifyTypedData`, compatible con wallets smart/ERC-1271. El challenge es de un solo uso, expira como máximo en cinco minutos y la firma queda ligada por hash al payload canónico completo del mandato, usuario, agente, nonce y ventana temporal. No se debe sustituir este método por una firma de texto ni confiar en una confirmación enviada por el agente.

En el frontend, presentar primero el resumen legible de límites, importe, moneda, comercio e instrumento enmascarado; sólo después solicitar la firma del typed data devuelto por el servicio. Base documenta el método [`eth_signTypedData_v4`](https://docs.base.org/base-account/reference/core/provider-rpc-methods/eth_signTypedData_v4) y su [guía de firma/verificación typed data](https://docs.base.org/base-account/guides/sign-and-verify-typed-data).

### Pendiente para producción

El servicio EIP-712 y sus pruebas están listos, pero el `InMemoryOpenMandateRegistry` y `InMemoryTrustedSurfaceApprovalStore` son almacenamiento local. Antes de exponer la UI al usuario, reemplazarlos por tablas/RPC transaccionales de Supabase (mandatos, challenges y firmas) y conectar las dos operaciones a los handlers protegidos por `requireSession`. Así se conserva anti-replay y el cambio a `active` incluso con reinicios o varias instancias.

## Firma de agente y evidencia BSC

`createConfiguredAgentMandateSigner()` es el signer de mandatos para un proceso configurado: carga una JWK ES256 desde `MANDATE_SIGNING_PRIVATE_JWK` o desde un archivo inyectado por Vault/KMS. Reutiliza el patrón de carga segura de KYA, pero exige una clave distinta de la usada para credenciales KYA. El proveedor KMS/HSM concreto sigue siendo responsabilidad del runtime: no se debe montar una clave privada normal en producción si el proveedor ofrece una operación de firma remota.

`createBscTestnetMandateAnchorWorker()` recibe únicamente mandatos cerrados ya verificados, vuelve a calcular los hashes SHA-256 desde los JWS/JWT originales, consulta `isAnchored`, y si hace falta llama a `MandateAnchor.anchor`. La lectura `isAnchored` de ambos hashes está disponible en `verifyMandateAnchorEvidence()`. El worker requiere `BSC_TESTNET_RPC_URL`, `MANDATE_ANCHOR_ADDRESS` y la clave de la cuenta que posee `ANCHORER_ROLE`; no reutilizar la cuenta administradora del contrato.

### Secretos en Supabase Edge Functions

El servidor Node lee variables con `process.env`; los secretos cargados en Supabase sólo están disponibles automáticamente dentro de una Edge Function, donde se leen con `Deno.env.get`. Por eso existe `supabase/functions/_shared/mandate-runtime-config.ts`, que lee y valida `MANDATE_SIGNING_PRIVATE_JWK`, `MANDATE_ANCHOR_ADDRESS`, `BSC_TESTNET_RPC_URL`, `MANDATE_ANCHORER_PRIVATE_KEY` y `MANDATE_WORKER_INTERNAL_KEY` sin registrarlos ni devolverlos al cliente. La función `mandate-anchor-worker` es por ahora un endpoint interno de readiness: no acepta mandatos arbitrarios para firmar o anclar hasta que exista el outbox durable.

Para generar una clave de demo ES256/P-256 del agente, ejecuta `npm run generate:mandate-signing-jwk`. Su salida estándar contiene sólo la JWK privada para cargar como `MANDATE_SIGNING_PRIVATE_JWK`; la salida de error muestra el `kid` y la JWK pública que debe registrarse en KYA. No copies ninguna JWK privada a Git, logs o chat. Este generador es para demo; en producción el KMS/HSM debe crear y conservar la clave privada.
