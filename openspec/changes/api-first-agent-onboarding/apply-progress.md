# Apply Progress: api-first-agent-onboarding

Updated: 2026-08-30 (independent parent-review hardening — token classes, pairing authority, atomic challenge issuance)

## Delivery

- `delivery_strategy`: exception-ok
- `size`: exception (user-approved; no changed-line cap)
- Implementation owner: this worktree only; no commit/push/PR by implementer
- Apply status: **local hardening complete; remote E2E BLOCKED** (see gates)
- Apply/verify are **not** fully complete while live Supabase gate remains pending

## TDD Cycle Evidence

| Requirement / task | Test | RED observed | Minimal change | GREEN | Safety / regression |
| --- | --- | --- | --- | --- | --- |
| PROBE1: P-256 coords exact 32 bytes | `tests/audit-remediation.test.ts` PROBE1 | `assertPublicEcP256Jwk({x:'a',y:'b'})` accepted | Decode base64url → require exactly 32 bytes each | rejects short coords | real JWKs still accepted |
| PROBE2: exact schema version | audit PROBE2 + extended | `20260830_01` returned true | `checkSupabaseSchemaReady` exact `KYA_SCHEMA_VERSION` only | stale false | CAS authority only |
| PROBE3: legacy enrollments rate limit | audit PROBE3 | legacy returned 201 after limit | same `checkPublicRate` + body cap on `/v1/enrollments`; fail-safe global bucket | 429 | no XFF spoof bypass |
| Migration DROP safety | `tests/migration-safety.test.ts` | (guard added before destructive draft) | 01 CAS-only fresh; 02 additive revoke/de-authorize legacy tables; **no DROP/CASCADE** | guard green | comments stripped for executable checks |
| Replay RPC return type | migration SQL review | 01 boolean vs 02 text would fail OR REPLACE | both return **boolean**; client accepts true/false | compatible sequence | documented |
| SupabaseRepository adapter | `tests/audit-remediation-extended.test.ts` fake client | prior VersionedStateBackend-only coverage | fake client: load/CAS/conflict/RPC UNAVAILABLE/replay/import idempotent/scrub | green | assert private material before CAS |
| Idempotent import | migrate-store + importStoreIdempotent | saveStore from cachedVersion=0 conflicted on re-import | load→compare→noop or CAS once | dry-run + written/noop | units in `src/persistence/migrate-store.ts` |
| DPoP before ownerOf | extended DPoP order | ownerOf called before proof validation | validate DPoP crypto → ownerOf → consume replay | invalid proof never calls ownerOf | unavailable→503; transfer→403 |
| Live durable rate limit | extended live without durable | memory used silently in live | nominal `hasDurableRateLimitAuthority` capability → UNAVAILABLE 503 when absent | green | Supabase RPC limiter available; forged booleans rejected |
| Body size caps | extended 413 | only device create capped | `readJsonBody` + webhook size | 413 | sanitized |
| Credential/access binding | extended + hardening | claim mismatches accepted | full claim↔record checks | green | principalId/jkt/registry/owner |
| JWK private class + dpopClient | extended + hardening | only d rejected; web stripped only d | all private members PII_FORBIDDEN; web assertPublicEcP256Jwk | green | contaminated proof rejected |
| KYC cross-principal / callback | extended KYC | coverage gap | status FORBIDDEN; callback no mutate | green | webhook remains authority |
| Honest migrate dry-run evidence | migrate-store unit | prior apply-progress claimed dry-run but only JWK assert | real `importStoreWithOptions({dryRun})` + validateImportStore | green | corrected OpenSpec row |

## Final hardening TDD cycle evidence

