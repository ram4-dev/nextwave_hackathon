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

Threat controls: strict checkout hash binding, JWS verification, exact agent-key thumbprint comparison, expired/revoked mandate rejection, policy checks for merchant/payee/product/supplier/quantity/currency/amount/instrument, and a serialized budget/frequency/idempotency reservation. Private agent signing material is intentionally absent from this repository: a deployment must provide a KMS/HSM `AgentMandateSigner`.

The current repository has no selected chain, Solidity toolchain, anchor contract ABI, RPC service, KMS provider, trusted-surface user signature protocol, service-to-service authentication, or durable transactional outbox. Consequently those paths are not implemented or represented as operationally production-ready. No payment/Yuno invocation occurs. Before enabling autonomy, define those dependencies, use database row locking rather than the local ledger, require mTLS/workload identity for internal APIs, deploy the reviewed anchor contract through a multisig, and set per-tenant feature flags default-off.
