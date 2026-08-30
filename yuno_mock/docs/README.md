# yuno-rest-mock

Independent **Yuno REST `/v1` mock process** for the NextWave payment stack.

This package is **not** a Yuno MCP server and **not** the platform public API.
It speaks the pinned Yuno HTTP contract (root `contracts/yuno/` +
`src/providers/yuno/`) so a future `YunoHttpClient` can target
`YUNO_BASE_URL=http://127.0.0.1:8080`.

## Current phase: F5 — Post-pay (capture / cancel / refund)

Built on F1–F4:

- Capture / cancel / refund / cancel-or-refund routes match pinned paths
  (refund uses `{id}`; siblings use `{payment_id}`)
- Transaction history: create still returns `transactions` object; retrieve
  returns a consistent history array; CAPTURE/CANCEL/REFUND appended
- Cumulative `amount.captured` / `amount.refunded` with partial + total guards
- Provider `X-Idempotency-Key` via `ProviderIdempotency` scoped by
  operation + payment/transaction (+ account)
- Signed CAPTURE / CANCEL / REFUND webhooks on the F4 delivery worker
- `refund_failed` scenario (test/dev) declines without increasing refunded
- Event rank guard allows SUCCEEDED → PARTIALLY_REFUNDED → REFUNDED

**Not** in F5: platform `/v1` payment API, platform MCP, or root
`POST /internal/webhooks/yuno` (F6).

## Quickstart

```bash
cd yuno_mock
npm install
npm start                 # http://127.0.0.1:8080
```

From repo root: `npm run yuno:mock:{start,typecheck,test,build,lint}`.

Safe fixtures (see `.env.example`):

```http
public-api-key: yuno_public_test_key
private-secret-key: yuno_private_test_key
```

### Post-pay (authorize → capture → refund)

```bash
# authorize (capture:false), then:
curl -X POST http://127.0.0.1:8080/v1/payments/$PAY_ID/transactions/$TX_ID/capture \
  -H 'public-api-key: yuno_public_test_key' \
  -H 'private-secret-key: yuno_private_test_key' \
  -H 'X-Idempotency-Key: capture-1' \
  -H 'content-type: application/json' \
  -d '{"merchant_reference":"cap-1","reason":"PRODUCT_CONFIRMED","amount":{"currency":"COP","value":400}}'
```

### 3DS / work controls (dev/test only; 404 in production)

```bash
curl -X PUT http://127.0.0.1:8080/test/scenarios/payments \
  -H 'content-type: application/json' \
  -d '{"scenario":"requires_3ds"}'
curl -X POST http://127.0.0.1:8080/test/work/process
```

## Layout

```
src/
  routes/payments.ts            # create/get + F5 post-pay
  services/post-pay.ts          # capture/cancel/refund/cancel-or-refund
  services/payment-view.ts      # history + response shapes
  services/webhook-delivery.ts  # emit CAPTURE/CANCEL/REFUND
  domain/pin-gaps.ts            # F2–F5 documented pin gaps
tests/
  f1-base.test.ts … f5-postpay.test.ts
```