| Task | Test file | Layer | Safety net | RED | GREEN | TRIANGULATE | REFACTOR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 7.1 P-256 real-point validation | `tests/final-audit-probes.test.ts`, `tests/audit-remediation-extended.test.ts` | Unit + integration | Baseline PROBE A server validator green | Server DPoP emitted a proof with `(0,0)`; bound rotation accepted and mutated it | Server/browser validators, DPoP builder, key generation/storage, enrollment, and rotation reject off-curve/private keys; valid P-256 passes | Valid key + off-curve + private member cases | Shared `validatedEnrollmentPublicJwk` removed divergent enrollment/rotation handling |
| 7.2 live bootstrap and durable authority | `tests/final-audit-probes.test.ts`, `tests/audit-remediation-extended.test.ts` | Integration | Initial suite 189/190; expected bootstrap probe failed | Live valid dependencies returned 503; forged `durable: true` returned 201 | `createBootstrappedApp` is used by `src/server/index.ts`; nominal Supabase authority succeeds; forged capability fails; `/ready` flips 200→503 on RPC outage | Healthy RPC + failed RPC + forged memory limiter | Module-private capability brand replaces caller boolean trust |
| 7.3 atomic SQL rate RPC | `tests/migration-safety.test.ts`, `tests/rate-limit-postgres.integration.test.ts` | Static + PostgreSQL integration | Existing migration safety 2/2 | Audit found SELECT→INSERT lost-update; resumed partial already contained the candidate UPSERT before this agent's test cycle | 5/5: single UPSERT contract, new/existing/denied/expired windows, and 20 concurrent increments persist count 20 | Sequential lifecycle + same-key concurrency | Temporary isolated database; migrations remain additive and non-destructive |
| 7.4 bounded request bodies | `tests/request-body-hardening.test.ts` | Unit + API integration | Existing oversized-device test green but read whole body | Bounded-reader module absent; protected attach returned 404 instead of 413 for an oversized stream | 3/3: stream cancels after two 20,000-byte pulls; 19 supported JSON route/body paths and raw webhook return deterministic 413 without Content-Length; valid signed webhook remains 200 | Public + protected + ignored-body POST + raw signed webhook | One byte-bounded reader shared by JSON, ignored bodies, and raw webhook transport; removed attach is no longer treated as supported |
| 7.5 rate before auth/DB | `tests/rate-limit-ordering.test.ts` | API integration | Existing endpoint rate tests green | Malformed bearer on device claim returned 401 before counting | 16 supported scoped routes return 429 first; limiter called 16 times; repository reads/locks remain zero | Human and agent scopes; GET and POST routes | Reusable `requireRateLimit` middleware placed first; removed attach is not counted |
| 7.6 DPoP/binding invariants | `tests/api-first-hardening.test.ts`, `tests/audit-remediation-extended.test.ts`, `tests/registration.test.ts` | Unit + API integration | Existing CAS/replay/registration suites green | Persisted replacement JWK with stale thumbprint still resolved agent context | RFC 7638 thumbprint is recomputed; exact/wrong issuer/audience/expiry rules pass; ownerOf outage does not consume proof; replay consumes only after ownerOf | Exact token profile + three claim failures; owner outage/retry/replay; JWK replacement | Binding check localized in authenticated-context resolution |

## Independent parent-review TDD cycle evidence

| Task | RED observed | Minimal production correction | GREEN evidence |
| --- | --- | --- | --- |
| 8.1 Human JWT class | Issued header was generic `typ=JWT`; correctly signed human claims under generic/credential/agent headers verified | Added `KYA-HUMAN-SESSION+JWT` to issuance, pre-verification class check, and `jwtVerify({typ})` | `tests/cdp-auth.test.ts` 15/15; duplicate-kid session test uses the exact class |
| 8.2 JWK metadata parity | Server accepted `alg=ES384`, `use=enc`, invalid `key_ops`, `ext=false`, and invalid `kid`; browser behavior differed by WebCrypto import | Both validators enforce the same optional ES256 public-verification metadata profile before curve import | `tests/jwk-metadata-parity.test.ts` 4/4 across valid profile and 16 adversarial metadata cases |
| 8.3 Claim-only pairing | Authenticated POST by known `agentUuid` returned 200 and bound without consuming `user_code` | Removed runtime attach route; retained internal helper for deterministic demo/test setup | API regression returns 404 with no mutation, then valid `device-enrollments/claim` binds and stamps `claimedAt`; body/rate matrices exclude removed route |
| 8.4 Challenge call order | Unknown nonce reached `ownerOf` and produced a TypeError; invalid signature could trigger chain work | Validate stored nonce existence/expiry/bindings and P-256 signature before external ownership read | Invalid nonce/signature never calls `ownerOf`; owner outage leaves nonce and tokens untouched; retry succeeds |
| 8.5 Atomic nonce/token CAS | Fake Supabase rejected access-token CAS after nonce CAS; remote nonce remained consumed without a token record | Split token signing from persistence; final binding rechecks, nonce consumption, and access-token append share one `withLock`/CAS | Rejected combined CAS leaves nonce unconsumed and zero records; same proof retries to exactly one consumed nonce and one active record; replay adds none |

## Work Unit Evidence

