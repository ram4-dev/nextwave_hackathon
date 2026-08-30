# Yuno API Mock Migration Spec

Self-contained implementation specification for converting the current
**direct Yuno MCP simulator** (`yuno_mock/`) into the **provider-style REST
API mock** required by the source brief
(`/Users/ramiro/Documents/Codex/2026-08-29/https-www-mastercard-com-co-es/outputs/YUNO_MOCK.md`).

**Status:** F0–F6 are implemented in this worktree. **F7 readiness** (provider
mode, fail-closed sandbox/production config, offline readiness CLI) is
implemented. A live Yuno sandbox contract run remains **LIVE-NOT-EXECUTED**
because no user credential or authorization was supplied. Optional
poll/reconcile beyond webhooks remains deferred. See
`docs/PAYMENTS.md` and `docs/YUNO_SANDBOX_READINESS.md`.

**Authority:** the source brief defines the target architecture. Repository
evidence in this worktree defines the current starting point. Where the
brief and the current mock diverge, the brief wins for the target design;
current modules are inventory and reuse candidates, not the target contract.

---

## 1. Decision and review path

### Decision

Build a **platform payment API for agents** and, behind it, an independent
**Yuno HTTP mock** that is compatible with the official Yuno REST contract
fixed by a versioned OpenAPI snapshot. The buying agent never calls Yuno
directly. It uses small, permissioned platform MCP tools. The platform
backend enforces payment rules and translates through a `YunoClient` /
`YunoAdapter` to the Yuno HTTP contract.

| Layer | Contract | Decision |
| --- | --- | --- |
| Agent | Platform MCP tools | Intent-oriented, role-limited; adapter over platform REST only |
| External clients | Platform `/v1/*` REST | Stable, provider-agnostic; hosted on root Hono |
| Domain | `PaymentService` + `PaymentProvider` + `AuthorizationVerifier` | Rules, idempotency, audit; opaque `authorization_id` |
| Adapter | `YunoAdapter` + `YunoHttpClient` | Own domain ↔ Yuno HTTP |
| Mock | Official Yuno HTTP contract | Independent process/package; snapshot-compatible |
| Future production | Real Yuno API | Swap via `YUNO_BASE_URL` + secret-injected credentials only |

**Central rule:** the public platform API must **not** copy Yuno. The
`YunoMockServer` **must** copy the fixed Yuno snapshot. They are two
contracts joined by a tested adapter.

**Process placement:** the root TypeScript Hono app hosts provider-agnostic
platform payment routes and the Yuno webhook receiver. The Yuno REST mock
stays an **independent process/package** so `YUNO_BASE_URL` can point at the
mock or at real Yuno without embedding the provider inside the platform
process. Platform MCP is a **separate adapter** that calls only the platform
REST API. Exact DB driver remains an implementation decision.

### Review path (before any production implementation)

1. Confirm this migration spec against the source brief and repository
   evidence (this document).
2. **Gate F0 (complete):** `contracts/yuno/openapi.json` + `METADATA.md` verified
   via `npm run yuno:contract:verify`. Types/validators generated via
   `npm run yuno:contract:generate` and guarded by
   `npm run yuno:contract:check-generated`. Executable F0 rules:
   `docs/YUNO_F0_CONTRACT_SPEC.md`.
3. Review OpenAPI-derived route/schema diffs before writing provider routes.
   After an accepted pin bump, regenerate and drift-check generated artifacts.
4. Implement phases F0→F7 in dependency order (Section 15). Do not start
   public API or platform MCP tools before the Yuno mock contract is fixed
   enough to prove interchangeability.
5. Independent review after each phase that changes contracts, money
   movement, webhooks, or secret handling.
6. Acceptance criteria in Section 16 must be checked against the brief
   before claiming swap-readiness.

### Explicit non-goals for this document

- No live Yuno credentials, real PAN/CVV, or on-chain payment work in-repo.
- No changes to the KYA ceremony MVP (`FLOW.md` remains identity/auth).
- No silent inventing of OpenAPI fields not present in a committed snapshot.
- Live sandbox execution remains gated on operator-supplied credentials
  (F7 readiness code does not imply LIVE-EXECUTED).

---

## 2. Current-state evidence

Verified in this worktree on 2026-08-30.

### Root application (Hono KYA MVP)

- `src/server/app.ts` — Hono `createApp` with ceremony, mocked auth/KYC,
  enrollments, challenges, credentials, `/health`, `/v1/config`,
  `/.well-known/jwks.json`, and **F6** optional payment routes via third
  argument / `createPaymentRuntime`. Session gate: `requireSession` via
  Bearer + `verifySessionToken`. Credential verify: `verifyKyaCredential`.
  Login: `POST /v1/auth/login` accepts an address and issues a session —
  **demo-only; cannot authorize agent payments.**
- `src/server/index.ts` — serves the KYA app via `@hono/node-server`,
  `JsonFileRepository`, and optional payment runtime from `YUNO_*` config.
- `src/config/env.ts` / `.env.example` — `YUNO_PROVIDER_ENV` (`mock` default),
  `YUNO_BASE_URL` (replaces unused `YUNO_MOCK_URL`), provider keys,
  `PAYMENT_*` secrets/admin/internal keys. Sandbox/production fail closed
  (no fixture fallback). `MANDATE_MAX_AMOUNT` remains a separate
  authorization-policy placeholder and is **not** read by `PaymentService`.
- `src/providers/yuno/sandbox-readiness.ts` + `npm run yuno:sandbox:readiness`
  — offline F7 readiness (issue codes only; never live Yuno calls).
- `AGENTS.md` — this build mocks the KYA ceremony end-to-end; there is no
  live wallet/SIWE/KYC/on-chain write in this codebase. Payments are outside
  current MVP capability.
- Root docs (`FLOW.md`, `docs/IMPLEMENTATION.md`, `docs/SOURCES.md`) cover
  identity/auth, not Yuno payment abstraction.

### Current `yuno_mock/` (independent Yuno REST mock)

