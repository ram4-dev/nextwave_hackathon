```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:c02eda542b190a2c798c46172b91711b433bd7fde1d120c2476635234de89beb
verdict: pass
blockers: 0
critical_findings: 0
requirements: 9/9
scenarios: 18/18
test_command: npm test
test_exit_code: 0
test_output_hash: sha256:ed86b0932357021ab740bf6520d3a4c02ad186b53437cd35e06d4668bf15e26f
build_command: npm run build
build_exit_code: 0
build_output_hash: sha256:a484964bb9451fdb19393879fe395a8ea2fc99e684999174089db2e9db0ad522
```

## Verification Report

**Change**: cdp-embedded-wallet-onboarding
**Version**: N/A
**Mode**: Strict TDD

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total | 26 |
| Tasks complete | 26 |
| Tasks incomplete | 0 |

The effective active scope is 9 requirements and 18 scenarios: EWL 5/9, HAA 1/3, and ERC 3/6. Removed and renamed headings are not active requirements.

### Build & Tests Execution
**Build**: ✅ Passed
```text
npm run build -> exit 0
Server TypeScript and Vite production build passed. Vite emitted one non-blocking 1.06 MB chunk-size warning.
```

**Tests**: ✅ 79 passed, 0 failed, 0 skipped
```text
npm test -> exit 0
5 files passed: vite-config 2, registration 12, cdp-auth 14, kya 37, cdp-frontend 14.
```

**Additional fresh gates**:
- `npm run lint` -> exit 0, zero warnings.
- `npm run typecheck` -> exit 0.
- `npm run demo:ceremony` -> exit 0 with deterministic `{ ok: true }` result.
- `git diff --check` -> exit 0.
- `npx vitest run tests/kya.test.ts tests/registration.test.ts tests/vite-config.test.ts tests/cdp-frontend.test.ts` -> exit 0, 60 passed.
- `npx vitest run tests/registration.test.ts -t "durable Registered-event reconciliation"` -> exit 0, 2 passed and 9 skipped.
- Built-server health harness on port 8799 -> `{"ok":true,"mode":"demo"}`; legacy `/v1/auth/nonce` and `/v1/auth/verify` each returned 404.
- `npx tsx -e <allowedHosts edge diagnostic>` -> exit 0; missing, malformed, localhost, public-host, secret-nonexposure, and `envDir` assertions passed.
- Restarted public runtime probe supplied by the remediation gate -> `/health` and `/app/` each returned HTTP 200.
- `npx vitest run tests/cdp-frontend.test.ts tests/registration.test.ts --reporter verbose` -> exit 0, 26 passed.
- `npx vitest run tests/registration.test.ts -t "current KYA session and full registry evidence"` -> exit 0, authenticated claim test passed.
- `npx vitest run tests/kya.test.ts -t "never contain private JWK fields or raw tokens"` -> exit 0, persistence boundary test passed.
- Fresh built-server health on port 8799 -> `{"ok":true,"mode":"demo"}`; unauthenticated claim returned 401.

**Coverage**: ➖ Not available; no coverage tool or threshold is configured.

