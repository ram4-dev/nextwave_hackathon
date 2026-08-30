# Configuración para el flujo AP2 propuesto

## Flujo objetivo

1. El usuario conversa con su agente de IA.
2. El agente y el merchant intercambian el checkout mediante ACP. La aplicación recibe el estado estructurado de checkout, no usa el prompt como autorización. El prompt original puede existir de forma transitoria sólo para calcular su hash; la aplicación conserva sólo `prompt_hash` y una referencia opaca cifrada externa. Nunca se persiste el prompt en claro en store/RPC/DB.
3. La aplicación valida el checkout y crea el Checkout JWT del merchant.
4. La Trusted Surface presenta el mandato abierto al usuario y registra su firma explícita ligada al hash canónico del payload.
5. Si el agente KYA sigue autorizado y el checkout cumple los límites, el agente firma el mandato cerrado.
6. La aplicación verifica el resultado y encola **sólo hashes** para anclaje. Esto no ejecuta un pago ni escribe en cadena por defecto.

## Implementado en este repositorio

- Biblioteca de dominio AP2 en `src/mandates` con validación Zod estricta.
- Trusted Surface EIP-712 (Base Sepolia/Base) con activación atómica ligada al hash canónico.
- Ledger de política in-memory + migración Supabase con presupuesto/ops/frecuencia **por mandato**.
- Contrato `MandateAnchor` (Hardhat) con roles distintos admin/pauser/anchorer; pruebas locales.
- Outbox hash-only + worker inyectable con `FakeMandateAnchorClient` (sin RPC real).

## Pendiente / fuera de alcance operativo

- Escrituras on-chain reales del worker (requiere RPC, clave de anclador y contrato desplegado fuera del repo).
- Ejecución de pagos / Yuno / tokenización.
- Registry durable multi-instancia de mandatos abiertos y challenges (hoy hay stores in-memory + RPC de política/requests).
- KMS/HSM de producción para `AgentMandateSigner` / `MerchantSigner`.

## Configuración local actual

- Node.js 20 o superior.
- `KYA_MODE=demo` para trabajar sin KYC, pagos ni blockchain real.
- `KYA_DATA_DIR=.kya-data` para el store local KYA existente.
- Para emitir Checkout JWT en desarrollo: una JWK privada ES256 de merchant en `MERCHANT_SIGNING_PRIVATE_JWK`, o la clave efímera de desarrollo. Nunca usar una clave real en un fixture.
- Usar [`fixtures/mandate-store.example.json`](../fixtures/mandate-store.example.json) sólo como forma de los datos locales. No contiene secretos ni datos reales.

## Anclaje (diseño; live no ejecutado)

- Red de diseño documentada: BSC Testnet, chain ID `97`. Credenciales fuera del repositorio.
- El worker tiene exclusivamente el rol on-chain de anclador. Admin ≠ pauser ≠ anchorer.
- El runtime KYA no escribe en cadena; Hardhat sirve para compilar/probar el contrato de evidencia.

## Persistencia de políticas y requests

Ejecuta `supabase/migrations/20260830_create_mandate_policy_ledger.sql` y `supabase/migrations/20260830_create_mandate_requests.sql`. El RPC de reserva aplica límites por mandato de checkout y de pago con orden de locks determinista. La tabla de requests **no** tiene columna `prompt`; sólo `prompt_hash` y `encrypted_prompt_ref` opcional.

## Trusted Surface EIP-712

La firma explícita del usuario usa la wallet ya vinculada por KYA, en Base Sepolia (`84532`) o Base (`8453`). `verifyAndRecordApproval()` revalida el hash canónico del payload antes de activar y persiste la prueba de activación ligada a ese hash.