| Fact | Evidence |
| --- | --- |
| Transport | Hono REST on `GET /health` + authenticated `/v1/*` (`yuno_mock/src/app.ts`) |
| Provider entrypoint | Independent process (`npm run yuno:mock:start`); **not** MCP |
| Contract | Consumes root `src/providers/yuno` generated facade (pinned OpenAPI) |
| F1 scope | Auth, errors, persistence, provider idempotency |
| F2 scope | Seven enrollment/customer MVP routes + test UI tokenization |
| State | In-memory or atomic file JSON under `YUNO_DATA_DIR` (not KYA store) |
| Merchants/catalog | **Removed** from provider mock (invented; out of scope) |
| Package | `yuno_mock/package.json` (`yuno-rest-mock`); TypeScript |
| OpenAPI snapshot | **Pinned + generated** — see `docs/YUNO_F0_CONTRACT_SPEC.md` |

### Compatibility status of the current mock

**F2 provides enrollment** (customers, sessions, Checkout enroll/list/get/unenroll,
test UI tokenization). Payment create/get are F3; capture/actions remain F4+. The former direct Yuno
MCP simulator was removed as the provider entrypoint.

---

## 3. Target end-to-end flow and boundaries

### Target flow (from brief)

```text
Agent ──MCP──▶ Platform MCP (separate adapter) ──▶ Platform /v1 (root Hono)
                                                       │
                                                       ▼
                         PaymentService ──AuthorizationVerifier(authorization_id)
                                                       │
                                                       ▼
                                           YunoAdapter / YunoHttpClient
                                                       │
                              ┌────────────────────────┴────────────────────────┐
                              ▼                                                 ▼
                   YunoMockServer (own process)                      Real Yuno API
                              │                                                 │
                              └────────── HMAC → /internal/webhooks/yuno ───────┘
                                                       │
                                                       ▼
                                            PaymentService → payment DB
```

User enrollment UI (test-only) talks to the mock with fictional card data;
the public API never receives PAN/CVV. Root Hono never hosts the Yuno REST
mock as its provider surface; it only configures `YUNO_BASE_URL`.

### Included

- Payment customer create/retrieve at the provider.
- Customer sessions and Checkout-workflow enrollment.
- Enroll / list / get / unenroll payment methods (opaque platform IDs).
- Simulated tokenization; encrypted vaulted references only inside the adapter boundary.
- Create payments (automatic capture or manual authorize).
- Get/list payments; normalized states; capture / cancel / refund /
  cancel-or-refund.
- Simulated 3DS / user action.
- HMAC webhooks with dedup and out-of-order tolerance.
- Two-layer idempotency; retries; timeouts; uncertain outcomes.
- Platform MCP tools + platform REST for clients.
- Contract tests against the committed Yuno OpenAPI snapshot (once present).

### Out of scope

- KYC / KYB / KYA / ERC-8004 / agent identity registration (owned by `FLOW.md`).
- AP2 mandate creation/verification.
- Merchant enrollment or inventing a Yuno “merchants” resource.
- Real Yuno credentials or real cards.
- Acquirer/PSP production selection inside Yuno.
- Settlement, bank reconciliation, full dispute/chargeback operations.
- Letting arbitrary external merchants charge a vaulted card under our Yuno account as a universal credential.
- Embedding invented merchant/catalog directory data inside the Yuno provider mock.

### Boundary: invented merchant/catalog data

The current `yuno_mock` merchant directory + catalog (`mer_001`…`mer_100`,
`merchantRetrieveAll`, `merchantCatalogRetrieveAll`) is project fiction.
**Keep that data outside the Yuno provider mock.** If the product still
needs a merchant/catalog surface, it belongs in a separate platform module
or fixture package — never as fake Yuno REST routes and never as evidence
of Yuno fidelity.

### Boundary: payment authorization vs credentials

`PaymentService` consumes an opaque `authorization_id` through an
`AuthorizationVerifier` port before calling the provider. This spec does not
define how authorizations are minted.

**`MANDATE_MAX_AMOUNT` is not payment authorization.** Today it is only a
config placeholder (comment mentions `evaluateMandate`; no payment caller).
It either remains owned by a **separate authorization-policy** module that
issues/validates `authorization_id`s, or is **removed if unused**. It must
not be read inside `PaymentService` as a substitute for
`AuthorizationVerifier`.

### Boundary: authentication and roles (integrate with current root code)

Wire payment routes to existing root auth primitives; do not invent a
parallel login for money movement.

| Actor / gate | Current root hook | Payment use |
| --- | --- | --- |
| Human session | `requireSession` / `verifySessionToken` (Bearer after login) | Enrollment and payment-method management (`/v1/payment-method-enrollments`, `/v1/payment-methods`) |
| Buyer agent | Verified agent credential via `verifyKyaCredential` (issued after ceremony) | `payments.create` / `get` / `list` / `cancel` (and matching MCP tools) |
| Admin / internal | Explicit administrative or internal authorization (beyond demo session) | `payments.capture`, refunds create/get |
| Internal service | Dedicated internal-service auth (not agent/human session) | Scenario controls, provider webhook configuration, and related `/internal/*` ops |

**Demo login caveat:** `POST /v1/auth/login` currently accepts an address and
issues a session without wallet proof. That path is **demo-only and cannot
authorize real payments.** Real payment enrollment and agent spend require
the verified session/credential boundaries above (and live auth when the
KYA build leaves mock mode).

---

## 4. Preserve / change / remove matrix

By current file or module. “Preserve” means reuse knowledge or extractable
logic during migration; it does not mean keep the MCP-facing surface as the
provider contract.

