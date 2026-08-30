## Exploration: API-first agent onboarding and authenticated agent API

> Historical discovery snapshot. The legacy runtime
> `POST /v1/enrollments/:agentUuid/attach` described below was removed during
> hardening; `POST /v1/device-enrollments/claim` is the sole pairing authority.

### Current State

The repository is a TypeScript application composed of a Hono API, a Vite/React
ceremony UI, domain services, JSON/file persistence, KYC adapters, a viem
ERC-8004 registry watcher, and jose-signed credentials. `FLOW.md` is the
authoritative product scope and `docs/SOURCES.md` records protocol/provider
provenance.

The current ceremony is browser- and repository-oriented rather than an API
contract for an external frontend:

- `src/server/app.ts` exposes `GET /v1/auth/nonce` and `POST /v1/auth/verify`.
  The latter verifies SIWE and returns an ES256 `kya_session` JWT. The
  `requireSession` middleware validates that JWT and exposes only the wallet
  address (`src/auth/siwe.ts`, `src/server/app.ts`).
- `POST /v1/enrollments` accepts a public JWK and keystore provider. The agent
  service rejects private JWK material, computes an RFC 7638 thumbprint, creates
  an `agentUuid` and `deviceCode`, and stores only public key material
  (`CeremonyService.startEnrollment`, `src/crypto/local-agent-key.ts`). The
  current device code has no separate user code, expiry, hash-at-rest policy,
  or QR/deep-link contract.
- `POST /v1/enrollments/:agentUuid/attach` associates an enrollment with the
  SIWE address. `startKyc` creates a provider session with
  `callback=${PUBLIC_BASE_URL}/v1/kyc/callback`, but `src/server/app.ts` has no
  `GET /v1/kyc/callback` route. This explains the observed Didit 404. The
  existing `POST /v1/kyc/webhooks/:provider` is the authoritative state update
  path and is already signature-verified and idempotent through the adapter.
- The KYC API has no authenticated status endpoint. The frontend can create a
  session but cannot use a stable API contract to query normalized status after
  the browser returns from Didit.
- Fingerprint approval is implemented as
  `POST /v1/enrollments/:agentUuid/approve-fingerprint` under the human session.
  ERC-8004 registration preparation is
  `POST /v1/enrollments/:agentUuid/prepare-register`; demo confirmation exists,
  but there is no explicit live transaction-submission endpoint. The actual
  registration remains correctly delegated to the authenticated browser wallet;
  KYA must not become `msg.sender`.
- `POST /v1/agents/:agentUuid/challenges` creates a challenge and
  `POST /v1/agents/:agentUuid/challenges/verify` verifies the P-256 signature,
  nonce, audience, timestamp, intent hash, active credential, and on-chain
  owner. `verifyChallenge` currently returns only `ok`, `thumbprint`, and
  `credentialId`; no agent access token is issued and no agent-auth middleware
  protects routes.
- The KYA credential is a platform-signed ES256 JWT/JWS containing the
  Principal, ERC-8004 reference, status reference, and `cnf.jkt`. Credential
  metadata is persisted without the JWT string. This credential is an identity
  assertion, not a request access token, and the current routes do not enforce
  that distinction at the transport boundary.
- `src/domain/types.ts` has `Principal`, `AgentEnrollment`, `KycSessionRecord`,
  `KyaCredentialRecord`, and nonce records. It has no access-token metadata,
  DPoP replay ledger, device-code lifecycle fields, or callback state. The
  repository is JSON/file-backed for the MVP and has no shared-store semantics
  for a multi-instance replay check.

The current tests cover SIWE and challenge replay/binding, KYC webhook
normalization/idempotency, no-PII credentials, ownership fail-closed behavior,
and registry readiness (`tests/kya.test.ts`). They do not cover an external
frontend API contract, the missing Didit callback, access JWT issuance, DPoP
proof validation, or route-agent binding.

### Affected Areas

- `FLOW.md` — must state the external frontend/API boundary, callback-versus-
  webhook authority, device pairing, and the agent access-token invariant while
  preserving browser-wallet registration.
- `docs/SOURCES.md` — must add RFC 8628, RFC 9449, and any selected DPoP/JWT
  profile details; retain existing ERC-4361, Didit, RFC 7638, EIP-1193, and
  viem provenance.
- `openspec/specs/` — future main specs should separate human authentication,
  device enrollment, KYC lifecycle, ERC-8004 registration, credential issuance,
  and authenticated agent API behavior.
