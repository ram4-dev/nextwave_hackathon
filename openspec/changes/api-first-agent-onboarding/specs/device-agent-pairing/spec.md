# Device Agent Pairing — Delta (api-first-agent-onboarding)

## ADDED Requirements

### Requirement: DAP-H1 Strict public EC P-256 JWK

Enrollment and import MUST reject private JWK members (`d`, `p`, `q`, `dp`, `dq`, `qi`, `oth`, `k`) and incompatible fields. Only public EC/P-256 with canonical 32-byte base64url `x`/`y` forming a real curve point MAY be persisted. Optional metadata MUST be compatible with a public ES256 verification key: `alg` absent/`ES256`, `use` absent/`sig`, `key_ops` absent/exactly `['verify']`, `ext` absent/true, and `kid` absent/non-empty string. Server and browser validation MUST agree. `sanitizePublicJwk` MUST never retain private material.

### Requirement: DAP-H2 One-time credential poll

`POST /v1/device-enrollments/token` MUST deliver the identity credential at most once via durable CAS/lock semantics without nested-lock deadlock or re-signing after races. Subsequent successful polls return `complete` without credential.

### Requirement: DAP-H3 verification_uri_complete safety

`verification_uri_complete` MAY include the human `user_code` and MUST NEVER include `device_code` or secrets. Responses and logs MUST omit plaintext codes after issuance, JWTs, private keys, and service-role values.

### Requirement: DAP-H4 CAS persistence authority

Live Supabase persistence MUST use versioned aggregate `kya_state` with `kya_compare_and_swap_state(expected_version, state)`. Sequential multi-table DELETE/INSERT replaceAll is forbidden. Callers MUST NOT auto-retry side-effecting callbacks after CAS conflict.

### Requirement: DAP-H5 Claim-only human pairing authority

Only `POST /v1/device-enrollments/claim` MAY bind an enrollment to a Principal,
and it MUST consume the unexpired hashed `user_code` with the exact confirmed
thumbprint. A legacy `POST /v1/enrollments/:agentUuid/attach` runtime route MUST
NOT exist.
