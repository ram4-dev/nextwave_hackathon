# Platform payments architecture (F6–F7)

Provider-agnostic payment API on the root Hono process, with an independent
Yuno REST mock process behind `YUNO_BASE_URL`. The same `YunoHttpClient` /
`YunoAdapter` path is used when swapping to sandbox/production via config.

```text
Agent ──MCP tool adapter──▶ Platform /v1 (root Hono)
                                │
                                ▼
              PaymentService ──AuthorizationVerifier(authorization_id)
                                │
                                ▼
                    YunoAdapter / YunoHttpClient
                                │
                                ▼
              YunoMockServer (own process)  or  Real Yuno (URL/config swap)
                                │
                                └─ HMAC → /internal/webhooks/yuno
```

## Boundaries

| Layer | Location | Rule |
| --- | --- | --- |
| Platform REST | `src/api/payments/`, `src/server/app.ts` | Provider-agnostic IDs, `value_minor`, masked methods |
| Domain | `src/services/payments/`, `src/domain/authorization/` | Idempotency, authz; never `MANDATE_MAX_AMOUNT` |
| Adapter | `src/providers/yuno/yuno-*.ts` | Currency exponents, state map, vault decrypt |
| Persistence | `src/persistence/payments/` | Separate from KYA `store.json`; AES-256-GCM vault tokens |
| MCP tools | `src/mcp/payment-tools.ts` | HTTP to platform `/v1` only — no Yuno imports |
| Mock | `yuno_mock/` | Independent package/process; never imported by platform runtime |

## Auth roles

| Actor | Gate | Routes |
| --- | --- | --- |
| Human session | `verifySessionToken` | Enrollment + payment-method CRUD |
| Buyer agent | `verifyKyaCredential` | payments create/get/list/cancel, capabilities |
| Admin | `PAYMENT_ADMIN_API_KEY` | capture, refunds, webhook-endpoints |
| Internal | `PAYMENT_INTERNAL_API_KEY` | provider health |

Demo `POST /v1/auth/login` issues a session for enrollment only — it cannot
authorize agent spend (KYA credential required). After `AuthorizationVerifier`
returns ok, principal/agent bindings must match the credential before any
provider call.

## Currency

Platform uses integer `value_minor`. Adapter converts with ISO-4217 exponents
from the SIX Group currency list (`src/domain/payments/currency.ts`). Never
hardcoded `/100`. Covered: COP/USD=2, JPY=0, KWD=3.

## Idempotency and unknown outcomes

Platform `Idempotency-Key` records are durable for success and `PaymentError`
failures (exact status + public error body). Same key/same body replays;
different body → 409; in-flight → 409. `payment_outcome_unknown` retains one
processing payment/attempt and a stable provider `X-Idempotency-Key` UUID —
retry does not create a second payment. Capture/cancel/refund provider keys
derive from the platform operation key (not payment+amount alone).

## Webhooks

- Inbound `/internal/webhooks/yuno`: HMAC verify, async apply, unmatched
  provider ids are audited but **not** added to the applied-event dedup set.
- Outbound `/v1/webhook-endpoints`: bounded async HTTP POST of normalized
  platform payloads only (delivery status + attempt count; no provider secrets).
- `refund_failed` inspects the REFUND action transaction status; parent may
  stay succeeded with unchanged refunded total.

## Config (F7 swap-readiness)

Same client path for mock and live Yuno — swap via URL + secrets only:

| Variable | Role |
| --- | --- |
| `YUNO_PROVIDER_ENV` | `mock` (default) \| `sandbox` \| `production` |
| `YUNO_BASE_URL` | Mock `http://127.0.0.1:8080` or HTTPS real API |
| `YUNO_PUBLIC_API_KEY` / `YUNO_PRIVATE_SECRET_KEY` | Provider headers |
| `YUNO_ACCOUNT_ID` | UUID for provider bodies |
| `YUNO_WEBHOOK_HMAC_SECRET` | Inbound webhook verify |
| `PAYMENT_SECRETS_KEY` | AES-256 vault encryption |
| `PAYMENT_ADMIN_API_KEY` / `PAYMENT_INTERNAL_API_KEY` | Platform role keys |

- **mock:** local fixture credentials allowed when unset; legacy
  `YUNO_MOCK_URL` alias only in mock mode.
- **sandbox/production:** never fall back to fixtures; require explicit
  `YUNO_BASE_URL` (never `YUNO_MOCK_URL`); UUID `YUNO_ACCOUNT_ID`; reject
  URL userinfo; require HTTPS; fail closed in `loadConfig` before runtime.
- Offline readiness: `npm run yuno:sandbox:readiness` — no-arg success
  requires explicit `sandbox`/`production` (see
  [`YUNO_SANDBOX_READINESS.md`](./YUNO_SANDBOX_READINESS.md)).
- Server startup logs provider mode and hostname only — never the full base
  URL or secrets.

Ceremony routes still run when payment config is missing (payment routes → 503).

## Status

| Phase | Status |
| --- | --- |
| F0–F5 | Complete (contract + independent mock) |
| **F6** | Complete — platform abstraction, MCP adapter, durable idempotency, outbound delivery, adapter + real-socket E2E (`tests/payments-*.test.ts`) |
| **F7 readiness** | Complete — provider mode gate, offline readiness CLI/module, fail-closed sandbox/production config |
| **F7 live sandbox** | **LIVE-NOT-EXECUTED** — no user credential/authorization supplied; no external Yuno call |
| Poll/reconcile beyond webhooks | Deferred |