| Evidence | Required value |
| --- | --- |
| Focused test command and exact result | Parent-review focus: `npx vitest run tests/audit-remediation-extended.test.ts tests/api-first-agent.test.ts tests/api-first-hardening.test.ts tests/kya.test.ts tests/cdp-auth.test.ts tests/jwk-metadata-parity.test.ts` → 101/101 pass; migration/PostgreSQL focus remains 5/5 |
| Runtime harness command/scenario and exact result | `npm test` → 27 files, 208/208 tests pass, including isolated local PostgreSQL concurrency; `npm run demo:ceremony` → success |
| Rollback boundary | Revert `src/auth/{session,agent-access}.ts`, JWK metadata checks in server/browser, the attach-route deletion in `src/server/app.ts`, the challenge transaction in `src/services/ceremony.ts`, and Phase 8 tests/docs without removing prior API-first/CAS work |

### Honest deviations

- Remote Supabase CAS/RPC concurrency and DDL deploy **not** executed; this apply was explicitly prohibited from reading local `.env`/secrets and DDL authorization remains separate.
- IndexedDB persistence remains browser-only; Node covers pre-write/load validation and `dpopClient` pure units.
- Legacy draft normalized tables may still exist in a DB that applied an old draft; migration 02 **revokes** grants and documents non-authority — it does **not** DROP them.

## Evidence log

| Time | Step | Result |
| --- | --- | --- |
| 2026-08-30 | Audit probes RED | PROBE1/2/3 failed as reported |
| 2026-08-30 | Non-destructive migration fix | Removed DROP CASCADE draft; additive 02 + static guard |
| 2026-08-30 | Local verification | `npm test` **188** pass (22 files); typecheck OK; lint OK; build OK; demo:ceremony OK; `git diff --check` clean; probes 1–3 GREEN; migration-safety GREEN |
| 2026-08-30 | Final audit RED | Live bootstrap 503; forged durable limiter 201; DPoP helper and rotation accepted off-curve JWK; protected oversized body returned 404; claim auth returned 401 before rate count; persisted JWK mismatch resolved |
| 2026-08-30 | Focused final GREEN | Bootstrap/P-256/binding 45/45; body/order 4/4; migration + isolated PostgreSQL behavior/concurrency 5/5 |
| 2026-08-30 | Full final verification | `npm test` **201** pass (26 files); typecheck OK; lint OK; build OK (server + Vite, 1866 modules); demo:ceremony OK; `git diff --check` clean |
| 2026-08-30 | Parent-review RED | Human protected typ generic; metadata inconsistencies accepted; legacy attach returned 200; invalid nonce reached `ownerOf`; split CAS burned nonce on token persistence failure |
| 2026-08-30 | Parent-review focused GREEN | `npx vitest run tests/audit-remediation-extended.test.ts tests/api-first-agent.test.ts tests/api-first-hardening.test.ts tests/kya.test.ts tests/cdp-auth.test.ts tests/jwk-metadata-parity.test.ts` → **101/101** pass |
| 2026-08-30 | Parent-review full verification | `npm test` → **208/208** pass (27 files, including PostgreSQL integration/concurrency); typecheck OK; lint OK; build OK (server + Vite, 1866 modules); demo ceremony OK; `git diff --check` clean; CodeGraph 106 files / 1,416 nodes / 5,188 edges, up to date |

## External E2E gates (non-secret names only)

| Gate | Status | Needed capability name |
| --- | --- | --- |
| Supabase project URL | USER-REPORTED IN LOCAL `.env`; NOT READ/VERIFIED IN THIS APPLY | `SUPABASE_URL` |
| Supabase service role / secret key | USER-REPORTED IN LOCAL `.env`; NOT READ/VERIFIED IN THIS APPLY | `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE` |
| Authorized DDL deploy | IN PROGRESS | Supabase CLI authenticated and linked; applying additive migrations `20260830090000_create_kya_core.sql` + `20260830090100_kya_state_cas.sql` after dry-run validation |

## Rollback boundary

Disable/ignore new `/v1/device-enrollments*` and `/v1/agent/*` routes; keep CDP ceremony + catalog. The final transport/bootstrap slice can be reverted through `src/server/{bootstrap,rate-limit,request-body,app,index}.ts` plus its focused tests. Leave Supabase tables additive (`kya_state` CAS). Never migrate private keys. Never DROP legacy draft tables via migration. JSON demo persistence remains for local non-live mode only.
The Phase 8 hardening slice is independently bounded to human-session class, JWK metadata validation, removal of legacy attach, and challenge/token atomicity plus their focused tests and documentation.
