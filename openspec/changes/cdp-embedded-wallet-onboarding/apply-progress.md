# Apply Progress: CDP Embedded Wallet Onboarding

## Completed tasks

- [x] 1.1 CDP identity/session RED coverage
- [x] 1.2 CDP identity binding and ES256 human session
- [x] 2.1 Exchange route error/legacy-path coverage
- [x] 2.2 CDP exchange route and Principal-bound middleware
- [x] 1.3 Additive pseudonymous persistence and no-PII coverage
- [x] 2.3 Browser-wallet connector removal and boundary cleanup
- [x] 3.1 Registration/UserOperation RED coverage
- [x] 3.2 Authoritative CDP UserOperation resolver and intent persistence
- [x] 3.3 Watcher receipt, registry, intent, event, and Smart Account `ownerOf` proof
- [x] 4.1 Interactive CDP OTP UI RED coverage
- [x] 4.2 CDP hooks, email OTP, access-token exchange, and Smart Account UserOperation UI
- [x] 4.3 Remove legacy runtime references and update custody/provenance documentation
- [x] 4.4 Local verification gates
- [x] 5.1 SDK identity contract, session type, and legacy reconciliation remediation
- [x] 5.2 Frontend UserOperation resolution and watcher-evidence polling remediation
- [x] 5.3 OTP/CORS, CDP provisioning configuration, and sponsored-operation denial remediation
- [x] 5.4 Documentation and final local verification remediation
- [x] 6.1 Durable watcher replay/reconciliation remediation
- [x] 6.2 Production-boundary CDP, OTP, ERC-001/ERC-002, and HTTP remediation
- [x] 6.3 Documentation audit and complete local verification remediation
- [x] 7.1 Mandatory ERC-003 evidence-chain remediation
- [x] 7.2 Repository-root Vite env and honest sponsorship readiness remediation
- [x] 7.3 Historical-doc cleanup and final local verification remediation

## TDD Cycle Evidence