| Current path | Disposition | Notes |
| --- | --- | --- |
| `yuno_mock/src/server.js` | **Remove as provider entrypoint** | MCP `/mcp` is exploratory only. Provider entry is independent Yuno REST. Optional MCP compatibility probe, if retained, stays isolated from runtime and must not be the provider entrypoint. |
| `yuno_mock/src/mcp-result.js` | **Remove from provider path** | MCP `ok`/`fail` wrappers are not part of Yuno REST. |
| `yuno_mock/src/tools/customers.js` | **Change → domain/store knowledge; remove as MCP provider surface** | Reuse create/retrieve/update/`merchant_customer_id` uniqueness rules when implementing REST `POST/GET /customers`. Customer MCP tools move to platform layer with different names/schemas. |
| `yuno_mock/src/tools/checkout.js` | **Change heavily** | Checkout-session-as-payment-source is MCP agent simplification. Target enrollment uses customer sessions + Checkout enrollment routes; payments use REST `POST /payments` with amount body, not only session inheritance. |
| `yuno_mock/src/tools/payments.js` | **Preserve transition knowledge; change delivery** | Keep capture/cancel/refund/cancel-or-refund guards, reason enums, partial refund math, authorize vs purchase. Re-home behind REST routes and fuller Yuno status set. |
| `yuno_mock/src/tools/merchants.js` | **Remove from Yuno provider mock** | Invented; relocate outside provider if still needed. |
| `yuno_mock/src/store.js` (customers, payments, transactions, idempotency map) | **Preserve then evolve** | Keep entity ideas and transition helpers; replace with durable persistence and Yuno-faithful idempotency states. Drop merchant/catalog seed from provider store. |
| `yuno_mock/src/store.js` (merchants + catalog seed) | **Remove from provider** | Move to non-Yuno fixture if product needs it. |
| `yuno_mock/src/payment-methods.js` | **Change** | Country→method table may inform enrollment availability fixtures; target enrollment/list routes follow snapshot schemas (including vaulted method shapes), not only checkout array stubs. |
| `yuno_mock/scripts/test-customers.js` | **Preserve as test knowledge** | Duplicate `merchant_customer_id`, retrieve by id/external id, update patch semantics → rewrite as REST/contract tests. |
| `yuno_mock/scripts/test-checkout.js` | **Change / partial preserve** | Session creation knowledge only where still relevant to customer sessions; do not treat MCP checkout payment-method list as the final enrollment contract. |
| `yuno_mock/scripts/test-payments.js` | **Preserve as test knowledge** | Authorize→capture→refund, direct purchase, cancel, cancel-or-refund branches, partial/over-refund, idempotent replay, invalid transitions → rewrite against REST mock + mapping tests. |
| `yuno_mock/scripts/test-merchants.js` | **Remove from provider suite** | Not Yuno. |
| `yuno_mock/scripts/smoke-test.js` | **Change** | Replace MCP ping smoke with provider health + auth header smoke. Optional isolated MCP probe smoke must not gate provider readiness. |
| `yuno_mock/docs/*` | **Preserve as historical fidelity notes; supersede for target** | Useful inventory of what was inferred vs confirmed; target authority is OpenAPI snapshot + brief. |
| `yuno_mock/package.json` | **Change** | Evolve into independent Yuno REST mock package (own process). Stop presenting MCP SDK compatibility as the primary product. |
| Root `src/config/env.ts` | **Change** | Rename unused `YUNO_MOCK_URL` → provider-neutral `YUNO_BASE_URL`. Add mock-safe vs secret-injected real credential fields (Section 4.1). Keep `MANDATE_MAX_AMOUNT` out of `PaymentService` (separate authz policy or remove if unused). |
| Root `.env.example` | **Change** | Mirror `YUNO_BASE_URL` + safe mock credential placeholders only; never real secrets. Document that blank/unset base URL fails closed for payments (no silent stub that pretends to be Yuno). |
| Root `src/server/app.ts` | **Preserve; extend later (F6)** | Remains KYA ceremony host. Mount provider-agnostic payment `/v1` + `/internal/webhooks/yuno` here; do not embed Yuno mock routes. Reuse `requireSession` / `verifyKyaCredential`; add admin and internal-service gates. |
| Root `src/auth/session.ts`, `src/credentials/jws.ts` | **Preserve; integrate** | Human session and agent credential verification are the payment auth foundations (Section 3). |
| Root `src/persistence/repository.ts` | **Preserve pattern; do not overload blindly** | KYA `store.json` is ceremony state. Payment tables are a separate persistence concern (Section 14). Exact DB driver is an implementation decision. |
| `contracts/yuno/*` | **Preserve pin** | Snapshot + metadata. After pin bumps: update metadata, `yuno:contract:generate`, `yuno:contract:check-generated`. |
| `src/providers/yuno/generated/*` | **Preserve generated; regenerate only via script** | Full types + MVP registry from the pin. |
| `src/providers/yuno/validate.ts` | **Preserve handwritten facade** | `validateRequest` / `validateResponse` over generated schemas. |

### 4.1 Target configuration (`env.ts` / `.env.example`)

| Variable | Role |
| --- | --- |
| `YUNO_PROVIDER_ENV` | `mock` (default) \| `sandbox` \| `production`. Live modes never use fixture fallbacks. |
| `YUNO_BASE_URL` | Provider-neutral base URL. Dev/test → mock process (e.g. `http://127.0.0.1:8080`). Sandbox/production → HTTPS real API. Replaces unused `YUNO_MOCK_URL`. |
| `YUNO_PUBLIC_API_KEY` | Sent as `public-api-key`. Mock: fixed safe test value in `.env.example`. Real: secret-injected only. |
| `YUNO_PRIVATE_SECRET_KEY` | Sent as `private-secret-key`. Mock: fixed safe test value. Real: secret-injected only; never committed. |
| `YUNO_ACCOUNT_ID` | Body `account_id` when the snapshot requires it. Mock-safe placeholder allowed in examples. |
| `YUNO_WEBHOOK_HMAC_SECRET` | Receiver verification secret. Mock: documented test secret. Real: secret-injected. |
| `MANDATE_MAX_AMOUNT` | **Not** a payment authz input for `PaymentService`. Keep only if a separate authorization-policy module still owns mandate evaluation; otherwise remove. |

Mock credentials are non-secret fixtures the independent mock accepts. Real
credentials are injected at runtime (env/secret store) and never appear in
version control. `YunoHttpClient` always talks to `YUNO_BASE_URL` with the
configured keys — no `if mock` branch inside `PaymentService`. Offline
readiness: `npm run yuno:sandbox:readiness` / `docs/YUNO_SANDBOX_READINESS.md`.

---

## 5. Exact public REST API (platform)

Platform routes are **our** contract. They use internal IDs, `value_minor`,
and never accept PAN, CVV, `vaulted_token`, or Yuno credentials.

### Principles

- Internal IDs only in responses exposed to agents/clients.
- Integer `value_minor` for money.
- `Idempotency-Key` required on monetary operations.
- Normalized statuses only (Section 10); never raw Yuno substates as the
  public success signal.
