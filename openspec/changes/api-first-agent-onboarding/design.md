# Design: API-First Agent Onboarding (CDP + Supabase + DPoP)

## Technical Approach

Expose KYA as an external-frontend and local-agent HTTP contract while keeping
private keys on the agent device. Human login is CDP email OTP → opaque access
token exchange → short human session bound to a pseudonymous Principal and the
sole CDP Smart Account. Device pairing follows RFC 8628 semantics with hashed
codes. Agent API access uses a distinct ≤10-minute ES256 access JWT plus RFC
9449 DPoP. Supabase (service role) is the live persistence and shared DPoP
replay authority; InMemoryRepository remains the test double. JSON file
persistence stays available only for local demo and MUST NOT silently back live
or Supabase mode.

## Architecture Decisions

| Decision | Alternatives | Rationale |
|---|---|---|
| CDP OTP + `POST /v1/auth/cdp/exchange` | Reintroduce SIWE / injected wallet | FLOW and CDP change already removed SIWE; Smart Account is the owner |
| `POST /v1/device-enrollments` + claim/token | Keep only `/v1/enrollments` attach | Separates agent-held device_code from human user_code; hashes at rest |
| Access JWT `typ=KYA-AGENT-ACCESS+JWT` + DPoP | Bearer or identity credential as access | Preserves FLOW: copied credential ≠ possession; distinct verifiers |
| Supabase service-role client + RLS revoke | JSON-only or anon client | Shared durable replay; backend never needs anon key; fail closed |
| Aggregate `kya_state` + `kya_compare_and_swap_state` RPC | Multi-table DELETE/INSERT replaceAll | Single conditional update; no partial empty DB; no auto-retry of side-effecting callbacks |
| `consumeDpopReplayAtomic` + `kya_consume_dpop_replay` INSERT ON CONFLICT DO NOTHING | withLock-only / unique-violation races | Explicit consumed\|replay; durable multi-instance; UNAVAILABLE→503 |
| Live `ownerOf` re-check in `requireAgentAuth` | Persist-only owner compare | Token lifetime cannot outlive on-chain ownership |
| Navigation-only `GET /v1/kyc/callback` 303 | Treat query status as decision | Signed Didit webhook remains sole KYC authority |
| CDP Smart Account UserOperation + viem watcher | Browser Wallet `writeContract` / server custody | Registration authority stays with Smart Account + chain evidence |

## Data Model (persist)

Persist: Principal↔CDP userId/Smart Account binding; enrollment lifecycle;
hashed device/user codes; KYC normalized state + webhook event ids; registry
agentId + owner evidence; credential metadata (never raw identity JWT after
one-time delivery); challenges; signing-key public metadata; event cursors /
processed / pending events; access-token metadata/status; DPoP replay jti.

Never persist/log/return: raw CDP tokens, OTP/email, KYC documents/PII/
biometrics/provider secrets, raw private JWKs, raw access JWTs, raw
device/user codes after issuance.

## Key Contracts

```text
Human: CDP OTP → accessToken → POST /v1/auth/cdp/exchange → human session
Pair:  agent P-256 public JWK → POST /v1/device-enrollments
       → device_code + user_code + verification_uri + expires_in + interval
       → human claim user_code + fingerprint → approve (sole pairing authority;
         no agentUuid-only attach route)
       → agent POST /v1/device-enrollments/token (device_code body)
       → pending|complete(+credential once)|denied|expired|slow_down
Agent: POST /v1/agents/:id/challenges → verify → access JWT (DPoP-bound)
       → local bindings/signature → ownerOf → atomic nonce+token-record CAS
       Authorization: DPoP <jwt> + DPoP proof → requireAgentAuth → /v1/agent/me
KYC:   POST /v1/kyc/sessions → Didit hosted; GET /v1/kyc/callback 303 only
       POST /v1/kyc/webhooks/didit authoritative; GET owner-scoped status
ERC:   registration-intent → CDP UserOp → registration-submissions → watcher
Ready: GET /health liveness; GET /ready sanitized deps/schema; fail closed
```

## Components

| Area | Action |
|---|---|
| `src/auth/*` | CDP + human session; agent access JWT; DPoP middleware |
| `src/services/ceremony.ts` | Device enrollment claim/poll; challenge→access; KYC status |
| `src/persistence/*` | InMemory + optional JsonFile demo; SupabaseRepository |
| `supabase/migrations/` | Versioned SQL, RLS enabled, revoke anon/authenticated |
| `src/crypto/*` | Public JWK sanitize; DPoP proof helpers (key handle) |
| `web/src/*` | Reference client; IndexedDB CryptoKey; no localStorage private JWK |
| `scripts/kya-store-migrate.ts` | Idempotent JSON↔Supabase import/export preserving IDs |

## Config aliases (never log values)

Prefer `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_SECRET_KEY`.
Accept repository aliases `SUPABASE_ANON` (ignored by backend) and
`SUPABASE_SERVICE_ROLE`. Backend does not require the anon key.

## Testing

Strict TDD: unit for hashing, token class separation, DPoP failures; integration
for device one-time delivery, KYC callback/webhook authority, Supabase atomic
mutations (when URL available), restart durability via InMemory→serialize
fixtures; API E2E against in-process Hono. Live Supabase/Didit/CDP gates recorded
in `apply-progress.md` when Secret Vault lacks required names.

## Rollback

Feature-flag or disable new device/agent routes; keep InMemory/demo JSON for
local; leave Supabase tables additive. Never migrate private keys. Old
`/v1/enrollments` remains as a documented deprecated compatible surface only
when it does not weaken hashed-code / one-time credential contracts.

## Sources

See `docs/SOURCES.md` and capability specs under `openspec/specs/`.
