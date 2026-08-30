# Scope and fidelity

This mock has two categories of a different nature. It's important not to
mix them up when extending it:

- **`customers`, `checkout`, `payments`** — real Yuno API resources. Tool
  names, categories, and (for `payments`) input/output shapes are built to
  trace as closely as possible to `docs.y.uno` (Yuno's official
  documentation) and, where the evidence is stronger, to the confirmed
  behavior of the real SDK (`@yuno-payments/agent-toolkit`).
- **`merchants`** (directory + catalog) — **a layer 100% invented for this
  project**, with no equivalent in Yuno's real API. See the dedicated section
  below before assuming anything there comes from Yuno.

## `customers` / `checkout` / `payments` — fidelity to the real API

### What's confirmed vs. inferred

The tools that the real SDK's `YunoWorkflows` builds by hand
(`checkoutSessionCreate`, `checkoutSessionRetrievePaymentMethods`,
`paymentAuthorize`, `paymentCaptureAuthorization`, `paymentRetrieve`,
`customerCreate`) are the most reliable source on the real **MCP** contract —
more so than the REST docs, because Yuno's MCP server is a translation layer
for agents, not a 1:1 proxy of the REST API. Where the SDK gives no evidence,
this mock relies on `docs.y.uno`'s REST documentation as the best available
source, with no guarantee that the real MCP tool follows it to the letter.

One input decision that's kept on purpose: `paymentCreate`/
`paymentAuthorize` take `checkout_session` + `payment_method` instead of
repeating `description`/`country`/`amount`/`merchant_order_id` as loose
fields the way the full REST body does — everything already in the session
is derived from there. It's a deliberate simplification for a tool meant for
agents, not something confirmed on the real MCP side.

### `status`/`sub_status` vocabulary

The full official `status` enum for a Payment
(`docs.y.uno/reference/payments/status-and-response-codes/payment`) is:
`CREATED`, `READY_TO_PAY`, `PENDING`, `VERIFIED`, `SUCCEEDED`, `DECLINED`,
`REJECTED`, `EXPIRED`, `REFUNDED`, `CANCELED`, `IN_DISPUTE`, `CHARGEBACK`,
`ERROR`, `FRAUD`. The mock **only moves through the subset of a successful
flow**: `PENDING`→`SUCCEEDED`→`REFUNDED`/`CANCELED`. `sub_status` values
used: `AUTHORIZED`, `CAPTURED`, `PARTIALLY_CAPTURED`, `REFUNDED`,
`PARTIALLY_REFUNDED`.

The Transaction `type` enum has 11 real values
(`docs.y.uno/reference/payments/status-and-response-codes/transaction`); the
mock models 5: `AUTHORIZE`, `PURCHASE`, `CAPTURE`, `CANCEL`, `REFUND`. A
Transaction's `status` is always `SUCCEEDED` — **the mock never models a
failed transaction** (no `DECLINED`/`ERROR`/`FRAUD`/rejections of any kind,
in any tool).

### Deliberate scope cuts (not modeled anywhere)

- PCI card data (`card_data` with a real card number/CVV), 3DS
  (`THREE_D_SECURE`), `fraud_screening`, `device_fingerprints`.
- `split_marketplace` / multi-recipient splits.
- `currency_conversion` / DCC — amounts have no real FX conversion.
- Receipts (`response_additional_data.receipt*`) and webhooks.
- `additional_data.order/taxes/items` (enriched order metadata).
- Each Transaction's `provider_data`/`connection_data` are **minimal,
  recognizable stubs** (`{ provider: 'mock-provider', ... }`) — there's no
  real processor/provider behind the mock.
- Entire categories out of scope: `installmentPlans`, `recipients`,
  `routing`, `paymentMethods` (card vaulting), `paymentLinks`,
  `subscriptions`, `documentation`. They exist as real tools in Yuno's
  inventory but aren't implemented in this mock.

### Smaller, case-by-case scope simplifications

- `customerCreate`/`customerUpdate` mock a subset of fields
  (`first_name/last_name/email/phone/merchant_customer_id`) — the real REST
  API accepts a fair bit more (`document`, `billing_address`,
  `shipping_address`, `metadata[]`, etc.).
- `paymentCancel`/`paymentRefund`/`paymentCaptureAuthorization`/
  `paymentCancelOrRefundWithTransaction` assume a single relevant
  transaction per action — no splits or concurrent transactions on the same
  payment.

## Merchants and catalog: a fully invented layer

Confirmed by fetching `docs.y.uno`'s full resource index live: Customers,
Enrollment, Checkout, Payment Methods, Payments, Payment Links,
Subscriptions, Payouts, Recipients for Marketplace, Reports, Installments,
AI Caller, Communications Campaigns, Conversion Rate, Banking Connectivity.
**Neither "Merchants" nor "Catalog" exist there.** The closest real thing is
`Recipients for Marketplace` (sellers inside *the merchant's own*
marketplace, for split payments) — a different concept from a browsable
directory of other merchants, which is why that resource wasn't reused.

This category exists for this project's own needs (simulating an ecosystem
with multiple merchants), not to mirror something Yuno exposes. Everything
here is original design:

- **`account_id` (a real `payments` field) has no relation to merchants** —
  it identifies the paying user. `merchant_id` is the new, separate concept,
  and it cascades from `checkout` to `payments` the same way `customer_id`
  does (an optional field on `checkoutSessionCreate`, inherited by payments
  created from that session).
- A fixed taxonomy of 12 categories (not dynamic, hand-editable in
  `src/store.js`, same approach as the country→payment-methods table in
  `payment-methods.js`). The category **labels themselves are kept in
  Spanish** — they're literal data returned by `merchantRetrieveAll` and the
  valid values for its `category` input enum, not prose, so they aren't
  translated here: `Retail/E-commerce`, `Supermercados`, `Moda/Indumentaria`,
  `Electrónica/Tecnología`, `Hogar/Muebles`, `Gaming`, `Salud/Farmacia`
  (catalog type `PRODUCT`); `Restaurantes/Delivery`, `Viajes/Transporte`,
  `Educación`, `Entretenimiento/Streaming`, `Servicios Financieros/Fintech`
  (catalog type `SERVICE`).
- 100 merchants seeded deterministically (same result on every process
  start, not random), with stable ids `mer_001`…`mer_100` — not
  `randomUUID`, because they're reference data, not something a tool creates
  at runtime (there's no `merchantCreate`). Merchant names and catalog item
  names are also literal seeded data kept in Spanish for the same reason.
- Catalog differentiated by type (`PRODUCT` with `sku`/`stock`, `SERVICE`
  with `duration_minutes`/`modality`) — not one generic shape. Prices are
  "round" numbers in the merchant's country currency, with no real FX
  conversion (same cut as `currency_conversion` above).
- Deliberately small tool surface: read-only
  (`merchantRetrieveAll`, `merchantCatalogRetrieveAll`), no CRUD. The catalog
  is informational — no `payments` tool references it or decrements stock.

## Persistence

All state (`customers`, `checkout_sessions`, `payments`, `merchants`) lives
in memory (`src/store.js`) and is lost when the process restarts. There's no
database or persistence file — it's enough for local development against the
real Yuno SDK, not for an environment that needs to survive restarts.