- `next_action` when the user must complete a step.

### Payment methods

Human session required (Section 3).

| Method | Path | Use |
| --- | --- | --- |
| `POST` | `/v1/payment-method-enrollments` | Start enrollment; return `next_action` |
| `GET` | `/v1/payment-method-enrollments/{id}` | Enrollment result |
| `GET` | `/v1/payment-methods` | List methods for authenticated user |
| `GET` | `/v1/payment-methods/{id}` | Opaque method detail |
| `PATCH` | `/v1/payment-methods/{id}` | Local alias / default |
| `DELETE` | `/v1/payment-methods/{id}` | Unenroll at provider + deactivate locally |

Visible payment-method shape:

```json
{
  "id": "pm_01J...",
  "type": "card",
  "status": "active",
  "brand": "visa",
  "last4": "4242",
  "expiration_month": 12,
  "expiration_year": 2030,
  "is_default": true
}
```

### Payments

Buyer-agent verified credential for create/get/list/cancel. Capture requires
administrative or internal authorization.

| Method | Path | Use |
| --- | --- | --- |
| `POST` | `/v1/payments` | Create authorize or purchase |
| `GET` | `/v1/payments/{id}` | Canonical payment state |
| `GET` | `/v1/payments` | List by status, order, date, merchant |
| `POST` | `/v1/payments/{id}/capture` | Capture manual authorization |
| `POST` | `/v1/payments/{id}/cancel` | Cancel eligible operation |

Create example:

```http
POST /v1/payments
Idempotency-Key: pay-order-982-attempt-1
Authorization: Bearer <verified agent credential>
Content-Type: application/json
```

```json
{
  "merchant_id": "mer_01J...",
  "authorization_id": "authz_01J...",
  "payment_method_id": "pm_01J...",
  "merchant_order_id": "order_982",
  "description": "Agent-requested purchase",
  "amount": { "currency": "COP", "value_minor": 125000 },
  "capture_method": "automatic",
  "return_url": "https://app.example.test/payments/return"
}
```

Normalized response example:

```json
{
  "id": "pay_01J...",
  "status": "processing",
  "amount": { "currency": "COP", "value_minor": 125000 },
  "capture_method": "automatic",
  "next_action": null,
  "created_at": "2026-08-29T12:00:00Z"
}
```

### Refunds

Administrative or internal authorization.

| Method | Path | Use |
| --- | --- | --- |
| `POST` | `/v1/refunds` | Full or partial refund |
| `GET` | `/v1/refunds/{id}` | Get refund |
| `GET` | `/v1/refunds?payment_id={id}` | List refunds for a payment |

### Capabilities

```http
GET /v1/payment-capabilities?merchant_id=mer_01J...&country=CO&currency=COP
```

### Platform webhooks (outbound to our clients)

| Method | Path | Use |
| --- | --- | --- |
| `POST` | `/v1/webhook-endpoints` | Register destination |
| `GET` | `/v1/webhook-endpoints` | List |
| `DELETE` | `/v1/webhook-endpoints/{id}` | Deactivate |

These deliver **our** normalized model only — never unfiltered Yuno payloads.

### Internal (not agent-facing)

Internal-service auth. Scenario/replay only in test/dev; disabled in
production builds. HMAC validation still required on the Yuno webhook body.

```http
POST /internal/webhooks/yuno
POST /internal/mock/yuno/scenarios
POST /internal/mock/yuno/events/replay
GET  /internal/providers/yuno/health
```

---

## 6. Safe platform MCP tools and role limits

Platform MCP is a **separate adapter over the platform REST API** — not a
mirror of Yuno MCP, not embedded in the Yuno mock process, and not a
provider entrypoint. Tools call platform `/v1` only. No tool may know Yuno
URLs, credentials, or `vaulted_token`. Role limits match Section 3.

### Allowed for a buyer agent (verified agent credential)

| Tool | Result |
| --- | --- |
| `payment_methods.begin_enrollment` | Starts human-gated enrollment flow (user completes with human session) |
| `payment_methods.list` | Masked usable methods |
| `payment_methods.remove` | Sensitive; policy-gated (typically human session / stronger policy) |
| `payment_capabilities.get` | Limits and allowed operations |
| `payments.create` | Authorized via `authorization_id` + idempotent create |
| `payments.get` | Status |
| `payments.list` | Payments in authorized context |
| `payments.cancel` | Cancel if policy and state allow |

### Restricted to administrative / internal roles

| Tool | Reason |
| --- | --- |
| `payments.capture` | Moves previously authorized funds |
| `refunds.create` | Reverses funds; explicit permission |
| `refunds.get` | May expose merchant operational detail |

### Explicitly not platform MCP tools

- Raw Yuno tool names (`paymentCreate`, `customerCreate`, …) from the
  exploratory fixture (18-tool MCP server).
- Any tool that accepts PAN/CVV/`vaulted_token`.
- Merchant/catalog browsing tools that pretend to be Yuno.
- Direct calls to the independent Yuno mock or real Yuno API.

---

## 7. Required Yuno provider REST routes

Relative to Yuno `/v1` (sandbox docs use `https://api-sandbox.y.uno/v1`).
**Final path/schema/status authority is the pinned OpenAPI snapshot** at
`contracts/yuno/openapi.json` (see `docs/YUNO_F0_CONTRACT_SPEC.md` and
`npm run yuno:contract:verify`). The table below is the MVP route set;
parameter names follow the pin (notably refund uses `{id}`, webhooks use
`{webhook_id}`). Generated types/validators live under
`src/providers/yuno/generated` and `src/providers/yuno/validate.ts`.

### Customers and payment methods

| Method | Yuno path | Use |
| --- | --- | --- |
| `POST` | `/customers` | Create customer |
| `POST` | `/customers/sessions` | Create customer session |
| `GET` | `/checkout/customers/sessions/{customer_session}/payment-methods` | Methods available for enrollment |
| `POST` | `/customers/sessions/{customer_session}/payment-methods` | Enroll (Checkout workflow) |
| `GET` | `/payment-methods/{payment_method_id}` | Get enrolled method |
| `GET` | `/customers/{customer_id}/payment-methods` | List enrolled methods |
| `POST` | `/customers/payment-methods/{payment_method_id}/unenroll` | Unenroll (Checkout workflow) |

