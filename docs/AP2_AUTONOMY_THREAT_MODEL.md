# AP2 autonomous mandates: architecture and threat model

```text
User → Trusted Surface → signed open mandate (canonical payload hash frozen)
                         ↓
Checkout JWT → registry-loaded authorized open mandates → KYA AgentTrustVerifier
                         ↓
                  deterministic policy engine (per-mandate budgets; shared registry ledger)
                         ↓
                  delegated Agent Key (KMS/HSM) signs closed mandates
                         ↓
                    independent JWS verify → hash-only outbox (lease) → fake/real anchor client
```

An open mandate is explicit user consent. It contains an allowlist and hard limits, plus the delegated agent public JWK in `cnf`. The agent, never the user, may sign a closed mandate. KYA is used for enrollment status, credential attestation expiry/revocation, and public-key binding; tenant authorization and risk assessment are separate injected policies and deny by default.

## Controls implemented in-repo

- Canonical open-mandate payload hash frozen at create; activation rejects mutated constraints.
- Autonomy loads active mandates only from a registry/store boundary with activation proof bound to payload hash, user, agent, tenant, and audience.
- Agent key reference must match signer `keyId`; signer JWK thumbprint must match both open-mandate `cnf` JWKs; closed JWS is verified independently against the expected payload.
- Policy reservations enforce budget/operations/frequency independently for each open checkout and open payment mandate; in-process default ledger is shared per registry (not recreated per call).
- Local merchant signer / CLI fail-closed outside explicit development/test `NODE_ENV`.
- Request store persists prompt hash (+ optional opaque encrypted ref) only.
- `MandateAnchor` requires non-zero evidence hashes and distinct admin/pauser/anchorer roles.
- Hash-only outbox uses `processing` + lease; `maxAttempts` and `txHash` are enforced. Fake client performs no RPC.

## Atomicity: local vs durable

- **Local (implemented):** in-memory registry activation runs proof persistence inside one critical section so a failed consume leaves the mandate awaiting signature and the challenge retryable.
- **Durable (pending):** production must place mandate activation and challenge consumption in one database transaction. Docs must not claim durable outbox/registry atomicity that is not implemented.

## Explicitly not production-ready yet

Private agent signing material is intentionally absent from this repository: a deployment must provide a KMS/HSM `AgentMandateSigner`. Live chain writes, payment/Yuno invocation, and multi-instance durable open-mandate storage remain out of scope for the current worker boundary.
