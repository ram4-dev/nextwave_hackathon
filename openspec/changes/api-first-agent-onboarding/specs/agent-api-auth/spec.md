# Agent API Auth — Delta (api-first-agent-onboarding)

## ADDED Requirements

### Requirement: AAA-H1 Access token binding to persisted record

Verification MUST require `typ=KYA-AGENT-ACCESS+JWT`, `alg=ES256`, expected `kid`, and equality of `sub`, `jti`, `credential_jti`, `cnf.jkt`, `aud`/`iss`, and scopes against the active persisted access-token record. Validly signed tokens with claim/record mismatch MUST be rejected. JWT and DPoP proof size and `jti` length MUST be bounded.

#### Scenario: Record mismatch

- GIVEN a correctly signed access JWT whose persisted record was mutated
- WHEN verification runs
- THEN the verifier returns UNAUTHORIZED and no agent context is resolved

### Requirement: AAA-H2 Durable DPoP replay and dependency errors

`Repository.consumeDpopReplayAtomic` MUST be the sole consume path. Implementations MUST return `consumed` or `replay` without unique-violation races (Supabase: INSERT ON CONFLICT DO NOTHING). Store failures MUST map to HTTP 503 with sanitized bodies, not 401.

#### Scenario: Replay store down

- GIVEN a valid access token and DPoP proof
- WHEN the replay store throws UNAVAILABLE
- THEN the middleware returns 503 with code UNAVAILABLE

### Requirement: AAA-H3 Live ownerOf re-check

On every protected request, when registry/agentId are known, middleware MUST re-read current ERC-8004 `ownerOf` via an injectable authority and reject when it no longer matches the Principal. Persist-only owner comparison is insufficient.

#### Scenario: Owner transfers during token lifetime

- GIVEN a valid DPoP-bound access token
- WHEN on-chain ownership changes before a later request
- THEN the request is denied (403 OWNER_MISMATCH) without handler execution

### Requirement: AAA-H4 Public pairing rate limits

Public device enrollment, claim, token poll, and challenge endpoints MUST enforce bounded rate limits via an injectable abstraction. An in-process memory limiter MAY exist for demos/tests but MUST NOT be documented as the multi-instance authority.

### Requirement: AAA-H5 Challenge issuance transaction

Challenge verification MUST validate stored nonce existence, expiry, bindings,
and the P-256 signature before calling `ownerOf`. After ownership succeeds, the
final enrollment, credential, Principal, and key bindings MUST be rechecked;
nonce consumption and access-token record append MUST commit in one repository
lock/CAS. A failed CAS MUST leave both absent and allow the same valid challenge
to be retried.