MVP chooses **Checkout workflow** for enrollment and must not mix Direct
unenrollment contracts.

### Payments and transactions

| Method | Yuno path | Use |
| --- | --- | --- |
| `POST` | `/payments` | Purchase or authorize |
| `GET` | `/payments/{payment_id}` | Get payment |
| `POST` | `/payments/{payment_id}/transactions/{transaction_id}/capture` | Capture |
| `POST` | `/payments/{payment_id}/transactions/{transaction_id}/cancel` | Cancel |
| `POST` | `/payments/{id}/transactions/{transaction_id}/refund` | Refund (pin uses `{id}`, not `{payment_id}`) |
| `POST` | `/payments/{payment_id}/cancel-or-refund` | Auto by state |
| `POST` | `/payments/{payment_id}/transactions/{transaction_id}/cancel-or-refund` | Per-transaction variant |

### Webhook configuration

| Method | Yuno path | Use |
| --- | --- | --- |
| `POST` | `/webhooks` | Create webhook |
| `GET` | `/webhooks` (+ related snapshot resources) | Read config |
| `PATCH` | `/webhooks/{webhook_id}` | Update |
| `DELETE` | `/webhooks/{webhook_id}` | Delete |

### Provider headers

```http
public-api-key: <redacted>
private-secret-key: <redacted>
Content-Type: application/json
X-Idempotency-Key: <stable value when the endpoint requires it>
```

`X-Idempotency-Key` is required for payment creation, enrollment, and
monetary operations (capture/cancel/refund/cancel-or-refund) **when the
snapshot says so**. Do not require it indiscriminately on every `POST`.
The pinned OpenAPI defines `public-api-key`, `private-secret-key`,
`X-Idempotency-Key`, and also `X-Account-Code` (multi-account) plus alternate
`X-Public-Api-Key` / `X-Private-Secret-Key` schemes — use only what each
operation’s security requirements specify. `account_id` belongs in the body
when the schema requires it.

### Minimum bodies (brief; schemas snapshot-gated)

Create customer:

```json
{ "merchant_customer_id": "usr_01J..." }
```

Create session:

```json
{
  "account_id": "acc_test",
  "country": "CO",
  "customer_id": "cus_yuno_test"
}
```

Checkout enrollment:

```json
{
  "account_id": "acc_test",
  "payment_method_type": "CARD",
  "country": "CO",
  "verify": {
    "vault_on_success": true,
    "currency": "COP"
  }
}
```

If `verify` is sent, the mock must validate it as the snapshot would; reject
combinations Yuno would reject.

Create payment with vaulted method:

```json
{
  "account_id": "acc_test",
  "merchant_order_id": "order_982",
  "description": "Agent-requested purchase",
  "country": "CO",
  "amount": { "currency": "COP", "value": 1250.00 },
  "workflow": "DIRECT",
  "payment_method": {
    "type": "CARD",
    "vaulted_token": "token_mock_redacted"
  }
}
```

Manual authorize uses the same `POST /payments` with
`payment_method.detail.card.capture: false` per fixed contract — there is no
separate authorize endpoint.

### Post-payment bodies

| Operation | Relevant required body |
| --- | --- |
| Capture | `merchant_reference`, `amount.currency`, `amount.value`, `reason` |
| Cancel | `merchant_reference` |
| Refund | `merchant_reference`; `amount` for partial |
| Cancel-or-refund | `reason`; optional `amount` for partial |

Cancel-or-refund reasons from the reviewed contract: `DUPLICATE`,
`FRAUDULENT`, `REQUESTED_BY_CUSTOMER`, `REVERSE`.

**Reusable knowledge from current tests:** capture reasons
`PRODUCT_CONFIRMED` | `REQUESTED_BY_CUSTOMER`; cancel reasons without
`REVERSE`; refund reasons including `REVERSE`; partial refund remaining
balance checks; cancel only when `AUTHORIZE` + `PENDING`/`AUTHORIZED`.

---

## 8. Domain IDs and secret exposure rules

| Platform | Yuno | Public exposure |
| --- | --- | --- |
| Internal `customer_id` | Yuno `customer_id` | Internal only |
| Internal `payment_method_id` | Yuno `payment_method_id` + `vaulted_token` | Internal id + masked brand/last4/exp |
| Internal `payment_id` | Yuno `payment_id` | Internal only |
| `payment_attempt_id` | Yuno `transaction_id` | Not by default |
| Internal `refund_id` | Refund/transaction ref | Internal only |
| `authorization_id` | Not necessarily forwarded | `AuthorizationVerifier` before Yuno; not `MANDATE_MAX_AMOUNT` |

### Secrets and sensitive material

- Never commit real `public-api-key`, `private-secret-key`, HMAC secrets, or
  live tokens.
- `vaulted_token` is stored encrypted; decrypted only inside the adapter when
  building Yuno requests; **never** returned to agent, main frontend, logs,
  or metrics.
- PAN/CVV never enter `PublicPaymentApi`, platform DB, or platform logs.
- Provider payloads retained for audit must be redacted.
- Do not store Yuno private keys, identity documents, or raw card data.

---

## 9. `value_minor` conversion

- Platform API accepts/returns integer `amount.value_minor` + ISO currency.
- Adapter converts to Yuno `amount.value` **decimal** using the ISO-4217
  exponent for that currency.
- **Never** always divide/multiply by 100. Zero-decimal and three-decimal
  currencies must use the correct exponent table (source decided at
  implementation kickoff; see open decisions).
- Mapping tests must cover at least one two-decimal currency (e.g. COP/USD
  as applicable) and document the exponent source.
- Current exploratory mock uses floating `amount`/`value` on checkout and
  payments without minor units — that pattern must not leak into the
  platform public API.

---

## 10. Normalized states and errors

### State mapping (Yuno → public)

