# Tasks: CDP Embedded Wallet Onboarding

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 650–900 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Single coherent implementation under maintainer-approved `size:exception` |
| Delivery strategy | exception-ok |
| Chain strategy | size-exception |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: size-exception
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | CDP identity, binding, KYA session | PR 1 | `npx vitest run tests/cdp-auth.test.ts` | Mock verifier; valid/invalid exchange | Revert auth/config/type additions |
| 2 | API boundary and legacy removal | PR 2 | `npx vitest run tests/cdp-auth.test.ts tests/kya.test.ts` | `npm run dev`; exchange, protected route, CORS, 404 | Revert `src/server/app.ts` and auth/UI deletion |
| 3 | UserOperation and watcher proof | PR 3 | `npx vitest run tests/registration.test.ts tests/kya.test.ts` | Mock status + authorized Base Sepolia smoke | Revert registry/ceremony adapter; retain records |
| 4 | CDP OTP UI and provenance | PR 4 | `npm run typecheck && npm run build` | `npm run dev` + `npm run dev:web`; mocked journey | Revert web/dependency/docs changes |

## Phase 1: API Contract and Persistence

- [x] 1.1 RED: `tests/cdp-auth.test.ts` covers valid/expired/wrong-project/replay/ambiguous/outage; verify targeted Vitest; rollback test.
- [x] 1.2 GREEN: create `src/auth/cdp.ts`, `src/auth/session.ts` for server validation, ES256 claims and fail-closed binding; depends 1.1; verify targeted Vitest; rollback files.
- [x] 1.3 RED→GREEN: test then add `cdpUserId`, Smart Account, intent/UserOp fields in `src/domain/types.ts`, `src/persistence/repository.ts`, `src/services/ceremony.ts`, `src/config/env.ts`; no PII; verify `npm test`; rollback additive fields.

## Phase 2: Protected API and Security Boundary

- [x] 2.1 RED: route tests cover exchange, strict CORS, cross-Principal denial, normalized errors and SIWE 404; verify targeted Vitest; rollback tests.
- [x] 2.2 GREEN: `src/server/app.ts` exchanges CDP tokens, authorizes Principal, exposes public ID; remove `src/auth/siwe.ts`; depends 2.1; verify targeted tests; rollback API/auth deletion.
- [x] 2.3 REFACTOR: remove `web/src/browserWalletConnector.ts`/test, redact logs, preserve Didit callback/webhook; verify `npm test && npm run lint`; rollback cleanup.

## Phase 3: ERC-8004 UserOperation Integration

- [x] 3.1 RED: `tests/registration.test.ts` covers intent/sponsor/rejection/replay/mismatch/receipt/event/owner/idempotency; verify targeted Vitest; rollback test.
- [x] 3.2 GREEN: `src/registry/identity.ts`/`src/services/ceremony.ts` add Smart Account intent, status resolver and `userOpHash`; depends 3.1; verify targeted tests; rollback files.
- [x] 3.3 GREEN/REFACTOR: `src/registry/events.ts` requires chain, registry, intent, receipt, event and `ownerOf` before credential; verify registration+KYA tests; rollback watcher.

## Phase 4: Frontend and Verification

- [x] 4.1 RED: `tests/cdp-frontend.test.ts` mocks OTP→intent and asserts no SIWE/BrowserWallet imports; verify targeted Vitest; rollback test.
- [x] 4.2 GREEN: `package.json`, `web/src/main.tsx`, `web/src/App.tsx` wire CDP OTP, exchange, session, intent and UserOp; verify typecheck/build; rollback frontend/deps.
- [x] 4.3 REFACTOR/DOCS: remove dead imports; update `FLOW.md`, `docs/SOURCES.md`, examples; verify lint; rollback docs/cleanup.
- [x] 4.4 VERIFY: local `npm test`, lint, typecheck, build, demo, diff-check, and health harness pass; Base Sepolia smoke remains an authorized external rollout gate requiring OTP/KYC/user approval.

## Phase 5: Verification Remediation

- [x] 5.1 RED→GREEN: contract-test SDK `ownerAddresses`, enforce `typ=kya_session`, and reject inferred legacy CDP mappings in `src/auth`; verify CDP auth tests.
- [x] 5.2 RED→GREEN: orchestrate UserOp resolve polling and replay-safe event confirmation for event-before/after-resolution; verify registration integration tests.
- [x] 5.3 RED→GREEN: cover OTP invalid/replay/origin behavior, Smart Account provisioning, intent prerequisites/account mismatch, approval and sponsor/user denial without submission.
- [x] 5.4 REFACTOR/VERIFY: remove contradictory legacy docs, update cumulative TDD evidence, and run test/lint/typecheck/build/demo/diff-check/runtime health.

## Phase 6: Replay and Contract Remediation

- [x] 6.1 RED→GREEN: persist/retry unmatched registry events so event-before-resolution and event-after-resolution both bind exactly once; verify watcher integration.
- [x] 6.2 RED→GREEN: exercise the real CDP verifier/provider contracts and remaining OTP, provisioning, account-mismatch, intent, approval/denial, and duplicate HTTP scenarios.
- [x] 6.3 REFACTOR/VERIFY: remove remaining legacy documentation contradictions, update cumulative evidence, and rerun all local gates plus the event-order diagnostic.

## Phase 7: Final Evidence Gate

- [x] 7.1 RED→GREEN: require recorded intent, UserOp, resolved successful receipt, tx, event, and `ownerOf` for every registration; delete legacy event-only binding expectations.
- [x] 7.2 RED→GREEN: make Vite consume the repository `.env` public project ID and derive sponsorship readiness from actual configuration instead of unconditional true.
- [x] 7.3 REFACTOR/VERIFY: correct remaining FLOW/historical-wallet docs, update cumulative evidence, and rerun all focused/full gates.

## Phase 8: Credential Claim Recovery

- [x] 8.1 RED→GREEN: require UserOperation evidence before authenticated claim, then claim before exposing the challenge step; fail closed when claim fails.
- [x] 8.2 RED→GREEN: make authenticated claim idempotently preserve one valid active credential, and let the challenge action recover a bound enrollment after HMR without client-side credential storage.
- [x] 8.3 VERIFY: run focused frontend/registration integration tests, full suite, lint, typecheck, build, demo, diff-check, and live local health harness.