| Task | Test file | Layer | Safety net | RED | GREEN | Triangulate | Refactor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1.1 | `tests/cdp-auth.test.ts` | unit/integration | `tests/kya.test.ts` 40/40 | missing CDP modules (expected) | 4/4 | valid reuse, conflicts, invalid email/account, ES256 rejection | pure binding helper |
| 1.2 | `tests/cdp-auth.test.ts` | unit | N/A new modules | imported absent modules | 4/4 | principal/wallet and algorithm branches | isolated SDK adapter |
| 2.1 | `tests/cdp-auth.test.ts` | API boundary | 4/4 focused suite before app route changes | exchange route 404 | 6/6 | valid exchange, legacy route 404, dependency outage 503 | provider errors normalized |
| 2.2 | `tests/cdp-auth.test.ts` | API boundary | 4/4 focused suite before app route changes | exchange route 404 | 6/6 | valid identity and no mutation on outage | short middleware contract |
| 1.3 | `tests/cdp-auth.test.ts` | unit | 6/6 | persisted mapping assertion added | 7/7 | no token/OTP/email-like persistence branch | additive fields only |
| 2.3 | full suite | integration | 49/49 | N/A cleanup | 50/50 | Didit callback/webhook regression stays green | browser connector removed |
| 3.1 | `tests/registration.test.ts` | unit/integration | 2/2 registration baseline | exported CDP normalizer absent; watcher accepted wrong intent | 5/5 | complete/pending/failed/receipt/revert/mismatch plus registry/intent/owner branches | narrow provider normalizer |
| 3.2 | `tests/registration.test.ts` | unit | 2/2 registration baseline | complete UserOperation lacked an exported, testable resolver | 5/5 | exact matching receipt and failed/pending paths | provider result remains narrow transport evidence |
| 3.3 | `tests/registration.test.ts`, `tests/kya.test.ts` | integration | 42/42 | watcher bound an event after intent mutation | 42/42 | transaction, registry, intent, `ownerOf`, replay/idempotency paths | fail-closed watcher predicates |
| 4.1 | `tests/cdp-frontend.test.ts` | jsdom component | N/A new component | `CdpAuth` import missing | 3/3 | email→OTP, OTP→token/session, normalized error DOM states | dependency-injected callback contract |
| 4.2 | `tests/cdp-frontend.test.ts` | jsdom/component | 3/3 | OTP exchange behavior absent | 3/3; typecheck/build pass | runtime CDP hooks inject into tested component | no provider secret reaches Vite |
| 4.3 | `tests/cdp-auth.test.ts` | runtime source scan | 47/47 targeted suite | legacy source scan added | 8/8; lint pass | routes, connector, import, and file absence all checked | renamed frontend origin config |
| 4.4 | full local gates | integration/runtime | focused suites green | N/A verification task | 53/53 full suite; all local gates pass | live external smoke intentionally excluded | rollout-only Base Sepolia gate |
| 5.1 | `tests/cdp-auth.test.ts` | unit/contract | ✅ 8/8 | ✅ Written: SDK `ownerAddresses`, legacy reconciliation, and `typ` assertions failed | ✅ Passed: 10/10 | ✅ exact SDK account plus absent/wrong type paths | ✅ typed normalizer |
| 5.2 | `tests/cdp-frontend.test.ts` | component/integration | ✅ 3/3 | ✅ Written: resolution/watcher ordering behavior absent | ✅ Passed: 5/5 | ✅ event-before and event-after transaction resolution | ✅ pure polling helper |
| 5.3 | `tests/cdp-auth.test.ts`, `tests/cdp-frontend.test.ts` | component/API | ✅ 15/15 focused | ✅ Written: CORS, project config, and provider/user denial contracts | ✅ Passed: 18/18 focused | ✅ success only records returned UserOpHash; rejection records none | ✅ provider config and orchestration helpers |
| 5.4 | full local gates | runtime | ✅ focused suites | ➖ structural verification | ✅ 57/57 full suite | ➖ external smoke remains rollout-only | ✅ docs/source scan cleanup |
| 6.1 | `tests/registration.test.ts` | watcher integration | ✅ 8/8 | ✅ Written: event-before-resolution restart/retry and resolution-before-event watcher cases | ✅ Passed: 9/9 | ✅ restart, duplicate, mismatch, bounded durable queue, both event orders | ✅ persisted pseudonymous pending-event adapter |
| 6.2 | `tests/cdp-auth.test.ts`, `tests/cdp-frontend.test.ts`, `tests/registration.test.ts` | SDK/API/jsdom integration | ✅ 60/60 | ✅ Written: official `EndUserAccount` adapter, invalid CDP exchange, OTP failure/in-flight, session/account mismatch, prerequisites, submission HTTP | ✅ Passed: 14/14 + 11/11 + 9/9 | ✅ invalid/replayed/rate, approval/denial/terminal, duplicate/cross-Principal | ✅ narrow SDK client and Smart Account selector |
| 6.3 | full local gates | runtime/documentation | ✅ 71/71 | ➖ audit/verification task | ✅ test 71/71; lint/typecheck/build/demo/diff/health pass | ✅ event-order diagnostic executes both watcher orders | ✅ CDP-only wording and historical labels retained |
| 7.1 | `tests/registration.test.ts`, `tests/kya.test.ts` | watcher integration | ✅ 47/47 | ✅ Written: every missing intent/UserOp/receipt/tx field rejects matching event | ✅ Passed: 47/47 | ✅ event-before-resolution durable retry, all four missing fields, strict idempotency | ✅ receipt-confirmation timestamp and demo evidence simulation |
| 7.2 | `tests/vite-config.test.ts`, `tests/registration.test.ts` | Vite config/service integration | ✅ 47/47 | ✅ Written: root `loadEnv` configuration and unknown sponsorship contract | ✅ Passed: 12/12 | ✅ configured/unconfigured sponsorship states and Vite runtime config | ✅ exported Vite config factory |
| 7.3 | full local gates | runtime/documentation | ✅ 74/74 | ➖ audit/verification task | ✅ test 74/74; lint/typecheck/build/demo/diff/health pass | ✅ event-order diagnostic 2/2 | ✅ FLOW and historical-document labels |

## Work Unit Evidence

