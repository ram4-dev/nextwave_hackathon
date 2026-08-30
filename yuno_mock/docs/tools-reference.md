# Tools reference

17 tools across 4 categories + 1 smoke tool. For how faithful each category
is to Yuno's real API, see [scope-and-fidelity.md](scope-and-fidelity.md).

Conventions used in this reference:
- **Input** lists the fields of the `inputSchema` (Zod). `?` = optional.
- Every OK response is the domain object serialized as JSON inside
  `content[0].text`. Every error response is `isError: true` with a
  plain-text message — never JSON (see `src/mcp-result.js`).

---

## `ping` (smoke tool, not part of Yuno)

Confirms the server is alive and responds to tool calls. Not part of Yuno's
real tool inventory.

- **Input:** `echo?` (string)
- **Output:** `{ ok: true, echo, servedAt }`

---

## `customers` category

### `customerCreate`
- **Input:** `first_name` (string), `last_name` (string), `email` (string,
  email format), `phone?` (string), `merchant_customer_id?` (string — the
  customer's id in the merchant's own system)
- **Output:** `{ id, first_name, last_name, email, phone, merchant_customer_id, created_at }`
- **Error:** if `merchant_customer_id` already exists, `isError` with a
  duplicate-id message.

### `customerRetrieve`
- **Input:** `customer_id` (string)
- **Output:** the customer, or an error if it doesn't exist.

### `customerRetrieveByExternalId`
- **Input:** `merchant_customer_id` (string)
- **Output:** the customer with that `merchant_customer_id`, or an error if
  it doesn't exist.

### `customerUpdate`
- **Input:** `customer_id` (string) + an optional partial subset of
  `first_name?/last_name?/email?/phone?`
- **Output:** the updated customer (only the sent fields are overwritten), or
  an error if `customer_id` doesn't exist.

---

## `checkout` category

### `checkoutSessionCreate`
- **Input:** `amount` (number > 0), `currency` (string), `country` (string),
  `merchant_order_id` (string), `description?` (string), `customer_id?`
  (string, validated against `customers`), `merchant_id?` (string, validated
  against the `merchants` directory)
- **Output:** `{ checkout_session, status: 'created', amount, currency, country, merchant_order_id, description, customer_id, merchant_id, created_at }`
- **Error:** if `customer_id` or `merchant_id` are given but don't exist.

### `checkoutSessionRetrievePaymentMethods`
- **Input:** `checkout_session` (string)
- **Output:** a direct array of the payment methods available for that
  session's `country` — `{ type, name, category, preferred }[]`, the first
  one marked `preferred: true`. The country→methods table lives in
  `src/payment-methods.js`: `CO→[CARD,PSE]`, `MX→[CARD,OXXO,SPEI]`,
  `BR→[CARD,PIX]`, any other country → `[CARD]`.
- **Error:** if `checkout_session` doesn't exist.

---

## `payments` category

Every payment originates from an existing `checkout_session` —
`paymentAuthorize`/`paymentCreate` derive `description`/`country`/`amount`/
`currency`/`merchant_order_id`/`merchant_id` from it, and resolve
`customer_payer` if the session has a `customer_id`. `account_id` is its own
input field, unrelated to `merchant_id` (see
[scope-and-fidelity.md](scope-and-fidelity.md)).

**Shape of a `Payment`:**
```
{
  id, account_id, description, country,
  status, sub_status,
  merchant_order_id, merchant_id, merchant_reference, idempotency_key,
  created_at, updated_at,
  amount: { currency, value, captured, refunded },
  checkout: { session, sdk_action_required },
  payment_method, customer_payer,
  transactions: [Transaction],   // only when requested (see paymentRetrieve)
  metadata: [],
}
```

**Shape of a `Transaction`** (what capture/cancel/refund/cancelOrRefund
return, with the full `Payment` nested in `payment`):
```
{
  id, type, status: 'SUCCEEDED', category: 'CARD',
  amount: { currency, value, captured, refunded },
  merchant_reference, created_at, updated_at,
  provider_data, connection_data, response_code, response_message,
  payment,   // the full Payment, already updated
}
```

`status`/`sub_status` values used by the mock (a subset of the full official
enum — see scope-and-fidelity.md): `PENDING`/`AUTHORIZED` (just authorized,
not captured) → `SUCCEEDED`/`CAPTURED` (or `PARTIALLY_CAPTURED`) →
`REFUNDED`/`REFUNDED` (or `SUCCEEDED`/`PARTIALLY_REFUNDED`) / `CANCELED`.
Transaction `type` values used: `AUTHORIZE`, `PURCHASE`, `CAPTURE`, `CANCEL`,
`REFUND`.

### `paymentAuthorize`
- **Input:** `checkout_session` (string), `payment_method` (free-form
  object), `account_id` (string), `merchant_reference?` (string),
  `idempotency_key?` (string)
- **Behavior:** authorizes without capturing — always forces `capture:false`,
  regardless of what's inside `payment_method`.