| Yuno | Public | Rule |
| --- | --- | --- |
| `CREATED`, `READY_TO_PAY` | `created` | Not processed yet |
| `PENDING` / `WAITING_ADDITIONAL_STEP` | `requires_user_action` | Include `next_action` |
| `PENDING` / `IN_PROCESS` (or pending confirmation/review) | `processing` | Do not assume success |
| `PENDING` / `AUTHORIZED` | `authorized` | Funds held, not captured |
| `SUCCEEDED` / `APPROVED`, `CAPTURED` | `succeeded` | Confirmed success |
| `DECLINED`, `REJECTED` | `declined` | Terminal decline |
| `ERROR`, `EXPIRED` | `failed` | Terminal failure |
| `CANCELED` | `canceled` | Canceled |
| Success with partial refund | `partially_refunded` | Keep cumulative amounts |
| `REFUNDED` | `refunded` | Full refund confirmed |

**Never** treat `PENDING` or `AUTHORIZED` as successful payment.

Current exploratory mock only exercises the happy subset and always marks
transactions `SUCCEEDED`. The provider mock must expand to decline, error,
3DS wait, and async terminal outcomes per scenarios (Section 13).

### Public errors

| Public code | Retry | Meaning |
| --- | --- | --- |
| `payment_method_unavailable` | No | Inactive or disallowed method |
| `authorization_invalid` | No | Missing, expired, or incompatible authz |
| `payment_declined` | No | Safe terminal decline |
| `user_action_required` | Yes, after user action | 3DS or similar |
| `provider_temporarily_unavailable` | Yes | Transient provider failure |
| `payment_outcome_unknown` | Query; do not recreate | Timeout after submit |
| `idempotency_key_reused` | Not with that body | Key reused incorrectly |
| `operation_not_allowed` | No | State or permission mismatch |

Raw provider details stay internal; agents see normalized codes only.

### Stored credentials metadata

Adapter/mock must support Yuno stored-credential fields when the snapshot
requires them: `reason` (`CARD_ON_FILE` | `SUBSCRIPTION` |
`UNSCHEDULED_CARD_ON_FILE`), `usage` (`FIRST` | `USED`), and network
transaction association when applicable. Business policy chooses values;
the mock validates like the real contract.

---

## 11. Two-layer idempotency

### Layer A — platform

`Idempotency-Key` bound to actor, operation, and request body hash.

| Case | Behavior |
| --- | --- |
| Same key + same body | Return original result |
| Same key + different body | `409 idempotency_key_reused` |
| Original still in flight | Normalized `request_in_progress` (`409`/`202` as platform chooses consistently) |
| Timeout without response | Keep `processing`; retry same key or GET status |
| Duplicate webhook | Ack without repeating money effects |
| Agent retry | Must not create a second payment accidentally |

### Layer B — Yuno provider mock (`X-Idempotency-Key`)

Stable UUID derived from the internal attempt. Persist; do not use
request-scoped cache only.

| Yuno situation | Mock response |
| --- | --- |
| First request created a payment | Retry with same key returns original payment; body of retry ignored |
| First request still in progress | HTTP `400` `REQUEST_IN_PROCESS`; retry later with same key |
| First request failed before create but consumed key | HTTP `400` `IDEMPOTENCY_DUPLICATED`; use a new key |
| Rejected before start (e.g. invalid body) | Key not consumed; valid retry proceeds |
| Timeout / connection cut / `500` / unreadable response | Retry with **same** key; never rotate while outcome unknown |

Platform may be stricter about same-key/different-body than Yuno; that
difference is intentional. Current exploratory map
(`account_id:idempotency_key` → payment id) only covers the “return same
payment” happy path and must be upgraded.

---

## 12. Webhook HMAC, dedup, and order

### Configuration shape (brief)

```json
{
  "account_id": "acc_test",
  "name": "payments-webhook",
  "url": "https://api.example.test/internal/webhooks/yuno",
  "hmac_client_secret": "<redacted>",
  "enrollment_triggers": ["ENROLL", "UNENROLL"],
  "payment_triggers": [
    "AUTHORIZE", "CANCEL", "CAPTURE", "CHARGEBACK", "PRECHARGEBACK",
    "PURCHASE", "REFUND", "VERIFY"
  ]
}
```

Exact schema is snapshot-gated.

### Validation

- Header: `x-hmac-signature`
- Algorithm: HMAC-SHA256 over the **raw body**
- Encoding: Base64
- Constant-time compare
- Receiver returns HTTP `200` quickly; process asynchronously
- Mock reproduces Yuno’s documented retry policy (up to **7** retries)

### Robustness

- Deduplicate by event id and/or stable hash.
- Repeated delivery must not repeat monetary effects.
- Tolerate out-of-order events.
- Never regress from a terminal state because of a stale event.
- If ambiguous, `GET /payments/{payment_id}` before deciding.
- Store redacted payload + processing result for audit.

Endpoint: `POST /internal/webhooks/yuno` (not exposed to agents).

Current exploratory mock has **no webhooks** — this is net-new provider
behavior.

---

## 13. Deterministic scenarios

Selected only via internal API, fixture, or test data rules — **never** via
a public platform API parameter.

| Scenario | Expected outcome |
| --- | --- |
| `success` | Immediate successful payment |
| `declined` | Terminal decline |
| `insufficient_funds` | Normalized decline with safe reason |
| `requires_3ds` | `requires_user_action` → challenge → result |
| `provider_timeout` | Uncertain outcome; later reconciliation |
| `processing_then_success` | Pending response + success webhook |
| `processing_then_declined` | Pending response + decline webhook |
| `authorized` | Manual auth without capture |
| `refund_success` | Confirmed refund |
| `refund_failed` | Refund failure without changing refunded amount |
| `duplicate_webhook` | Same event delivered multiple times |
| `out_of_order_webhooks` | Stale event after terminal |
| `invalid_hmac` | Rejected; no state mutation |

Control endpoints (dev/test only): see Section 5 internal routes.

---

## 14. Persistence

| Table | Purpose |
| --- | --- |
| `payment_customers` | Internal user ↔ provider customer |
| `payment_method_enrollments` | Enrollment status and expiry |
| `payment_methods` | Masked method + encrypted provider refs |
| `payments` | Canonical status and amounts |
| `payment_attempts` | Attempts / provider transactions |
| `refunds` | Refunds and cumulatives |
| `provider_events` | Inbound events + dedup |
| `webhook_deliveries` | Inbound/outbound delivery attempts |
| `idempotency_records` | Request hash, status, stable response |