| Unit | Focused test | Runtime harness | Rollback boundary |
| --- | --- | --- | --- |
| CDP identity/session | `npx vitest run tests/cdp-auth.test.ts` — 6/6 | mocked verifier exchange (`app.request`) — 200/503/404 assertions | `src/auth/cdp.ts`, `src/auth/session.ts`, config additions |
| Smart Account intent | `npx vitest run tests/registration.test.ts` — 1/1 | mock ceremony persistence — idempotent UserOp record | intent/UserOp fields and ceremony methods |
| Frontend configuration | `npx vitest run tests/cdp-frontend.test.ts` — 2/2 | `npm run typecheck && npm run build` — pass | web provider, wizard and CDP packages |
| Registration watcher proof | `npx vitest run tests/registration.test.ts tests/kya.test.ts` — 42/42 | CDP UserOperation provider mock + watcher proof paths | `src/auth/cdp.ts`, `src/services/ceremony.ts`, `src/registry/events.ts` |
| Interactive OTP UI | `npx vitest run tests/cdp-frontend.test.ts` — 3/3 | jsdom email→OTP→exchange→session interaction | `web/src/CdpAuth.tsx`, `web/src/App.tsx` |
| Final local verification | `npm test` — 53/53 | `curl http://127.0.0.1:8787/health` — `{ok:true,mode:"live"}` | current implementation/docs/test diff; additive records retained |
| Phase 6 replay/contracts | `npx vitest run tests/cdp-auth.test.ts tests/cdp-frontend.test.ts tests/registration.test.ts tests/kya.test.ts` — 69/69 | `npx vitest run tests/registration.test.ts -t "durable Registered-event reconciliation"` — 2/2; local `/health` live OK | `src/registry/events.ts`, pending-event persistence/type, CDP adapter/UI/orchestration tests and docs |
| Phase 7 ERC-003/env | `npx vitest run tests/kya.test.ts tests/registration.test.ts tests/vite-config.test.ts tests/cdp-frontend.test.ts` — 60/60 | `npx vitest run tests/registration.test.ts -t "durable Registered-event reconciliation"` — 2/2; local `/health` live OK | strict event gate, Vite env config, sponsorship response, demo simulation and docs |

## Remaining tasks / rollout gates

- [x] Demo SIWE compatibility module removed and legitimate state/session coverage moved to Principal-bound CDP sessions.
- [x] 3.1–3.3 authoritative CDP UserOperation status and receipt/event/`ownerOf` confirmation are locally covered.
- [x] 4.1–4.3 mocked OTP interaction and custody/provenance cleanup complete.
- [ ] External Base Sepolia rollout smoke: requires actual OTP, Portal domain allowlisting, KYC, sponsorship policy, and user approval.

## Key decisions

- CDP native sponsorship uses `useCdpPaymaster: true`; no paymaster URL or client credential is present in Vite code.
- `src/auth/siwe.ts` and its demo-only middleware fallback were deleted after the retained tests were migrated to Principal-bound human sessions.
- CDP UserOperation resolution now records a transaction hash, and the watcher rejects a `Registered` event until that exact transaction hash is present; receipt success and explicit `ownerOf` evidence remain required before closing task 3.3.
- The watcher now reads `ownerOf` through its public client and requires it to equal the `Registered` owner for Smart-Account submissions; it remains intentionally fail-closed if a watcher client cannot perform that read.
- CDP UserOperation completion now requires a matching non-reverted provider receipt as well as the transaction hash; pending, failed, and receipt-less results do not record transaction evidence.
- The CDP API describes successful receipt execution by an omitted `revert`; `normalizeCdpUserOperation` requires `status === "complete"`, an exact transaction hash, and that matching non-reverted receipt.
- A matching `Registered` event that arrives before the authoritative UserOperation transaction hash is now retained as a bounded, 24-hour/128-record durable pending item and retried on each watcher flush, including after process restart. Only this unresolved state is retryable; resolved hash, registry, intent, and owner mismatches remain fail-closed.
- `createCdpIdentityVerifier` consumes the SDK-exported `EndUserAccount` fields through a dependency-injected client contract, so `ownerAddresses[]` is checked without a singular-owner cast and real validation failures can be tested at the HTTP boundary.
- The wizard compares the current CDP hook Smart Account to the KYA session wallet immediately before `sendUserOperation`; a stale or different account cannot submit the session's registration intent.
- Every matching registration event now requires a persisted intent hash, UserOperation hash, receipt-confirmation timestamp, and exact transaction hash before registry, intent, `ownerOf`, or binding logic runs. Events arriving after a recorded UserOperation but before its receipt/transaction resolution stay in the bounded durable queue.
- Vite keeps `web` as its application root but loads public `VITE_*` values from the repository-root `.env`; the tested configuration never prints the project ID. Sponsorship is `configured` only when a project ID exists and remains `ready:false/status:unknown` until CDP Portal capability is proven externally.
- A Smart Account watcher event now fails closed unless it matches the persisted transaction hash, Base registry, registration intent hash, event owner, and independent `ownerOf` result equal to the bound Principal wallet.
- `CdpAuth` is a real DOM-tested email/OTP state machine. The production wizard injects `useSignInWithEmail`, `useVerifyEmailOTP`, and `useGetAccessToken` from CDP hooks, while `main.tsx` retains `createOnLogin: "smart"`.
- CDP embedded-wallet custody and sponsorship provenance were synchronized in `FLOW.md`, `README.md`, `docs/IMPLEMENTATION.md`, `docs/SOURCES.md`, and `.env.example`; no paymaster endpoint is stored or emitted.

