# Design: CDP Embedded Wallet Onboarding

## Technical Approach

Replace the live SIWE/injected-wallet boundary with CDP React email OTP and `createOnLogin: "smart"`. The frontend exchanges a CDP access token once; a server adapter validates it, resolves the stable `userId` and sole Smart Account, and binds them to a Principal. Existing Hono middleware then authorizes by Principal ID. Registration remains user-approved in CDP, while server-side CDP status plus the existing viem watcher provide confirmation evidence.

## Architecture Decisions

| Decision | Alternatives | Rationale |
|---|---|---|
| `@coinbase/cdp-react` provider plus hooks; email only | Base Account, injected wallet, custom OTP | Official React lifecycle provisions the Smart Account without KYA custody. |
| `POST /v1/auth/cdp/exchange`; CDP token validated by `@coinbase/cdp-sdk` | Trust frontend user/address; reuse SIWE | `validateAccessToken` establishes `userId`; server selects `evmSmartAccountObjects`, verifies email auth and exactly one owner relationship. |
| ES256 KYA JWT: `sub=principalId`, `wallet`, `typ=kya_session`, 15-minute expiry; no refresh | CDP token on every API call; current 8-hour address subject | Preserves local middleware while limiting token exposure and re-checking the persisted binding on every request. |
| Frontend sends exact intent with `useSendUserOperation(... network:"base-sepolia", useCdpPaymaster:true)` and reports only `userOpHash` | Server signing; trusted frontend tx hash | Keeps approval/key custody with the user; Base Sepolia sponsorship is supported by CDP. |
| Server resolves UserOperation status, then viem validates receipt, registry event, intent and `ownerOf` | Treat hook success as final | Separates provider transport evidence from on-chain authorization evidence. |

## Data Flow and Sequences

```text
Auth: CDP OTP -> CDP Smart Account -> access token -> POST /v1/auth/cdp/exchange
      -> CdpIdentityVerifier -> Principal mapping -> short KYA JWT
Legacy /v1/auth/nonce and /v1/auth/verify -> 404 (no fallback)

Pairing: agent P-256 public JWK -> enrollment -> KYA session attach
         -> Didit KYC -> fingerprint approval (agent private key never leaves browser)

KYC: API -> Didit hosted session; Didit webhook -> signature verification
     -> normalized status -> Principal; callback -> navigation only -> frontend

ERC-8004: session -> registration-intent -> CDP user approval/UserOperation
          -> registration-submissions(userOpHash) -> CDP status resolver
          -> viem receipt + Registered + ownerOf -> credential issuance
```

## Components and File Changes

| Files | Action |
|---|---|
| `src/auth/cdp.ts`, `src/auth/session.ts` | Create verifier contract/adapter and Principal-bound JWT middleware helpers. |
| `src/auth/siwe.ts`, `web/src/browserWalletConnector.ts`, `tests/browser-wallet.test.ts` | Delete after migrating reusable session behavior. |
| `src/server/app.ts`, `src/config/env.ts` | Replace auth routes; add strict CORS and CDP config validation/public project ID. |
| `src/domain/types.ts`, `src/persistence/repository.ts`, `src/services/ceremony.ts` | Persist `cdpUserId`, Smart Account binding, intent, `userOpHash`, resolved tx hash; authorize by Principal. |
| `src/registry/events.ts`, `src/registry/identity.ts` | Require matching intent, receipt and Smart Account owner. |
| `web/src/main.tsx`, `web/src/App.tsx`, `package.json` | Install/configure CDP providers/hooks; replace wallet/SIWE UI and direct transaction flow. |
| `tests/kya.test.ts`, new `tests/cdp-auth.test.ts`, docs/config examples | Add contract/regression coverage and source/config guidance. |

## Interfaces, Failure Handling, Security, Observability

`CdpIdentityVerifier.validate(token) -> { userId, emailAuthenticated, smartAccountAddress, ownerAddresses }`; `UserOperationStatusProvider.resolve(userOpHash, smartAccountAddress) -> { status, transactionHash? }`. Invalid/wrong-project tokens, absent/ambiguous accounts, binding conflicts, CDP outage, sponsorship denial, stale intents, mismatched UserOps, failed receipts, and owner changes fail without mutation or credentials. Never persist/log email, OTP, CDP token, API secret, or provider error objects. Emit structured events with request ID, Principal ID, enrollment ID, outcome/error code, latency and redacted `userOpHash`; expose dependency health separately.

## Testing Strategy

Strict TDD: unit-test CDP normalization, JWT alg/issuer/audience/expiry, mapping conflicts, and UserOp state; integration-test routes, CORS, idempotency, KYC preservation, and watcher mismatch/replay; mocked browser journey tests OTP-to-intent. One authorized Base Sepolia smoke remains a rollout gate, not CI.

## Threat Matrix

HTTP routing changes, but no execution/VCS boundary exists: documentation-like paths, Git repository selection, commit state, push state, and PR commands are each **N/A** because this design neither classifies executable files nor invokes shell, subprocess, Git, or PR automation.

## Migration / Rollout

Add optional fields when reading existing JSON; never infer `cdpUserId` or remap an old owner. Existing public credentials remain verifiable, but live human recovery requires an explicit reconciled CDP mapping. Deploy backend compatibility first, then CDP frontend, remove SIWE in the same release, run tests/build/demo and one Base Sepolia smoke; rollback to the prior tagged release while retaining additive fields.

## Task-Planning Inputs and Risks

- Required: `VITE_CDP_PROJECT_ID`, Portal allowed frontend domain, API key ID/secret, Base Sepolia RPC, and CDP paymaster contract allowlist.
- Confirm the installed CDP SDK's read-only UserOperation lookup method before coding; isolate it behind the provider contract.
- Risks: CDP SDK drift/outage, multiple Smart Accounts, sponsorship policy mismatch, and existing Principal reconciliation.

## Sources

- <https://docs.cdp.coinbase.com/wallets/authentication/implementation-guide>
- <https://docs.cdp.coinbase.com/wallets/using-wallets/smart-accounts>
- <https://docs.cdp.coinbase.com/api-reference/v2/rest-api/end-user-accounts/validate-end-user-access-token>
- <https://docs.base.org/get-started/connect-to-base>
- <https://viem.sh/docs/actions/public/waitForTransactionReceipt>
- <https://eips.ethereum.org/EIPS/eip-4337>; <https://eips.ethereum.org/EIPS/eip-8004>