Sensitive internal fields: `provider_customer_id`,
`provider_payment_method_id`, encrypted `provider_vaulted_token`,
`provider_payment_id`, `provider_transaction_id`, redacted provider
payloads.

Current in-memory `Map` store is acceptable only as a transitional mock
backing store for early phases; durable records are required for
platform idempotency and webhook dedup in integrated environments.
**Exact DB driver is an implementation decision**; do not prescribe one here.

Do not put invented merchant/catalog seed tables inside the Yuno provider
persistence model. Keep payment persistence out of KYA `store.json`.

---

## 15. Dependency-ordered phases

| Phase | Deliverable | Exit evidence |
| --- | --- | --- |
| **F0 — Contract** | Pin + generate types/MVP validators (`docs/YUNO_F0_CONTRACT_SPEC.md`) | `yuno:contract:verify`, `generate`, `check-generated` green. **F0 complete.** |
| **F1 — Mock base** | Auth headers, errors, persistence primitives, provider idempotency | Nested `yuno_mock` typecheck/test/build; health + auth + idempotency + file lock tests. **F1 complete.** |
| **F2 — Enrollment** | Customer, session, test UI, token, fingerprint | Enroll/list/get/unenroll E2E; PAN never in `/v1` or store. **F2 complete.** |
| **F3 — Payments** | Create/get; sync and async states | Success/decline/processing tests. Nested `yuno_mock` lint/typecheck/test/build + runtime smoke customer→session→tokenize→enroll→create→GET. **F3 complete.** |
| **F4 — Actions** | 3DS, HMAC webhooks, retries | Challenge + duplicate/out-of-order tests. Nested `yuno_mock` lint/typecheck/test/build + signed delivery smoke. **F4 complete.** |
| **F5 — Post-pay** | Capture, cancel, refund, cancel-or-refund | Total/partial + state guards (reuse current transition knowledge). Nested `yuno_mock` lint/typecheck/test/build + post-pay smoke. **F5 complete.** |
| **F6 — Abstraction** | Platform `/v1` on root Hono, `AuthorizationVerifier`, adapter, platform MCP adapter, durable idempotency, outbound webhook delivery, real-socket E2E | E2E agent → platform MCP → platform REST → independent mock (adapter + localhost sockets); KYA routes unchanged. **F6 complete** (see `docs/PAYMENTS.md`). |
| **F7 — Swap readiness** | `YUNO_PROVIDER_ENV` + `YUNO_BASE_URL` + secret-injected credentials; offline readiness CLI; optional poll/reconcile deferred | Offline readiness implemented (`docs/YUNO_SANDBOX_READINESS.md`). Live sandbox contract suite: **LIVE-NOT-EXECUTED** (no credentials). Poll/reconcile beyond webhooks still deferred. |

**Order rule:** do not implement F6 public API or platform MCP as the first
step. Fix the Yuno contract and mock first so interchangeability is
demonstrable.

Suggested target layout (names indicative; boundaries mandatory):

```text
# Root Hono process (platform)
src/
  api/payments|payment-methods|refunds|webhooks/
  mcp/payment-tools/          # separate adapter → platform REST only
  domain/payments|payment-methods|refunds|idempotency/
  domain/authorization/       # AuthorizationVerifier port (+ policy if kept)
  providers/yuno/{generated,yuno-adapter,yuno-http-client,state-mapper,webhook-verifier}/
  config/env.ts               # YUNO_BASE_URL + credential fields

# Independent Yuno REST mock process/package
yuno_mock/   # or packages/yuno-mock — REST /v1, scenarios, enrollment UI
  # optional isolated MCP probe only; never provider entrypoint

contracts/yuno/{openapi.json,METADATA.md}
tests/{contract/yuno,mapping,integration,e2e}/
```

Provider selection is configuration only (Section 4.1):

```text
YUNO_BASE_URL=http://127.0.0.1:8080     # independent mock process
YUNO_BASE_URL=https://api.y.uno/...     # future production
```

No `if mock` inside `PaymentService`.

---

## 16. Tests and acceptance criteria

### Test strategy

1. **Yuno contract tests** — same suite validates `YunoMockServer` on every
   change; later optionally real sandbox. Paths, methods, required headers,
   request/response schemas, HTTP codes, idempotency. **Snapshot-gated**
   until OpenAPI is committed.
2. **Mapping tests** — platform request → exact Yuno request; Yuno response →
   public status; Yuno webhook → domain transition; `value_minor` ↔ decimal;
   Yuno errors → public errors.
3. **Integration** — full enrollment; immediate purchase; auth+capture;
   cancel; total/partial refund; 3DS success/fail/expire; timeout +
   reconcile; idempotent retry; duplicate and out-of-order webhooks.
4. **Compatibility gate** — OpenAPI snapshot updates produce a reviewable
   diff and regenerate types/validators; never silent overwrite.

### Reuse from current exploratory tests (rewrite onto new surfaces)

From `test-customers.js`:

- Create with `merchant_customer_id`; retrieve by id; retrieve by external
  id; patch update; missing id errors; duplicate `merchant_customer_id`.

From `test-payments.js`:

- Authorize → capture → full refund.
- Direct create (`PURCHASE` / captured success).
- Double-capture and double-refund rejected.
- Retrieve with/without transaction history.
- Retrieve by `merchant_order_id` returns array.
- Idempotent replay returns same payment id (extend to full Yuno semantics).
- Cancel authorized; reject cancel on succeeded.
- `cancel-or-refund` cancel branch vs refund branch; required `reason` on
  payment-level cancel-or-refund.
- Partial refund → `PARTIALLY_REFUNDED` with cumulative amount; over-refund
  rejected.
- Missing payment/transaction/session errors.

**Do not** port merchant/catalog tests into the Yuno provider suite.

### Acceptance criteria (traceable to brief §17)

- [x] Platform public API and Yuno contract are explicitly separated.
- [x] `YunoMockServer` implements the official snapshot, not a hand-wavy
      approximation.
- [x] Official OpenAPI snapshot pinned at `contracts/yuno/openapi.json` with
      provenance in `METADATA.md` (`npm run yuno:contract:verify`).
- [x] Yuno types/validators generate from `contracts/yuno/openapi.json`
      (`npm run yuno:contract:generate` / `yuno:contract:check-generated`;
      `tests/yuno-contract-generated.test.ts`).