- `src/server/app.ts` — versioned API endpoint migration, callback navigation
  route, normalized KYC status route, transaction submission route, and two
  middleware paths (`requireSession` for humans and `requireAgentAuth` for
  agents). Error responses and CORS/redirect allowlists also belong here.
- `src/auth/siwe.ts` — preserve strict ERC-4361 validation, but expose an
  external-frontend-friendly challenge/verify contract and explicit session
  audience/expiry policy.
- `src/services/ceremony.ts` — split human-facing enrollment operations from
  device-code claiming, add authoritative callback lookup, return an access
  token from successful agent challenge verification, and enforce credential,
  enrollment, and on-chain ownership status before issuance.
- `src/domain/types.ts` and `src/persistence/repository.ts` — add lifecycle
  state for pairing, agent access tokens, and DPoP replay protection without
  persisting private keys, raw JWTs, or KYC documents.
- `src/credentials/jws.ts` and `src/credentials/signer.ts` — keep KYA
  credential JWS verification separate from access JWT verification; support
  key IDs/rotation and distinct token types/claims.
- `src/crypto/local-agent-key.ts` — provide a standards-compliant DPoP proof
  signer for the same local P-256 key, including the non-extractable-key path;
  never export or transmit private material.
- `src/kyc/didit.ts` and KYC adapter interfaces — retain signed webhook
  verification and normalize provider status; model callback as navigation only
  and never treat Didit query `status` as evidence.
- `src/registry/identity.ts` and registry event handling — preserve viem
  `simulateContract`, browser-wallet `writeContract`, `watchContractEvent`,
  and owner checks while exposing a frontend-safe intent/submission contract.
- `web/src/` — migrate the ceremony UI to call only the versioned API, consume
  SIWE messages generated by the backend, display user code/fingerprint, poll
  normalized enrollment/KYC state, and invoke BrowserWalletConnector for the
  direct Base Sepolia registration.
- `tests/kya.test.ts` and new focused auth/API tests — cover the new contracts,
  callback semantics, token separation, DPoP replay, and route binding.

### Approaches

1. **Bearer-only short-lived agent JWT** — successful P-256 challenge returns a
   signed access JWT; middleware validates `iss`, `aud`, `sub`, `iat`, `exp`,
   `jti`, enrollment/credential state, and `agentUuid` route equality.
   - Pros: small implementation, works with ordinary HTTP clients, easy to
     inspect and integrate.
   - Cons: a copied unexpired JWT is usable by an attacker, violating the
     existing `FLOW.md` invariant that copied agent credentials are insufficient
     without the local private key; revocation requires status checks and short
     TTLs.
   - Effort: Medium.

2. **DPoP-bound agent access JWT (recommended)** — issue a short-lived ES256
   access JWT with `cnf.jkt` equal to the enrolled agent key thumbprint. Every
   protected request sends `Authorization: DPoP <access-jwt>` and a unique
   `DPoP` proof signed by the local P-256 private key. Middleware verifies the
   proof's public JWK and signature, `typ=dpop+jwt`, asymmetric algorithm,
   `htm`, canonical `htu`, `iat` window, unique `jti`, and `ath` hash; it then
   compares the proof thumbprint to `cnf.jkt`, checks token/credential/enrollment
   status, and requires the route `agentUuid` to equal the token subject.
   - Pros: preserves the copied-token-is-insufficient invariant; follows RFC
     9449 sender-constrained token semantics; cleanly separates access from the
     KYA identity credential; supports one key binding across challenge and API
     calls.
   - Cons: every request needs signing and replay state; reverse proxies must
     produce a stable canonical `htu`; non-extractable P-256 signing requires a
     careful Web Crypto/JWS implementation; a compromised local agent can still
     pre-generate proofs, so proofs need a tight time window and single-use `jti`
     tracking.
   - Effort: High.

3. **Server-side agent sessions with opaque handles** — challenge verification
   creates a random opaque session ID stored server-side; each request still
   sends a detached proof or challenge signature to demonstrate key possession.
   - Pros: immediate revocation and no JWT claim confusion; server controls all
     session state.
   - Cons: does not remove the need for per-request proof-of-possession if the
     FLOW invariant is retained; distributed deployments require shared session
     storage; less interoperable for an API consumed by independent agents.
   - Effort: High.

### Recommendation

Adopt an API-first versioned contract and DPoP-bound agent access JWTs. Keep two
explicit trust domains:

