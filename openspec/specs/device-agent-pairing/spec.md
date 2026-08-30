# Device Agent Pairing Specification

## Purpose

Define key-safe pairing between a local agent and a CDP-authenticated human.

## Requirements

### Requirement: DAP-001 Enrollment initiation

`POST /v1/device-enrollments` MUST be public and rate-limited. The agent SHALL
generate and retain a P-256 private key; the API MUST accept only its public
JWK, reject private members, off-curve coordinates, or ES256-incompatible
`alg`/`use`/`key_ops`/`ext`/`kid` metadata identically in server and browser, and derive the RFC
7638 thumbprint. Success SHALL issue an agent-held `device_code`, human-facing
`user_code` and verification URI/QR deep link, a 10-minute expiry, and a
five-second minimum polling interval.

#### Scenario: Valid local key enrollment

- GIVEN an agent-generated P-256 public JWK
- WHEN the agent initiates enrollment
- THEN the API returns distinct device and user codes bound to its thumbprint
- AND no private key material crosses the API boundary

#### Scenario: Private or malformed key

- GIVEN a JWK with private fields, wrong curve, or invalid parameters
- WHEN enrollment is requested
- THEN the API rejects it without persisting key or code material

### Requirement: DAP-002 Code secrecy and human claim

The API MUST store only hashes of both codes, MUST NOT put `device_code` or
credentials in URLs or logs, and MUST disclose only `user_code` through the
human verification URI. `POST /v1/device-enrollments/claim` SHALL require a
valid human session and atomically bind one unexpired, unclaimed code to that
Principal after confirming the exact displayed thumbprint.
No `agentUuid`-only attach endpoint MAY bind a Principal; claim is the sole HTTP
pairing authority.

#### Scenario: Human claims current code

- GIVEN an unclaimed user code and valid human session
- WHEN the human confirms the displayed thumbprint
- THEN the enrollment becomes bound to that Principal exactly once

#### Scenario: Expired, guessed, or reused code

- GIVEN an expired, invalid, rate-limited, or consumed user code
- WHEN a claim is attempted
- THEN the API rejects it without revealing whether another Principal claimed it

### Requirement: DAP-003 Polling and one-time delivery

`POST /v1/device-enrollments/token` MUST accept `device_code` only in the
request body, enforce the five-second interval, and return normalized pending,
slow_down, denied, expired, or complete states. On completion it SHALL deliver
the KYA identity credential at most once; that credential MUST NOT be treated
as an agent API access token.

#### Scenario: Ceremony still pending

- GIVEN a valid device code whose ceremony is incomplete
- WHEN the agent polls at the allowed interval
- THEN the API returns pending without credential data

#### Scenario: Credential delivered once

- GIVEN a completed, current enrollment and credential
- WHEN the agent polls with its valid device code
- THEN the API returns that credential once and consumes delivery
- AND subsequent polls cannot retrieve it again

### Requirement: DAP-004 Fingerprint approval

The human MUST explicitly approve the displayed public-key thumbprint before
registration. Approval SHALL bind the exact thumbprint and MUST be invalidated
by key rotation or re-pairing.

## Source Authority

- Product/key custody: `FLOW.md`; provenance: `docs/SOURCES.md`.
- Device-flow semantics: <https://www.rfc-editor.org/rfc/rfc8628>.
- Thumbprint derivation: <https://www.rfc-editor.org/rfc/rfc7638>.