### Spec Compliance Matrix
| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| EWL-001 | First successful login | `tests/cdp-frontend.test.ts > verifies the OTP...` | ✅ COMPLIANT (mocked provider; live rollout gate remains) |
| EWL-001 | OTP abuse or invalid code | `tests/cdp-frontend.test.ts > blocks an in-flight duplicate...`; `never exchanges...invalid or replayed OTPs` | ✅ COMPLIANT |
| EWL-002 | New account is provisioned | `tests/cdp-frontend.test.ts > requires a public project ID...`; `tests/cdp-auth.test.ts > normalizes...ownerAddresses` | ✅ COMPLIANT (live provisioning not executed) |
| EWL-002 | Account identity mismatch | `tests/cdp-auth.test.ts > fails closed...conflicting binding`; `tests/cdp-frontend.test.ts > requires the current CDP Smart Account...` | ✅ COMPLIANT |
| EWL-003 | Valid token exchange | `tests/cdp-auth.test.ts > exchanges a validated CDP token...` | ✅ COMPLIANT |
| EWL-003 | Invalid token or replayed provisioning request | `tests/cdp-auth.test.ts > normalizes invalid, expired, and wrong-project...`; `creates one...and reuses it` | ✅ COMPLIANT |
| EWL-004 | Returning user recovers access | `tests/cdp-auth.test.ts > creates one...and reuses it`; human-session tests | ✅ COMPLIANT |
| EWL-004 | CDP outage | `tests/cdp-auth.test.ts > normalizes an unavailable CDP dependency...` | ✅ COMPLIANT |
| EWL-005 | Legacy path requested | `tests/cdp-auth.test.ts > contains no legacy auth routes...`; local HTTP 404 probe | ✅ COMPLIANT |
| HAA-003 | Enrollment owner acts | `tests/registration.test.ts > accepts only a UserOperation hash...`; owner-route tests | ✅ COMPLIANT |
| HAA-003 | Cross-Principal access | `tests/registration.test.ts > ...denies cross-Principal submissions`; `tests/kya.test.ts > hides enrollment detail...` | ✅ COMPLIANT |
| HAA-003 | Address or account mismatch | `tests/cdp-auth.test.ts > rejects a still-signed session...`; `tests/cdp-frontend.test.ts > requires the current CDP Smart Account...` | ✅ COMPLIANT |
| ERC-001 | Eligible enrollment | `tests/registration.test.ts > records only a matching UserOperation hash...`; sponsorship readiness test | ✅ COMPLIANT |
| ERC-001 | Missing prerequisite or account mismatch | `tests/registration.test.ts > rejects missing KYC, fingerprint readiness...` | ✅ COMPLIANT |
| ERC-002 | Sponsored user approval | `tests/cdp-frontend.test.ts > records only the returned UserOperation hash...`; production `App.tsx` | ✅ COMPLIANT (live approval not executed) |
| ERC-002 | Paymaster or user denies execution | `tests/cdp-frontend.test.ts > records only...and records nothing after...rejection` | ✅ COMPLIANT |
| ERC-003 | Matching UserOperation confirms on-chain | `tests/registration.test.ts > retries a matching event...`; `binds a resolution-before-event...` | ✅ COMPLIANT |
| ERC-003 | Duplicate or mismatched submission | `tests/registration.test.ts > never binds...when any...evidence is absent`; mismatch/idempotency tests | ✅ COMPLIANT |

**Compliance summary**: 18/18 scenarios compliant; 9/9 requirements complete.

### Correctness (Static Evidence)
| Requirement | Status | Notes |
|------------|--------|-------|
| EWL-001 | ✅ Implemented | CDP email hooks gate exchange; invalid, replayed, rate-limited, origin, and in-flight failures create no session or binding. |
| EWL-002 | ✅ Implemented | `createOnLogin: "smart"`; real SDK `ownerAddresses[]`; exactly one Smart Account/owner; no EOA persistence. |
| EWL-003 | ✅ Implemented | Server SDK validation, pseudonymous mapping, ES256 15-minute `typ=kya_session`, current binding re-check. |
| EWL-004 | ✅ Implemented | Stable `cdpUserId` reuse, conflict and dependency failure are fail-closed. |
| EWL-005 | ✅ Implemented | SIWE and BrowserWallet runtime files/routes removed; agent P-256/KYC/DPoP regressions pass. |
| HAA-003 | ✅ Implemented | Middleware resolves Principal and wallet from signed session; cross-Principal tests pass. |
| ERC-001 | ✅ Implemented | Exact Base Sepolia intent and prerequisite/Principal checks are present; readiness is reported without claiming external proof. |
| ERC-002 | ✅ Implemented | Production frontend uses explicit CDP approval and `useCdpPaymaster: true`; rejection records nothing. |
| ERC-003 | ✅ Implemented | Every bind requires recorded intent/UserOperation, successful receipt timestamp, exact resolved transaction, registry, event, and independent `ownerOf`; durable reconciliation covers both event orders and restart. |

### Coherence (Design)
| Decision | Followed? | Notes |
|----------|-----------|-------|
| CDP React email-only Smart Account | ✅ Yes | Installed hooks/provider configuration uses email and `createOnLogin: "smart"`. |
| Server-side CDP token exchange | ✅ Yes | Real `EndUserAccount` shape and SDK validation adapter are used. |
| Principal-bound ES256 KYA session | ✅ Yes | Issuer, audience, algorithm, expiry, type, subject, and wallet binding are validated. |
| User-approved sponsored UserOperation | ✅ Yes | Production App sends the exact API intent with CDP native sponsorship and records only the returned UserOperation hash. |
| CDP status then independent watcher authority | ✅ Yes | Provider resolution cannot bind without exact receipt/event/owner evidence. |
| No implicit legacy reconciliation | ✅ Yes | Wallet-only Principal mapping returns `CDP_RECONCILIATION_REQUIRED`. |
| Repository-root Vite environment | ✅ Yes | `envDir` resolves to repository root; a test loads only `VITE_*` presence without emitting the project ID. |

