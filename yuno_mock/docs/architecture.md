# Architecture — Yuno REST mock (F5)

## Process placement

Unchanged from F1: independent Node process; root Hono never mounts these
routes. Contract facade is imported from root `src/providers/yuno/`.

**Honest F6 boundary:** `POST /internal/webhooks/yuno` on the **platform**
(root) app is **not** implemented here. The mock only **emits** signed
outbound webhooks. Shared verify helper:
`src/providers/yuno/webhook-verifier.ts`.

## Enrollment flow (F2)

```text
POST /v1/customers
POST /v1/customers/sessions
GET  /v1/checkout/customers/sessions/{id}/payment-methods
GET  /test/enrollment  →  POST /test/enrollment/tokenize
POST /v1/customers/sessions/{id}/payment-methods
…
```

## Payment + post-pay (F3–F5)

```text
PUT  /test/scenarios/payments
POST /v1/webhooks
POST /v1/payments                                          # purchase or authorize
POST /v1/payments/{payment_id}/transactions/{tx}/capture
POST /v1/payments/{payment_id}/transactions/{tx}/cancel
POST /v1/payments/{id}/transactions/{tx}/refund            # pin uses {id}
POST /v1/payments/{payment_id}/cancel-or-refund
POST /v1/payments/{payment_id}/transactions/{tx}/cancel-or-refund
GET  /v1/payments/{payment_id}
```

### Transaction model

- Create response: `transactions` remains a **single object** (primary
  AUTHORIZE/PURCHASE) for contract compatibility.
- Retrieve: `transactions` is a **history array** (primary + CAPTURE/CANCEL/REFUND).
- File/in-memory stores missing `transactions[]` are normalized on read.

### State (pin-aligned)

| Action | Payment status / sub_status |
| --- | --- |
| Partial capture | `SUCCEEDED` / `PARTIALLY_CAPTURED` |
| Full capture | `SUCCEEDED` / `CAPTURED` |
| Cancel open auth | `CANCELED` / `CANCELED` |
| Partial refund | `SUCCEEDED` / `PARTIALLY_REFUNDED` |
| Full refund | `REFUNDED` / `REFUNDED` |

`cancel-or-refund` branches: `AUTHORIZED` → cancel; captured `SUCCEEDED` → refund.

## Webhooks

Unchanged F4 delivery (HMAC, retries, worker). Post-pay emits `CAPTURE`,
`CANCEL`, and `REFUND` with stable raw bodies. Event rank guard allows
succeeded → partial refund → refunded while blocking stale rewinds.

## Secrets

| Variable | Role |
| --- | --- |
| `YUNO_PUBLIC_API_KEY` / `YUNO_PRIVATE_SECRET_KEY` | Header auth |
| `YUNO_MOCK_FINGERPRINT_SECRET` | Card fingerprint HMAC |
| `YUNO_MOCK_SECRETS_KEY` | AES-256 key for webhook secrets at rest |
| `YUNO_MOCK_WORK_POLL_MS` | Background retry/async poll interval |

## Pin gaps

See `src/domain/pin-gaps.ts` — F5 adds: post-pay amount integer→number
tolerance, refund `{id}` path param, refund payment-shaped vs action
transaction-shaped responses, partial capture `SUCCEEDED/PARTIALLY_CAPTURED`.

## Out of scope

Platform MCP/REST + `/internal/webhooks/yuno` (F6), merchant/catalog APIs,
real cards/credentials, KYA ceremony changes.
