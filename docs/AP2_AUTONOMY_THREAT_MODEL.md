# AP2 autonomous mandates: architecture and threat model

```text
User → Trusted Surface → signed open mandate (canonical payload hash frozen)
                         ↓
Checkout JWT → registry-loaded authorized open mandates → KYA AgentTrustVerifier
                         ↓
                  deterministic policy engine (per-mandate budgets)
                         ↓
                  delegated Agent Key (KMS/HSM) signs closed mandates
                         ↓
                    verify → durable hash-only outbox → anchor client (fake by default)
```

An open mandate is explicit user consent. It contains an allowlist and hard limits, plus the delegated agent public JWK in `cnf`. The agent, never the user, may sign a closed mandate. KYA is used for enrollment status, credential attestation expiry/revocation, and public-key binding; tenant authorization and risk assessment are separate injected policies and deny by default.

## Controls implemented in-repo

- Canonical open-mandate payload hash frozen at create; activation rejects mutated constraints (e.g. limit 100 → 999999).
- Autonomy loads active mandates only from a registry/store boundary with activation proof bound to payload hash, user, agent, tenant, and audience.
- Policy reservations enforce budget/operations/frequency independently for each open checkout and open payment mandate.
- Local merchant signer fail-closed outside development/test; ES256/`typ`/`kid`/`iss`/`aud`/`iat`/`exp` checks are strict.
- Request store persists prompt hash (+ optional opaque encrypted ref) only — never plaintext prompts.
- `MandateAnchor` enforces distinct admin, pauser, and anchorer roles. Hash-only outbox worker is injectable; fake client performs no RPC.

## Explicitly not production-ready yet

Private agent signing material is intentionally absent from this repository: a deployment must provide a KMS/HSM `AgentMandateSigner`. Live chain writes, payment/Yuno invocation, and multi-instance durable open-mandate storage are out of scope for the current worker boundary. Before enabling autonomy in production, require database row locking for the registry/challenges, mTLS/workload identity for internal APIs, a reviewed multisig-administered anchor deployment, and per-tenant feature flags default-off.