### TDD Compliance
| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | `apply-progress.md` records all 26 completed tasks including Phase 8 RED/GREEN evidence. |
| All behavior tasks have tests | ✅ | Each behavior task names focused tests; structural verification tasks name full gates. |
| RED confirmed (tests exist) | ✅ | All referenced current test files exist, including Phase 7 evidence-gate and Vite tests. |
| GREEN confirmed (tests pass) | ✅ | Fresh full suite passed 79/79. |
| Triangulation adequate | ✅ | Missing evidence fields, mismatches, both event orders, restart, duplicate, sponsorship unknown, and root env loading are exercised. |
| Safety Net for modified files | ✅ | Focused claim/frontend tests 26/26 and full 79/79 suite both passed. |

**TDD Compliance**: 6/6 checks passed.

### Test Layer Distribution
| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit | 23 | 5 | Vitest |
| Integration | 56 | 4 | Vitest, Testing Library/jsdom, Hono in-memory requests |
| E2E | 0 | 0 | Not installed |
| **Total** | **79** | **5** | |

### Changed File Coverage

Coverage analysis skipped — no coverage tool detected.

### Assertion Quality

**Assertion quality**: ✅ Assertions execute production code and verify observable results. The two broad truthiness assertions validate generated non-empty identifiers/key material after production ceremonies; no tautological assertions, skipped tests, or focused-only tests were found.

### Quality Metrics
**Linter**: ✅ No errors or warnings
**Type Checker**: ✅ No errors

### Issues Found

**CRITICAL**: None.

**WARNING**: None.

**SUGGESTION**:
1. Split the 1.06 MB frontend bundle with dynamic imports or manual chunks before production rollout.

### Post-verification Runtime Regression

The Vite development server derives `server.allowedHosts` from only the hostname of repository-root `PUBLIC_BASE_URL`; no deployment hostname is hardcoded. This setting remains server-only because the complete environment is loaded solely inside Vite configuration and only the derived hostname is returned. Missing or malformed URLs leave `allowedHosts` undefined, retaining Vite's safe default behavior; a local URL yields only `localhost`. The configuration still preserves repository-root `envDir`, normal `VITE_*` browser exposure, and the tested CDP project configuration without returning or logging secret values. Focused tests passed 2/2, the full suite passed 75/75, and the restarted external runtime returned HTTP 200 for both `/health` and `/app/`.

### Phase 8 Credential Claim Recovery

The live registration path now performs the ordered sequence UserOperation submission -> authoritative receipt/watcher binding -> authenticated credential claim -> challenge UI. Claim requires the current KYA human session, the enrollment's owning Principal, active KYC, `bound` registry evidence, and a fresh `ownerOf` match. A bound enrollment with no credential can recover after HMR by claiming before its challenge action. Sequential retries preserve one active credential record and the same JTI; re-signing uses the original `iat`, `nbf`, and `exp`, so it does not extend validity or weaken signature verification. The claim route never sends another UserOperation or registry transaction. Frontend orchestration ignores credential response material and writes no JWT to React state, browser storage, or logs; repository regression tests confirm no raw JWT or private JWK persistence. Claim failure does not advance the UI and does not call the challenge endpoint. Focused tests passed 26/26 and the full suite passed 79/79.

### Rollout Gate

No live Base Sepolia OTP, Didit KYC, Portal sponsorship approval, UserOperation, registry event, or credential claim was executed. Authorized rollout still requires a real CDP email-OTP user, Portal allowed domain, live Didit decision, active sponsorship policy, and explicit Smart Account approval. The smoke must prove the operation reaches `complete`, its exact non-reverted receipt/event/`ownerOf` chain binds once, and the credential can then be claimed.

### Verdict

PASS WITH WARNINGS

The implementation is locally archive-ready against all 9 requirements and 18 scenarios. The live backend and Vite processes must be restarted before the public smoke so the claim route and frontend sequence use the new build. The only remaining verification is the explicitly external rollout smoke; the bundle-size suggestion is non-blocking.