```text
Human frontend
  -> SIWE challenge/verify -> human session (wallet address / Principal)
  -> device-code claim -> enrollment ownership
  -> Didit session -> GET callback navigation only
  -> signed Didit webhook -> authoritative normalized KYC state
  -> fingerprint approval -> BrowserWalletConnector register(agentURI)
  -> registry watcher -> KYA credential JWS delivery

Local agent
  -> publicJwk enrollment (private key stays local)
  -> user_code/QR pairing
  -> P-256 challenge signature
  -> DPoP-bound agent access JWT
  -> DPoP proof on each protected API call
```

The proposed endpoint groups are:

| Group | Proposed responsibility | Current migration source |
| --- | --- | --- |
| `/v1/auth/siwe/*` | Backend-generated ERC-4361 message, verification, and human session | `/v1/auth/nonce`, `/v1/auth/verify` |
| `/v1/device-enrollments` | Agent submits public JWK; returns device/user code, QR URI, expiry, and thumbprint | `/v1/enrollments` |
| `/v1/device-enrollments/claim` | SIWE-authenticated frontend consumes user code and binds Principal | `/v1/enrollments/:agentUuid/attach` |
| `/v1/enrollments/:agentUuid` | Human-owned state, fingerprint approval, rotation, revoke/rebind | Existing enrollment routes |
| `/v1/kyc/sessions` and `/:sessionId` | Create and query normalized KYC state | Create exists; status is missing |
| `/v1/kyc/callback` | Validate known session and `303` to configured allowlisted frontend result URL; ignore provider query status as authority | Missing; current Didit create call already points here |
| `/v1/kyc/webhooks/:provider` | Verify provider signature and update state idempotently | Existing route |
| `/v1/enrollments/:agentUuid/registration-intent` | Return chain, registry, exact calldata, URI, and intent hash | `/prepare-register` |
| `/v1/enrollments/:agentUuid/registration-submissions` | Idempotently record browser-wallet tx hash; watcher remains authoritative | Missing live submission contract |
| `/v1/agents/:agentUuid/challenges` | Bootstrap agent proof challenge; rate-limit and keep public | Existing route |
| `/v1/agents/:agentUuid/challenges/verify` | Verify P-256 challenge and issue DPoP-bound access JWT, never a KYA credential | Existing route returns only acknowledgement |
| Protected agent API routes | Require DPoP access token, proof, current enrollment/credential status, and route subject match | Middleware missing |
| `/v1/device-enrollments/token` | Agent polls with a one-time device code after the ceremony and receives the KYA credential once bound | Missing delivery contract |

The middleware contract should expose a typed `AuthenticatedAgentContext` with
`agentUuid`, `thumbprint`, `credentialJti`, `principalId` (internal only), and
token expiry to handlers. It MUST reject bearer presentation of a DPoP token,
unknown/unsupported algorithms, missing or mismatched `cnf.jkt`, expired or
revoked credentials, suspended/revoked enrollments, DPoP `jti` replay,
`ath` mismatch, `htm`/`htu` mismatch, and any route `agentUuid` mismatch. The
KYA credential JWS MUST remain independently verifiable through its existing
credential endpoint and JWKS; possessing it does not authorize API calls.

For pairing, the agent MUST generate and retain the P-256 private key. The API
MUST accept only a sanitized `publicJwk` and MUST derive the thumbprint using
RFC 7638. The frontend asks for `user_code` or opens a QR/deep link; it MUST
never receive `deviceCode`, private JWK fields, or the KYA credential in a URL.
Device polling should use a body/header transport, single-use delivery, expiry,
rate limits, and hash-at-rest for codes. The precise poll response and whether
the agent stores the returned credential encrypted at rest remain decisions for
the proposal.

For Didit, the callback and webhook must be separate: the callback is a browser
navigation endpoint that returns `303` to a configured allowlisted frontend;
`verificationSessionId` is checked against a known local session and the query
`status` is informational only. The signed webhook remains the only authority
for `verified`, `rejected`, `needs_review`, or `expired`. Didit webhook handling
must continue to read the raw body, enforce the timestamp window, prefer
`X-Signature-V2`, and be idempotent.

### Risks

- **DPoP canonical URL risk:** `htu` is sensitive to scheme, host, port, path,
  and proxy rewriting. The design must define trusted proxy headers and a
  canonical external API origin; otherwise valid agents fail or a proxy can
  create verification ambiguity.
- **Replay-state availability:** DPoP proof single-use checks and any refresh
  token rotation need shared durable storage in a multi-instance deployment.
  The current JSON/file repository is suitable only for the local MVP and must
  be explicitly bounded or upgraded before horizontal scaling.
