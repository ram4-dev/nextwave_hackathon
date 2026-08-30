# Tasks: api-first-agent-onboarding

## Phase 0 — Conflicts and bookkeeping

- [x] 0.1 Resolve README / app.ts / package-lock preserving CDP + Juno catalog
- [x] 0.2 Correct OpenSpec proposal/design/state for CDP (no SIWE reintroduction)
- [x] 0.3 Keep apply-progress evidence log current

## Phase 1 — Persistence and config (TDD)

- [x] 1.1 Extend domain types: hashed device codes, access-token metadata, DPoP replay
- [x] 1.2 Env aliases for Supabase URL/service role; fail-closed live mode rules
- [x] 1.3 Versioned SQL migrations + RLS/revokes (mandate PR pattern, no mandate feature)
- [x] 1.4 SupabaseRepository service-role client; preserve InMemoryRepository
- [x] 1.5 JSON↔Supabase import/export utility (ID-preserving, reject forbidden material)
- [x] 1.6 `GET /ready` sanitized status; `/health` liveness-only

## Phase 2 — Device pairing (TDD)

- [x] 2.1 `POST /v1/device-enrollments` public JWK → codes + URI + expiry/interval
- [x] 2.2 Hash codes at rest; claim + fingerprint approval under human session
- [x] 2.3 Poll token endpoint; one-time credential delivery
- [x] 2.4 Document deprecated compatible `/v1/enrollments` surface

## Phase 3 — Agent auth / DPoP (TDD)

- [x] 3.1 Challenge verify → ≤10m ES256 access JWT distinct typ/aud/cnf.jkt
- [x] 3.2 `requireAgentAuth` full RFC 9449 validation + atomic replay
- [x] 3.3 `AuthenticatedAgentContext` + `GET /v1/agent/me`
- [x] 3.4 Reusable agent DPoP proof helpers accepting key handle

## Phase 4 — KYC / registration / frontend

- [x] 4.1 Owner-scoped KYC status; callback 303; webhook-only state changes
- [x] 4.2 Preserve CDP registration-intent/submissions/resolve + watcher
- [x] 4.3 Wizard as API client; IndexedDB CryptoKey; loss/re-pair model

## Phase 5 — Docs and verification

- [x] 5.1 Update FLOW.md, README, IMPLEMENTATION, SOURCES
- [x] 5.2 Full npm test/lint/typecheck/build/demo + git diff --check
- [x] 5.3 Record live external gates in apply-progress.md

## Phase 6 — Independent-review hardening (TDD)

- [x] 6.1 Replace unsafe replaceAll with `kya_state` CAS RPC (no side-effect retry)
- [x] 6.2 Repository `consumeDpopReplayAtomic` + Supabase INSERT ON CONFLICT; UNAVAILABLE→503
- [x] 6.3 Live `ownerOf` re-check in `requireAgentAuth` (injectable); DPoP before ownerOf
- [x] 6.4 Live fail-closed supabase; `/ready` schema readiness; exact schema version
- [x] 6.5 Strict public JWK (32-byte coords); credential typ; access-token binding; size caps
- [x] 6.6 Rate limits without legacy bypass; fail-safe key resolver; live requires durable limiter
- [x] 6.7 Negative coverage + migrate dry-run units; OpenSpec TDD evidence table (honest)
- [x] 6.8 Non-destructive migrations (no DROP/CASCADE) + static safety guard
- [ ] 6.9 Full remote browser ceremony (Supabase DDL/readiness complete; BLOCKED externally by CDP allowed-origin email OTP failure)

## Phase 7 — Final audit hardening (TDD)

- [x] 7.1 Validate canonical P-256 coordinates as real curve points in server, DPoP, browser storage, generation, and rotation paths
- [x] 7.2 Wire nominally durable Supabase rate limiting through the executable bootstrap; include limiter health in `/ready`
- [x] 7.3 Prove atomic rate RPC new/existing/expired/concurrent behavior in an isolated local PostgreSQL database
- [x] 7.4 Replace whole-body reads with bounded streaming for every KYA JSON/raw-body route and deterministic 413 responses
- [x] 7.5 Execute rate limiting before authentication and repository work on every scoped KYA endpoint
- [x] 7.6 Prove DPoP→ownerOf→replay order plus persisted JWK/token/credential/enrollment/Principal binding
- [x] 7.7 Run full tests, typecheck, lint, build, demo ceremony, migration safety, and diff checks

## Phase 8 — Independent parent review hardening (TDD)

- [x] 8.1 Emit and verify protected `typ=KYA-HUMAN-SESSION+JWT`; reject token-class confusion
- [x] 8.2 Enforce identical server/browser ES256 public-JWK metadata constraints
- [x] 8.3 Remove the legacy `agentUuid`-only attach HTTP route; keep claim as sole pairing authority
- [x] 8.4 Validate nonce bindings and P-256 signature before `ownerOf`
- [x] 8.5 Atomically consume challenge nonce and append access-token metadata in one lock/CAS
- [x] 8.6 Run focused adversarial coverage and the complete repository verification matrix
