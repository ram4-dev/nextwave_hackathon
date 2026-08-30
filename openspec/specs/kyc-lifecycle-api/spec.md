# KYC Lifecycle API Specification

## Purpose

Define Didit session creation, navigation return, authoritative decision events, and privacy-safe status.

## Requirements

### Requirement: KYC-001 Session creation

`POST /v1/kyc/sessions` MUST require a human session authorized for the enrollment. The API SHALL call `POST https://verification.didit.me/v3/session/` with the server-held `x-api-key`, configured workflow, opaque local correlation, and fixed API callback; it MUST NOT expose that key. It MUST treat the hosted URL and session token as sensitive and MUST NOT persist KYC documents or biometric data. Repeated requests for an active session SHOULD return that session rather than duplicate it.

#### Scenario: Authorized session creation

- GIVEN a claimed enrollment without an active terminal KYC result
- WHEN its Principal starts KYC
- THEN the API returns the hosted verification URL and normalized pending state
- AND correlates the provider session to the enrollment

#### Scenario: Provider or configuration failure

- GIVEN missing provider configuration or a failed Didit response
- WHEN session creation is attempted
- THEN the API returns a sanitized dependency error and creates no approved state

### Requirement: KYC-002 Navigation-only callback

`GET /v1/kyc/callback` SHALL accept Didit's `verificationSessionId`, require correlation to a known local session, ignore query `status` as decision evidence, and respond `303` only to the exact configured allowlisted frontend return URL. It MUST NOT accept a caller-supplied redirect.

#### Scenario: Known session returns to frontend

- GIVEN Didit redirects with a known session identifier
- WHEN the callback is received with any status text
- THEN the API redirects to the configured frontend result route
- AND the local KYC decision remains unchanged

#### Scenario: Unknown session or redirect injection

- GIVEN an unknown session identifier or attacker-supplied return target
- WHEN the callback is requested
- THEN the API fails safely without an open redirect or state mutation

### Requirement: KYC-003 Authoritative signed webhook

`POST /v1/kyc/webhooks/didit` MUST preserve the received body, verify Didit's preferred `X-Signature-V2` over its canonical JSON form with a constant-time comparison, and reject `X-Timestamp` values outside 300 seconds before mutating state. The integration SHALL subscribe minimally to `status.updated`; only verified, correlated decision events MAY drive normalized KYC state. `event_id` MUST be idempotent, and `data.updated` or callback query data MUST NOT approve KYC.

#### Scenario: Valid decision event

- GIVEN a fresh, validly signed `status.updated` event for a known session
- WHEN the webhook is processed for the first time
- THEN the API applies its normalized state atomically and acknowledges it

#### Scenario: Invalid, stale, duplicate, or unrelated event

- GIVEN a bad signature, stale timestamp, duplicate `event_id`, or non-authoritative event
- WHEN it reaches the webhook
- THEN no new decision is applied
- AND duplicates are acknowledged idempotently only after prior valid processing

### Requirement: KYC-004 Normalized status

`GET /v1/kyc/sessions/:sessionId` MUST require the owning human session and return only normalized pending, approved, declined, review, or expired state plus safe timestamps. It MUST NOT expose provider tokens, raw decisions, PII, or biometrics.

#### Scenario: Cross-Principal status lookup

- GIVEN a human session not owning the correlated enrollment
- WHEN it requests the KYC status
- THEN the API returns a permission error without protected data

## Source Authority

- Product/privacy rules: `FLOW.md`; provenance: `docs/SOURCES.md`.
- Didit v3 creation/callback: <https://docs.didit.me/sessions-api/create-session>.
- Signature, event, and idempotency rules: <https://docs.didit.me/integration/webhooks>.