## Final Local Verification

- `npm test` — 4 files, 53 tests passed.
- `npm run lint` — passed with zero warnings.
- `npm run typecheck` — passed for API and web projects.
- `npm run build` — passed; Vite reports a non-blocking 801 kB chunk warning.
- `npm run demo:ceremony` — passed deterministic demo ceremony.
- `git diff --check` — passed.
- Runtime health harness — existing local server on `127.0.0.1:8787` returned `{"ok":true,"mode":"live"}`. A second server was not started because the port was already in use.
- Source scan — `/v1/auth/nonce=0`, `/v1/auth/verify=0`, `BrowserWalletConnector=0`, `auth/siwe=0`, and `src/auth/siwe.ts` is absent from runtime source.

## Phase 6 Local Verification

- `npm test` — 4 files, 71 tests passed.
- `npm run lint` and `npm run typecheck` — passed with zero lint warnings.
- `npm run build` — passed; Vite reports only the existing non-blocking 801.85 kB chunk warning.
- `npm run demo:ceremony` — passed deterministic demo ceremony.
- `git diff --check` — passed.
- Runtime health — existing local server returned `{\"ok\":true,\"mode\":\"live\"}`.
- Event-order diagnostic — `npx vitest run tests/registration.test.ts -t "durable Registered-event reconciliation"` passed 2/2 for event-before-resolution/restart and resolution-before-event/deduplication.
- Documentation scan — current files have no production SIWE/direct-write/user-gas claim; the only BrowserWallet references are explicitly labelled historical migration provenance, and the OTP reference correctly identifies it as the production authentication input.

## Phase 7 Local Verification

- `npm test` — 5 files, 74 tests passed.
- `npm run lint` and `npm run typecheck` — passed with zero lint warnings.
- `npm run build` — passed; Vite reports a non-blocking 1.06 MB chunk warning.
- `npm run demo:ceremony` — passed with demo evidence explicitly satisfying the same registration fields.
- `git diff --check` — passed.
- Runtime health — existing local server returned `{\"ok\":true,\"mode\":\"live\"}`.
- Event-order diagnostic — `npx vitest run tests/registration.test.ts -t "durable Registered-event reconciliation"` passed 2/2.
- Environment diagnostic — `tests/vite-config.test.ts` verified root `envDir` plus Vite `loadEnv` loading without emitting the configured project ID.

## Rollout Gate

The only remaining validation is external, not a local task: authorized Base Sepolia execution needs a real CDP email OTP user, CDP Portal allowed domain, live Didit decision, active sponsorship policy, and explicit Smart Account approval. It must confirm the CDP UserOperation reaches `complete`, the exact non-reverted receipt/event/`ownerOf` proof binds once, and the credential can then be claimed.

## Post-verify Vite Host Regression

