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
