# AP2 mandate drafts — phase 1

This phase is a domain library, not an HTTP/MCP integration. Its deterministic flow is:

`validated external checkout → merchant-signed ES256 Checkout JWT → checkout mandate draft → future trusted-surface user signature → future validation`

`createMerchantCheckout`, `createCheckoutMandateDraft`, `createPaymentMandateDraft`, and `verifyDraftConsistency` are exposed through `createMandateService`. The first returns the signed checkout and SHA-256 base64url JWT hash. The next two return structured, unsigned `mandate.checkout.1` and `mandate.payment.1` payloads plus signing requests for a future Credential Provider.

A draft is **not** a payment authorization, a payment, or a final AP2 mandate. No PAN, CVC/CVV, processor token, Yuno token, user PII, blockchain call, automatic purchase, or user signature is accepted or created.

The merchant JWT is ES256 only. The local signer is development/test-only and uses a P-256 private JWK supplied through `MERCHANT_SIGNING_PRIVATE_JWK` or an ephemeral test/development key. Production must inject a `MerchantSigner` that obtains the key from the deployment's approved secret provider/HSM. `UserMandateSigner` / `CredentialProviderAdapter` are interfaces only; there is no mock user authorization in production.

## Next phase inputs still required

A real Credential Provider requires a decided provider protocol and audience, user-credential and trust model, presentation/signature format, key-discovery and rotation metadata, revocation policy, trusted-surface UX/consent record, and an authorization-to-payment handoff contract. Those decisions are intentionally not inferred by this phase.
