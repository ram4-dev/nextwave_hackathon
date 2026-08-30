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
- Trusted Surface EIP-712 (Base Sepolia/Base) con activación ligada al hash canónico.
- **Atomicidad local in-memory:** `activateWithVerifiedSignature` ejecuta `persistProof` (p. ej. `approvalStore.consume`) dentro de la sección crítica antes de marcar `active`. Si la persistencia falla, el mandato permanece `awaiting_user_signature` y el challenge queda reintentable.
- **Pendiente durable:** registry + challenge/proof deben compartir una única transacción de base de datos en producción. No afirmar atomicidad durable inexistente.
- Ledger de política in-memory compartido por `InMemoryOpenMandateRegistry.policyLedger` + migración Supabase con presupuesto/ops/frecuencia **por mandato**.
- Contrato `MandateAnchor` (Hardhat) con roles distintos admin/pauser/anchorer; pruebas locales; todos los hashes de evidencia deben ser no-cero.
- Outbox hash-only + worker inyectable con `FakeMandateAnchorClient`, estado `processing` + lease, `maxAttempts` y `txHash` persistido (sin RPC real).

## Pendiente / fuera de alcance operativo

- Escrituras on-chain reales del worker (requiere RPC, clave de anclador y contrato desplegado fuera del repo).
- Ejecución de pagos / Yuno / tokenización.
- Registry durable multi-instancia de mandatos abiertos y challenges.
- KMS/HSM de producción para `AgentMandateSigner` / `MerchantSigner`.

## Configuración local actual

- Node.js 20 o superior.
- `KYA_MODE=demo` para trabajar sin KYC, pagos ni blockchain real.
- Drafts CLI (fail-closed): `NODE_ENV=test npm run mandates:create -- --input ./fixtures/validated-checkout.json`
- `MERCHANT_SIGNING_PRIVATE_JWK` opcional en development/test. Nunca usar una clave real en un fixture.

## Migraciones Supabase

Ejecutá en orden:

1. `supabase/migrations/20260830_create_mandate_policy_ledger.sql`
2. `supabase/migrations/20260830_create_mandate_requests.sql`
3. `supabase/migrations/20260830120000_upgrade_mandate_schema_v2.sql` (upgrade idempotente posterior a las create: elimina `prompt`, drop del RPC request viejo y del `reserve_mandate_policy` de 9 args, asegura funciones/índices/grants/RLS nuevos)

## Trusted Surface EIP-712

La firma explícita del usuario usa la wallet ya vinculada por KYA, en Base Sepolia (`84532`) o Base (`8453`). `verifyAndRecordApproval()` revalida el hash canónico del payload y persiste la prueba de activación dentro de la sección crítica local antes de activar.