- **Non-extractable key compatibility:** the existing challenge signer supports
  a custom raw-signature fallback for a non-extractable key. RFC 9449 requires a
  signed compact JWT with a public JWK header, so DPoP signing needs a dedicated
  Web Crypto-compatible implementation and tests.
- **Token confusion:** treating the KYA credential as an access token would let
  an assertion escape its intended audience. Distinct token types, audiences,
  verification functions, and middleware are required.
- **Open redirects and callback trust:** accepting a callback URL or trusting
  Didit query `status` creates phishing or false-approval paths. Frontend return
  origins must be configured and allowlisted, and status must come from the
  signed webhook or an authenticated provider decision lookup.
- **SIWE origin drift:** an external frontend changes `SIWE_DOMAIN`/`SIWE_URI`
  assumptions and CORS. The API needs an explicit allowlist and must preserve
  ERC-4361 domain, URI, chain, nonce, expiry, and address checks.
- **Device-code leakage:** raw user/device codes in logs, URLs, enrollment
  details, or analytics can let another party claim an agent. Use short-lived,
  rate-limited, hashed codes and avoid credential delivery through redirect
  query parameters.
- **On-chain race and ownership changes:** transaction submission is not
  registration. The watcher and `ownerOf` check must remain authoritative before
  issuing or renewing a credential, and transfer events must suspend the binding.
- **Credential delivery window:** a device-code poll can race with rotation,
  revocation, or transfer. Issuance must atomically bind the credential to the
  current thumbprint and enrollment status, and the old credential must be
  revoked on rotation.
- **Provider failure modes:** Didit callback delivery, webhook retry, provider
  status polling, and API reachability are independent layers. The spec must
  define timeout, retry, idempotency, and user-visible pending behavior.

### Ready for Proposal

Yes, after the product owner reviews the DPoP recommendation and resolves the
following decisions in the proposal:

1. Whether DPoP is mandatory for all agent APIs (recommended) or whether a
   temporary bearer compatibility mode is required.
2. Access-token lifetime and renewal policy. A first version should use a
   5–15 minute DPoP access JWT and require a fresh challenge rather than add a
   refresh-token protocol prematurely.
3. Exact external frontend origin(s), callback return path, and trusted proxy
   deployment settings for SIWE/CORS/`htu` canonicalization.
4. Pairing UX and lifecycle: user-code format, QR/deep-link format, expiry,
   polling interval, single-use behavior, and whether the agent polls for a
   credential or receives an explicit claim response.
5. The list of first agent API routes protected by middleware and whether
   challenge creation/verification remain unauthenticated bootstrap routes.
6. Whether `KYA-CREDENTIAL+JWT` and `KYA-AGENT-ACCESS+JWT` become distinct JOSE
   `typ` values immediately or credential header compatibility must be retained.
7. Whether the MVP remains single-process JSON/file persistence with a bounded
   replay ledger, or introduces shared persistence before external frontend
   rollout.

### Sources and provenance

- ERC-4361 SIWE: <https://eips.ethereum.org/EIPS/eip-4361>
- OAuth 2.0 Device Authorization Grant (RFC 8628):
  <https://www.rfc-editor.org/rfc/rfc8628>
- OAuth 2.0 Demonstrating Proof of Possession (DPoP, RFC 9449):
  <https://www.rfc-editor.org/rfc/rfc9449>
- JWK Thumbprint (RFC 7638): <https://www.rfc-editor.org/rfc/rfc7638>
- EIP-1193 provider API: <https://eips.ethereum.org/EIPS/eip-1193>
- Didit create session: <https://docs.didit.me/sessions-api/create-session>
- Didit signed webhooks: <https://docs.didit.me/integration/webhooks>
- viem wallet/contract operations and event watching:
  <https://viem.sh/docs/clients/wallet>,
  <https://viem.sh/docs/contract/simulateContract>,
  <https://viem.sh/docs/contract/watchContractEvent>
- Repository-specific source provenance: `docs/SOURCES.md` (retrieval date
  2026-08-29).

### Key Learnings

1. The observed Didit 404 is caused by a missing GET callback route, while the signed webhook already owns authoritative KYC state updates.
2. Current challenge verification proves agent key possession but returns no access token and has no middleware to resolve an authenticated agent context.
3. A bearer-only agent JWT would violate the FLOW invariant because a copied unexpired token could be replayed without the local private key.
4. DPoP-bound access JWTs require proof signature, cnf.jkt, htm, htu, iat, jti, and ath validation plus replay storage on every protected request.
5. The current JSON repository stores no pairing lifecycle, access-token metadata, or DPoP replay ledger and is not a shared multi-instance authorization store.
