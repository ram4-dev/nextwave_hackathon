/**
 * Documented pin gaps for F2 enrollment + F3 payments + F4 webhooks/3DS + F5 post-pay
 * (evidence from contracts/yuno + validate.ts). Do not invent fields to paper over these.
 *
 * --- F2 ---
 *
 * 1. Success responses for create-customer, enroll, and get-payment-method use
 *    overlapping `oneOf` object branches without a discriminator. Facade
 *    `validateResponse` tolerates ≥1 matching branch (see src/providers/yuno/validate.ts).
 *
 * 2. Checkout enroll request (`enroll-payment-method-checkout`) has no PAN, CVV,
 *    card number, or vaulted_token properties. Card material enters the mock only
 *    via the test/dev enrollment UI (`/test/enrollment*`), which stores a pending
 *    vault on the customer session before POST enroll.
 *
 * 3. Enrollment MVP operations document HTTP 201/200/400/401/403 only — no 404.
 *    Missing customer/session/method resources are returned as 400 INVALID_REQUEST.
 *
 * 4. `verify` on enroll is optional, but when present the pin requires
 *    `vault_on_success`. Currency is optional in schema; mock accepts ISO-4217
 *    strings when provided without inventing extra verify fields.
 *
 * 5. List enrolled methods includes `vaulted_token` in the provider response shape
 *    (pin). Platform public API (F6) must not expose it to agents; this mock is
 *    the Yuno-side contract and therefore returns it when listed.
 *
 * 6. Available-methods catalog for CO/MX/BR is a deterministic mock fixture for
 *    Checkout enrollment availability — not a Yuno merchants/catalog API.
 *
 * --- F3 ---
 *
 * 7. POST /payments JSON Schema `required` includes `checkout`, while the property
 *    description says checkout is not required for DIRECT/REDIRECT. Request
 *    validation follows the pinned `required` array (clients must send `checkout`).
 *
 * 8. Create-payment request `amount.value` is `number`/`float`; create and retrieve
 *    response example schemas type amount fields as `integer`. F3 stores and returns
 *    the provider decimal without platform minor-unit conversion. `validateResponse`
 *    applies a narrow amount integer→number relaxation only for `create-payment` and
 *    `retrieve-payment-by-id-v2` when the strict schema fails; other constraints still
 *    apply.
 *
 * 9. retrieve-payment-by-id-v2 documents 200/400/401/403 only — no 404. Missing
 *    payment_id is returned as 400 INVALID_REQUEST (same pattern as F2 enrollment).
 *
 * 10. create-payment documents 201/400/401/403 only — no 500. provider_timeout
 *     returns HTTP 500 with a Yuno-style error envelope so clients model uncertain
 *     outcome + same-key retry without duplicates; that status is outside the pin
 *     response map and is not passed through validateResponse.
 *
 * 11. Generated MVP `retrieve-payment-by-id-v2` has `requestSchema: null` (no query
 *     parameters on the operation facade). F3 returns one consistent retrieve shape
 *     `{ payment: { …, transactions: [...] } }` and ignores arbitrary query strings —
 *     do not invent query-driven response variants in the mock.
 *
 * 12. Scenario selection is only via `/test/scenarios/payments` (dev/test). There is
 *     no public payment request field for scenarios (migration §13).
 *
 * --- F4 ---
 *
 * 13. Webhook create/update accept `hmac_client_secret` / `api_key` / `secret` /
 *     `oauth2_client_secret` per pin, but responses only ever return masked `***`
 *     or null. The mock additionally encrypts those values at rest (AES-256-GCM);
 *     that persistence detail is outside the OpenAPI surface.
 *
 * 14. Outbound webhook event JSON shape (`id`, `type`, `type_event`, `data.payment`)
 *     is a mock/fixture contract for HMAC + retry tests — not a separate pinned
 *     OpenAPI operation in the MVP set.
 *
 * 15. 3DS inspect/complete and `/test/work/process` are dev/test controls outside
 *     `/v1` (404 in production). They are not Yuno public API operations.
 *
 * 16. Root platform `POST /internal/webhooks/yuno` receiver is F6 — not implemented
 *     in this mock process. Shared verifier lives at
 *     `src/providers/yuno/webhook-verifier.ts` for future F6 reuse.
 *
 * --- F5 ---
 *
 * 17. Capture / cancel / cancel-or-refund / refund success responses reuse
 *     integer-typed amount example fields while request amounts are float. Same
 *     narrow integer→number relaxation as F3 is applied only for:
 *     `capture-authorization`, `cancel-payment`, `refund-payment`,
 *     `cancel-or-refund-a-payment`, `cancel-or-refund-payment-with-transaction`.
 *
 * 18. Refund path parameter is `{id}` (not `{payment_id}`) in the pin —
 *     `POST /payments/{id}/transactions/{transaction_id}/refund`. Sibling capture
 *     /cancel routes use `{payment_id}`.
 *
 * 19. Refund success response is payment-shaped (create-like) with `transactions`
 *     as a single REFUND object; capture/cancel/cancel-or-refund return a
 *     transaction object with nested `payment` summary. cancel-or-refund success
 *     status is 201; capture/cancel/refund success status is 200.
 *
 * 20. Partial capture pin examples use payment `SUCCEEDED` / `PARTIALLY_CAPTURED`
 *     (not AUTHORIZED). Full capture uses `SUCCEEDED` / `CAPTURED`. Partial refund
 *     uses `SUCCEEDED` / `PARTIALLY_REFUNDED`; full refund uses `REFUNDED`.
 */
export const F2_PIN_GAPS = [
  'overlapping-oneOf-success-responses',
  'enroll-request-has-no-card-fields',
  'no-404-on-enrollment-ops',
  'verify.vault_on_success-required-when-verify-present',
  'list-includes-vaulted-token-provider-shape',
  'country-availability-is-fixture-not-merchant-api',
] as const;

export const F3_PIN_GAPS = [
  'create-payment-checkout-required-despite-DIRECT-description',
  'response-amount-integer-vs-request-float-narrow-tolerance',
  'no-404-on-retrieve-payment',
  'provider-timeout-500-outside-documented-responses',
  'retrieve-mvp-op-has-no-query-schema-single-shape',
  'scenarios-only-via-test-control',
] as const;

export const F4_PIN_GAPS = [
  'webhook-secrets-masked-in-response-encrypted-at-rest',
  'outbound-event-payload-is-mock-fixture-not-mvp-op',
  '3ds-and-work-controls-are-test-only',
  'platform-internal-webhook-receiver-is-f6-not-mock',
] as const;

export const F5_PIN_GAPS = [
  'post-pay-response-amount-integer-vs-request-float-narrow-tolerance',
  'refund-path-param-is-id-not-payment_id',
  'refund-response-is-payment-shaped-actions-are-transaction-shaped',
  'partial-capture-pin-uses-SUCCEEDED-PARTIALLY_CAPTURED',
] as const;

export const PIN_GAPS = [
  ...F2_PIN_GAPS,
  ...F3_PIN_GAPS,
  ...F4_PIN_GAPS,
  ...F5_PIN_GAPS,
] as const;