- **RED written:** `tests/vite-config.test.ts` asserted that Vite derives `server.allowedHosts` from a supplied public base URL. The focused test failed because the value was `undefined`.
- **GREEN passed:** Vite now loads the repository-root environment only while evaluating server configuration, extracts the URL hostname, and supplies it to `server.allowedHosts`. `PUBLIC_BASE_URL` is not exposed to browser modules; Vite's standard `VITE_*` exposure boundary remains intact.
- **Focused evidence:** `npx vitest run tests/vite-config.test.ts` — 2/2 passed; `npm run typecheck` — passed.
- **Full local evidence:** `npm test` — 75/75 passed; `npm run lint`, `npm run typecheck`, `npm run build`, and `git diff --check` — passed. Build has only the existing non-blocking 1.06 MB chunk warning.
- **Runtime boundary:** restart the existing Vite dev server before retesting the authorized public tunnel; no tunnel hostname or environment value is recorded in this evidence.

## Phase 8 Credential Claim Recovery

| Task | RED | GREEN | REFACTOR | Work-unit evidence / rollback |
| --- | --- | --- | --- | --- |
| 8.1 Registration → credential → challenge sequencing | `tests/cdp-frontend.test.ts` added two orchestration cases; they failed because `completeRegistrationAndClaimCredential` did not exist. | The production registration orchestration now records the returned UserOperation, awaits watcher binding, calls authenticated claim, and only then advances the wizard. A claim failure leaves challenge inaccessible. | Kept the order in a dependency-injected frontend helper used by `App.tsx`, so DOM state does not contain credential material. | Focused `npx vitest run tests/cdp-frontend.test.ts tests/registration.test.ts` — 26/26 passed. Rollback: `web/src/App.tsx`, `web/src/registration.ts`. |
| 8.2 Bound/no-credential recovery | The authenticated route test showed two consecutive claims created distinct JTIs; recovery test required claim before the retried challenge. | `claimCredential` validates session-owner, active KYC, enrollment/registry evidence, and `ownerOf`; when a non-expired active record exists it re-signs that record without adding/revoking credential state. Challenge action calls this idempotent ensure first. | Extracted common credential signing to preserve the existing response token contract while retaining one server metadata record; no JWS is placed in React state, storage, or logs. | Route integration proves no session is 401, pre-evidence claim is 400/no credential, and two valid claims retain one active record/JTI. Rollback: `src/services/ceremony.ts`, `src/credentials/jws.ts`, frontend helpers/tests. |
| 8.3 Verification | Baseline before new RED: 22 focused tests passed. RED: 3 expected failures (two absent frontend helpers, one duplicate credential JTI). | `npm test` — 79/79 passed; lint, typecheck, build, demo, and diff-check passed. | Build retains only the existing non-blocking 1.06 MB chunk warning. | Existing live server health: `curl --fail --silent --show-error http://127.0.0.1:8787/health` → `{\"ok\":true,\"mode\":\"live\"}`. |

**Decision:** A bound enrollment without a credential is recoverable only through its current KYA session and the same server-side `ownerOf`/KYC validation. No raw JWS is rendered, logged, or persisted by the browser; the existing authenticated claim response remains available to an authorized caller.

## Phase 5 Remediation Evidence

- `normalizeCdpEndUser` now consumes the installed CDP SDK 1.55 account contract with `ownerAddresses: string[]`; the singular field is not used.
- `bindCdpIdentity` now fails closed with `CDP_RECONCILIATION_REQUIRED` for wallet-only legacy Principals instead of inferring a CDP user mapping.
- Human-session verification now requires payload `typ === "kya_session"`.
- The production wizard records the UserOperation, polls the authoritative resolve endpoint, then requires an enrollment status of `bound` before advancing to the challenge step.
- Final remediation suite: `npm test` 57/57, lint/typecheck/build/demo/diff-check passed; existing local `/health` returned live OK.
- Task 5.3 completion: CdpAuth's busy state prevents in-flight duplicate email requests and failed OTP/provider calls never reach access-token exchange; server CORS denies an unconfigured origin; `cdpProviderConfig` requires a public project ID and configures email-only `createOnLogin: "smart"`; sponsored-operation rejection/outage records no submission. Final suite is 60/60.