- **Output:** the new `Payment` in `status: 'PENDING'` / `sub_status: 'AUTHORIZED'`, with an `AUTHORIZE` transaction.
- **Error:** if `checkout_session` doesn't exist.

### `paymentCreate`
- **Input:** same as `paymentAuthorize`.
- **Behavior:** reads `payment_method.detail.card.capture` (default `true`)
  — `true` authorizes and captures in one step, `false` behaves like
  `paymentAuthorize`.
- **Output:** the new `Payment`; if it captured, `status: 'SUCCEEDED'` /
  `sub_status: 'CAPTURED'` with a `PURCHASE` transaction.
- **Idempotency:** repeating the same `account_id` + `idempotency_key`
  returns the payment already created instead of duplicating it.

### `paymentCaptureAuthorization`
- **Input:** `payment_id`, `transaction_id`, `merchant_reference` (string,
  required), `reason?` (enum `PRODUCT_CONFIRMED | REQUESTED_BY_CUSTOMER`),
  `amount?` (`{currency, value}`, for a partial capture)
- **Requires:** `transaction_id` to be an `AUTHORIZE` transaction on that
  payment, and the payment to still be `sub_status: 'AUTHORIZED'` (not
  already captured).
- **Output:** a `type: 'CAPTURE'` Transaction; the nested payment moves to
  `status: 'SUCCEEDED'`, `sub_status: 'CAPTURED'` (or `'PARTIALLY_CAPTURED'`
  if `amount` is less than the authorized amount).
- **Error:** payment/transaction not found, or already captured.

### `paymentRetrieve`
- **Input:** `payment_id`, `transactions_history?` (boolean, default false)
- **Output:** the `Payment`. The `transactions` array is only included when
  `transactions_history: true`.
- **Error:** if `payment_id` doesn't exist.

### `paymentRetrieveByMerchantOrderId`
- **Input:** `merchant_order_id`
- **Output:** an **array** of `Payment` (there can be more than one per
  order, e.g. retries).
- **Error:** if there's no payment with that `merchant_order_id`.

### `paymentCancel`
- **Input:** `payment_id`, `transaction_id`, `merchant_reference` (required),
  `description?`, `reason?` (enum `DUPLICATE | FRAUDULENT | REQUESTED_BY_CUSTOMER`)
- **Requires:** the transaction to be an `AUTHORIZE` that hasn't been
  captured.
- **Output:** a `type: 'CANCEL'` Transaction; the payment moves to
  `status: 'CANCELED'`.

### `paymentRefund`
- **Input:** `payment_id`, `transaction_id`, `merchant_reference` (required),
  `description?`, `reason?` (same enum plus `REVERSE`), `amount?` (partial)
- **Requires:** available captured balance
  (`amount.captured - amount.refunded > 0`).
- **Output:** a `type: 'REFUND'` Transaction; the payment moves to
  `status: 'REFUNDED'`/`sub_status: 'REFUNDED'` (full) or stays
  `SUCCEEDED`/`PARTIALLY_REFUNDED` (partial).

### `paymentCancelOrRefund`
- **Input:** `payment_id`, `description?`, `merchant_reference?`, `reason`
  (**required**, same 4-value enum as refund), `amount?`
- **"Smart" behavior:** no `transaction_id` — automatically cancels if the
  payment is still authorized and uncaptured, otherwise refunds it.
- **Output:** a `type: 'CANCEL'` or `'REFUND'` Transaction, whichever
  applies.

### `paymentCancelOrRefundWithTransaction`
- **Input:** `payment_id`, `transaction_id`, `description?`,
  `merchant_reference?`, `reason?` (optional, unlike the variant without a
  transaction), `amount?`
- **Behavior:** the same smart rule as `paymentCancelOrRefund`, but scoped to
  the given transaction.

---

## `merchants` category (invented — not part of Yuno's real API)

See [scope-and-fidelity.md](scope-and-fidelity.md#merchants-and-catalog-a-fully-invented-layer)
for why. Read-only, no CRUD — ~100 merchants seeded once when the process
starts.

### `merchantRetrieveAll`
- **Input:** `category?` (enum of the 12 fixed categories — see
  scope-and-fidelity.md for the full list; the category labels themselves
  are kept in Spanish, see the note there)
- **Output:** an array of `{ merchant_id, name, category, country, created_at }`,
  filtered if `category` was given.

### `merchantCatalogRetrieveAll`
- **Input:** `merchant_id` (string)
- **Output:** an array with that merchant's catalog. Shape depends on the
  `catalogType` of its category:
  - **PRODUCT:** `{ id, merchant_id, type: 'PRODUCT', name, category, price: {currency, value}, sku, stock }`
  - **SERVICE:** `{ id, merchant_id, type: 'SERVICE', name, category, price: {currency, value}, duration_minutes, modality: 'IN_PERSON'|'REMOTE'|'HYBRID' }`
- **Error:** if `merchant_id` doesn't exist in the directory.
