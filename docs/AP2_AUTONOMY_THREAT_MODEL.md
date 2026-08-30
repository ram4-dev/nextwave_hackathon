# AP2 autonomous mandates: architecture and threat model

```text
User → Trusted Surface → signed open mandate
                         ↓
Checkout JWT → KYA AgentTrustVerifier → deterministic policy engine
                         ↓
                  delegated Agent Key (KMS/HSM) signs closed mandates
                         ↓
                    verify → durable outbox → blockchain anchor
```

An open mandate is explicit user consent. It contains an allowlist and hard limits, plus the delegated agent public JWK in `cnf`. The agent, never the user, may sign a closed mandate. KYA is used for enrollment status, credential attestation expiry/revocation, and public-key binding; tenant authorization and risk assessment are separate injected policies and deny by default.

Threat controls: strict checkout hash binding, JWS verification, exact agent-key thumbprint comparison, expired/revoked mandate rejection, policy checks for merchant/payee/product/supplier/quantity/currency/amount/instrument, and a serialized budget/frequency/idempotency reservation. `createConfiguredAgentMandateSigner` supports a separately injected ES256 mandate key; a deployment should replace it with the approved KMS/HSM operation rather than expose a raw key to the application.

The repository includes a BSC Testnet evidence-only anchor contract and worker module, plus a Trusted Surface EIP-712 verifier. They are not automatically connected to a durable outbox, and no payment/Yuno invocation occurs. The `/v1/mandates/*` routes are explicitly demo-only and use local storage/signers plus permissive demo tenant/risk adapters. Before enabling autonomy in production, use durable mandate/outbox storage and database row locking, require mTLS/workload identity, replace raw-key signing with a KMS/HSM adapter, deploy/manage the anchor through a multisig, and set per-tenant feature flags default-off.
