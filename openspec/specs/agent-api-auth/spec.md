# Agent API Authentication Specification

## Purpose

Authenticate the enrolled agent itself and resolve a proof-bound identity for protected API handlers.

## Requirements

### Requirement: AAA-001 Challenge and access-token issuance

Public, rate-limited challenge and verification endpoints SHALL require a fresh one-time challenge signed by the enrolled P-256 key and validate nonce, audience, time, intent, active enrollment, and active KYA credential before querying current registry ownership. Success MUST issue an ES256 access JWT valid for at most 10 minutes with distinct `typ=KYA-AGENT-ACCESS+JWT`, issuer, API audience, `sub=agentUuid`, `iat`, `nbf`, `exp`, `jti`, scopes, credential binding, and `cnf.jkt`. The final current bindings MUST be rechecked and nonce consumption plus access-token record persistence MUST share one atomic lock/CAS; persistence failure MUST leave the challenge retryable. It MUST NOT issue a refresh token or reuse the KYA identity credential's `typ=KYA-CREDENTIAL+JWT`, audience, verifier, or key-use policy.

#### Scenario: Current agent proves possession

- GIVEN a fresh challenge and active enrolled key
- WHEN the agent submits a valid P-256 signature once
- THEN it receives a DPoP-bound access JWT for that agent and approved scopes

#### Scenario: Invalid or replayed challenge

- GIVEN a stale, consumed, malformed, or incorrectly bound challenge signature
- WHEN token issuance is requested
- THEN the API returns an authentication error and no token

### Requirement: AAA-002 Mandatory DPoP middleware

Every protected `/v1/agent/*` business route MUST run `requireAgentAuth` and accept only `Authorization: DPoP <access-token>` plus a DPoP proof. The middleware SHALL validate the access JWT signature, allowed algorithm, `typ`, issuer, audience, `exp`, `nbf`, `sub`, `jti`, scopes, credential binding, and `cnf.jkt` against the persisted access-token record; it SHALL validate proof signature, public JWK RFC 7638 thumbprint, `typ=dpop+jwt`, `htm`, canonical public-origin `htu`, bounded `iat`, unique `jti`, and `ath`. Replay consumption MUST use `consumeDpopReplayAtomic`. Dependency/store failures MUST return `503`. Trusted proxy behavior MUST be explicit and fail closed. When registry IDs are present, middleware MUST re-query live `ownerOf` and deny on mismatch (`403`).

#### Scenario: Valid protected request

- GIVEN a valid access token and fresh matching proof for the exact method and URL
- WHEN the agent calls an allowed protected route
- THEN the middleware authenticates it and consumes the proof `jti`

#### Scenario: Copied or misbound token

- GIVEN a Bearer token, missing proof, wrong key, `ath`, method, URL, or replayed `jti`
- WHEN the protected route is called
- THEN the middleware returns `401` without invoking the handler

#### Scenario: Replay store unavailable

- GIVEN otherwise valid credentials
- WHEN the durable replay store is unavailable
- THEN the middleware returns `503` with sanitized UNAVAILABLE
### Requirement: AAA-003 Resolved agent context and authorization

After cryptographic validation, middleware MUST re-check enrollment, credential revocation/status, and registry binding, then expose typed `AuthenticatedAgentContext` containing `agentUuid`, thumbprint, `credentialJti`, internal `principalId`, registry and agent ID, scopes, and token expiry. A route `agentUuid` parameter MUST equal context `agentUuid`; insufficient scopes or cross-agent access SHALL return `403`.

#### Scenario: Revoked state during token lifetime

- GIVEN an otherwise valid unexpired token whose credential or enrollment was revoked
- WHEN a protected request is made
- THEN authentication fails closed without stale authorization

#### Scenario: Route subject mismatch

- GIVEN valid context for agent A
- WHEN it targets agent B or lacks the required scope
- THEN the API returns `403` without agent B data

### Requirement: AAA-004 Agent self endpoint and renewal

`GET /v1/agent/me` MUST be the first protected route and return a safe projection of the authenticated context. Expiry SHALL require a fresh signed challenge; no refresh path MAY exist.

#### Scenario: Authenticated self lookup

- GIVEN valid context and proof
- WHEN `/v1/agent/me` is requested
- THEN it returns the caller's public agent identity and token expiry without internal `principalId`

## Source Authority

- Product/key-possession invariant: `FLOW.md`; provenance: `docs/SOURCES.md`.
- DPoP validation: <https://www.rfc-editor.org/rfc/rfc9449>.
- JWK thumbprints: <https://www.rfc-editor.org/rfc/rfc7638>.
