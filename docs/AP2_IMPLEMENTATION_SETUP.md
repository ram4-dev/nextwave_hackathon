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
- **Atomicidad local in-memory:** `activateWithVerifiedSignature`, `revoke` y `persistProof` (p. ej. `approvalStore.consume`) comparten la sección crítica antes de confirmar el estado. Si la persistencia falla, el mandato permanece `awaiting_user_signature` y el challenge queda reintentable; una revocación resuelta nunca puede ser sobrescrita por una activación en vuelo.
- **Pendiente durable:** registry + challenge/proof deben compartir una única transacción de base de datos en producción. No afirmar atomicidad durable inexistente.
- Ledger de política in-memory compartido por `InMemoryOpenMandateRegistry.policyLedger` + migración Postgres self-hosted con presupuesto/ops/frecuencia **por mandato**. La reserva devuelve `remainingBudgetMinor` desde la misma sección crítica/transacción que inserta, sin una lectura previa susceptible a carreras.
- Contrato `MandateAnchor` (Hardhat) con roles admin/pauser/anchorer permanentemente excluyentes, también después de grants y rotaciones; pruebas locales; los seis hashes de evidencia deben ser no-cero.
- Outbox hash-only + worker inyectable con `FakeMandateAnchorClient`; rechaza las representaciones hex y base64url canónicas de 32 bytes cero antes de enqueue/anchor, y mantiene estado `processing` + lease, `maxAttempts` y `txHash` persistido (sin RPC real).

## Pendiente / fuera de alcance operativo

- Escrituras on-chain reales del worker (requiere RPC, clave de anclador y contrato desplegado fuera del repo).
- Ejecución de pagos / Yuno / tokenización.
- Registry durable multi-instancia de mandatos abiertos y challenges.
- KMS/HSM de producción para `AgentMandateSigner` / `MerchantSigner`.

## Configuración local actual

- Node.js 20 o superior.
- `KYA_MODE=demo` para trabajar sin KYC, pagos ni blockchain real.
- Drafts CLI default fail-closed (el fixture estático futuro se rechaza): `NODE_ENV=test npm run mandates:create -- --input ./fixtures/validated-checkout.json`
- `MERCHANT_SIGNING_PRIVATE_JWK` opcional en development/test. Nunca usar una clave real en un fixture.

## Migraciones del ledger de mandates (Postgres self-hosted)

El policy ledger y el request store corren sobre Postgres propio (Docker local o cualquier
Postgres gestionado), no sobre Supabase. Esquema en `migrations/mandates/001_mandate_schema.sql`,
aplicado y trackeado (tabla `mandate_schema_migrations`) por `src/mandates/migrate.ts`.

```
npm run mandates:up       # levanta Postgres en Docker (puerto 55433)
npm run mandates:migrate  # aplica migrations/mandates/*.sql via MANDATES_DATABASE_URL
```

En producción, `resolvePolicyLedger` (`src/mandates/autonomy.ts`) instancia
`createPgMandatePolicyLedger()` cuando `NODE_ENV=production`, leyendo `MANDATES_DATABASE_URL`.
En dev/test se usa `InMemoryMandatePolicyLedger`.

## Tests

- `npm test` — suite hermética (sin Postgres de mandatos).
- Integración Postgres de mandatos (opt-in): `MANDATE_TEST_DATABASE_URL=postgres://catalog:catalog@127.0.0.1:55432/juno_catalog npm run test:mandates:postgres`
- Drafts CLI (default preserve timestamps): `NODE_ENV=test npm run mandates:create -- --input ./path.json`
- Bundled static demo fixture only: `NODE_ENV=test npm run mandates:create -- --input ./fixtures/validated-checkout.json --materialize-demo-clock`

## Trusted Surface EIP-712

La firma explícita del usuario usa la wallet ya vinculada por KYA, en Base Sepolia (`84532`) o Base (`8453`). `verifyAndRecordApproval()` revalida el hash canónico del payload y persiste la prueba de activación dentro de la sección crítica local antes de activar.
