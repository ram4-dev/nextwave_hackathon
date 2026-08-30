# AP2 mandate drafts — local domain library

This phase is a domain library, not an HTTP/MCP integration. Its deterministic flow is:

`validated external checkout → merchant-signed ES256 Checkout JWT → checkout/payment mandate drafts → Trusted Surface user signature → policy reservation → agent-signed closed mandate hashes → hash-only anchor outbox`

`createMerchantCheckout`, `createCheckoutMandateDraft`, `createPaymentMandateDraft`, and `verifyDraftConsistency` are exposed through `createMandateService`. Autonomy uses registry-loaded active open mandates only (no caller-fabricated records). The hash-only outbox/`MandateAnchorWorker` accepts an injectable `MandateAnchorClient`; the repository ships a `FakeMandateAnchorClient` and does **not** perform live chain writes.

## Implemented vs pending

| Implemented | Pending / out of scope |
| --- | --- |
| Merchant ES256 Checkout JWT + draft payloads with canonical payload-hash binding | Live Credential Provider / production Trusted Surface UI |
| Immutable open-mandate activation bound to canonical payload hash | Durable Supabase registry for open mandates in multi-instance prod |
| Per-mandate policy budget/ops/frequency reservation (shared registry ledger in-process) | Live payment execution / Yuno |
| Hash-only outbox + fake anchor worker; all six evidence hashes are canonical and non-zero before enqueue/anchor (processing lease; no real RPC) | Real BSC/Base RPC anchoring and deployed signer |
| Permanently mutually exclusive admin / pauser / anchorer roles on `MandateAnchor`, including later grants and rotations | Production KMS/HSM agent signing |
| Local in-memory activation/revocation+challenge atomicity via one critical section | Durable DB transaction spanning mandate + challenge tables |

A draft is **not** a payment authorization, a payment, or a final processor charge. No PAN, CVC/CVV, processor token, Yuno token, user PII, automatic purchase, or live chain write is accepted or created by this library.

The merchant JWT is ES256 only. The local signer and `mandates:create` CLI are development/test-only and require an explicit `NODE_ENV=development` or `NODE_ENV=test` (no implicit default). Production must inject a `MerchantSigner` backed by the deployment's secret provider or HSM.

```bash
# Expected default-fail: the bundled fixture keeps its static timestamps, so it is
# rejected against the real wall clock instead of being silently rewritten.
NODE_ENV=test npm run mandates:create -- --input ./fixtures/validated-checkout.json

# Explicit demo success: only the bundled fixture may opt in to clock materialization.
NODE_ENV=test npm run mandates:create -- --input ./fixtures/validated-checkout.json --materialize-demo-clock
```

See [`AP2_IMPLEMENTATION_SETUP.md`](./AP2_IMPLEMENTATION_SETUP.md) and [`AP2_AUTONOMY_THREAT_MODEL.md`](./AP2_AUTONOMY_THREAT_MODEL.md).