- [x] Mock routes/headers/bodies/status codes pass contract tests.
- [x] The HTTP client used against the mock is the same client used for real
      Yuno.
- [x] Switching mock → real does not change MCP, public API, or domain.
- [x] Main API never receives or stores PAN/CVV.
- [x] Agent never sees `vaulted_token`, provider keys, or raw provider IDs.
- [x] `value_minor` converts by currency exponent; not hard-coded `/100`.
- [x] `PENDING` and `AUTHORIZED` never count as payment success.
- [x] Success, decline, 3DS, timeout, capture, cancel, and refund covered
      (platform E2E + review regressions against mock scenarios
      `requires_3ds` / `provider_timeout`; live sandbox remains
      LIVE-NOT-EXECUTED pending credentials).
- [x] Retry with same idempotency key does not duplicate payment
      (durable failed/success replay; unknown-outcome retains one processing
      payment + stable provider key).
- [x] Invalid HMAC webhooks do not mutate state.
- [x] Duplicates and out-of-order events neither repeat nor rewind effects
      (via `payment-event-guard` + webhook processor; unmatched provider ids
      are not added to the applied-event dedup set).
- [x] Platform outbound `/v1/webhook-endpoints` deliver normalized events
      (bounded async HTTP POST with delivery status/attempts; no provider
      fields/secrets).
- [x] Scenario endpoints exist only in test/dev (mock process).
- [x] Local MVP runs without real Yuno credentials.
- [x] Current direct Yuno MCP simulator is only an exploratory fixture; any
      retained probe is optional, isolated from runtime, and is not the
      provider entrypoint.
- [x] Invented merchant/catalog data remains outside the Yuno provider mock.
- [x] `YUNO_MOCK_URL` is replaced by provider-neutral `YUNO_BASE_URL`; mock
      uses safe test credentials; real credentials are secret-injected only.
- [x] `MANDATE_MAX_AMOUNT` is not used as payment authorization;
      `PaymentService` uses `AuthorizationVerifier(authorization_id)`.
- [x] Auth roles match Section 3; demo address login cannot authorize real
      payments.
- [x] Yuno REST mock runs as an independent process/package; platform MCP is
      a separate adapter over platform REST.

### Open decisions before coding (brief §18)

1. Exact DB driver and payment schema migration tooling — **F6 choice:** atomic
   JSON file + in-memory test store (`src/persistence/payments/`), separate from
   KYA `store.json`.
2. Initial currencies and ISO exponent source — **F6 choice:** SIX Group
   ISO-4217 minor units (`src/domain/payments/currency.ts`).
3. Enrollment and `processing` payment expiry policy — enrollment 1h default;
   processing left until webhook/GET reconcile (F7 may add poll).
4. Concrete admin / internal-service auth mechanism — **F6 choice:** explicit
   API keys (`PAYMENT_ADMIN_API_KEY`, `PAYMENT_INTERNAL_API_KEY`); production
   fail-closed.
5. How `merchant_id` maps to Yuno account configuration — opaque platform field;
   provider uses configured `YUNO_ACCOUNT_ID`.
6. Mock HMAC key lifetime/rotation — fixture secret in `.env.example`.
7. Encryption strategy for `vaulted_token` — **F6:** AES-256-GCM via
   `PAYMENT_SECRETS_KEY`.
8. When to poll for reconciliation in addition to webhooks — **deferred**
   (F7 readiness ships config/URL swap gates only; poll not implemented).
9. Whether to keep `MANDATE_MAX_AMOUNT` under a separate authorization-policy
   module or remove it if unused — kept as unrelated policy placeholder; not
   read by `PaymentService`.

---

## 17. References

### Source brief

- `/Users/ramiro/Documents/Codex/2026-08-29/https-www-mastercard-com-co-es/outputs/YUNO_MOCK.md`

### Repository evidence inspected

- `AGENTS.md`
- `src/server/app.ts`, `src/server/index.ts`
- `src/config/env.ts`, `.env.example`
- `src/auth/session.ts`, `src/credentials/jws.ts` (session + credential gates)
- `yuno_mock/src/server.js`, `store.js`, `payment-methods.js`, `mcp-result.js`
- `yuno_mock/src/tools/{customers,checkout,payments,merchants}.js`
- `yuno_mock/scripts/test-{customers,payments}.js` (+ suite layout)
- `yuno_mock/docs/{architecture,scope-and-fidelity,tools-reference}.md`
- `contracts/yuno/openapi.json`, `contracts/yuno/METADATA.md`
- `docs/YUNO_F0_CONTRACT_SPEC.md`

### Official Yuno links (from brief; for implementers after F0)

- [Yuno Docs MCP](https://docs.y.uno/mcp) — documentation search only; not payment processing
- [Authentication](https://docs.y.uno/reference/getting-started/authentication)
- [Create a customer](https://docs.y.uno/reference/customers/create-customer)
- [Enroll payment methods](https://docs.y.uno/docs/payment-features/enrollment/enroll-payment-methods)
- [Enroll Payment Method — Checkout](https://docs.y.uno/reference/payment-methods-checkout/enroll-payment-method-checkout)
- [Create a payment](https://docs.y.uno/reference/payments/create-payment)
- [Stored credentials](https://docs.y.uno/docs/payment-features/stored-credentials)
- [Configure webhooks](https://docs.y.uno/docs/webhooks/configure-webhooks)
- [Verify webhook signatures with HMAC](https://docs.y.uno/docs/webhooks/verify-webhook-signatures-hmac)

### Relationship to `FLOW.md`

`FLOW.md` owns identity and authentication. This migration begins only after
an authenticated, authorized request needs a payment operation. It
complements, and does not replace, the KYA ceremony MVP.

---

## 18. Next step

1. **F0 pin + generation:** done — `docs/YUNO_F0_CONTRACT_SPEC.md`;
   `npm run yuno:contract:verify|generate|check-generated`.
2. Implement `YunoMockServer` REST routes from the snapshot (F1+).
3. Only then build platform `/v1`, adapter, and safe MCP tools (F6).

Starting with platform API or MCP tools before the mock honors the pin
makes interchangeability harder to prove.

**No production mock/adapter code is authorized by the F0 pin alone.**
