# AP2 mandate drafts — local domain library

This phase is a domain library, not an HTTP/MCP integration. Its deterministic flow is:

`validated external checkout → merchant-signed ES256 Checkout JWT → checkout/payment mandate drafts → Trusted Surface user signature → policy reservation → agent-signed closed mandate hashes → hash-only anchor outbox`

`createMerchantCheckout`, `createCheckoutMandateDraft`, `createPaymentMandateDraft`, and `verifyDraftConsistency` are exposed through `createMandateService`. Autonomy uses registry-loaded active open mandates only (no caller-fabricated records). The hash-only outbox/`MandateAnchorWorker` accepts an injectable `MandateAnchorClient`; the repository ships a `FakeMandateAnchorClient` and does **not** perform live chain writes.

## Implemented vs pending

| Implemented | Pending / out of scope |
| --- | --- |
| Merchant ES256 Checkout JWT + draft payloads | Live Credential Provider / production Trusted Surface UI |
| Immutable open-mandate activation bound to canonical payload hash | Durable Supabase registry for open mandates in multi-instance prod |
| Per-mandate policy budget/ops/frequency reservation | Live payment execution / Yuno |
| Hash-only outbox + fake anchor worker | Real BSC/Base RPC anchoring and deployed signer |
| Distinct admin / pauser / anchorer roles on `MandateAnchor` | Production KMS/HSM agent signing |

A draft is **not** a payment authorization, a payment, or a final processor charge. No PAN, CVC/CVV, processor token, Yuno token, user PII, automatic purchase, or live chain write is accepted or created by this library.

The merchant JWT is ES256 only. The local signer is development/test-only (`nodeEnv` or `process.env.NODE_ENV` must be `development` or `test`; omitted `nodeEnv` with `NODE_ENV=production` fails closed). Production must inject a `MerchantSigner` backed by the deployment's secret provider or HSM.

See [`AP2_IMPLEMENTATION_SETUP.md`](./AP2_IMPLEMENTATION_SETUP.md) and [`AP2_AUTONOMY_THREAT_MODEL.md`](./AP2_AUTONOMY_THREAT_MODEL.md).
