# KYA Implementation

## Architecture

```
Browser wizard (Vite/React)
  └─ AgentKeyProvider (CryptoKey ref) + demo|live SIWB / ceremony steps
        │
        ▼
Hono API (:8787)
  ├─ auth (SIWB nonce + viem verifySiweMessage; demo bypass labeled)
  ├─ enrollment / fingerprint / rotate / revoke / rebind / claim-credential
  ├─ public /v1/resolve (no PII)
  ├─ KYC adapters (demo only when KYA_MODE=demo | didit | incode | veriff)
  ├─ agentURI host (ERC-8004 registration-v1, no PII)
  ├─ credential issue/verify + JWKS
  ├─ challenge-response (ownerOf fail-closed in live)
  └─ paymaster proxy (capability URL from prepare-register; server-side secrets)
        │
        ▼
Domain + JSON repository (.kya-data)
  Principal · Enrollment · Credential · Nonce · KYC session · Event cursor · PaymasterCapability
        │
        ▼
Base (live only)
  Identity Registry curated · wallet_sendCalls from user Base Account
  watchContractEvent(Registered, Transfer): always Sepolia; Mainnet only when
  MAINNET_PROMOTION_ENABLED + MAINNET_REGISTRY_VERIFIED and getVersion === 2.0.0
```

### Domain states

**Enrollment:** `awaiting_device` → `awaiting_human` → (`awaiting_kyc`?) → `awaiting_fingerprint` → `awaiting_register` → `awaiting_onchain` → `bound` ⇄ `suspended` → `revoked`  
(`awaiting_fingerprint` → `bound` for key rotation / transfer rebind without minting a new Agent ID)

**KYC (person):** `pending` · `verified` · `needs_review` · `rejected` · `expired`

**Credential:** `active` · `suspended` · `revoked` · `expired`

Transfer of the ERC-721 Agent ID **suspends** binding until an active verified Principal (new owner) explicitly re-approves the fingerprint. Re-KYC only if that person lacks active verification.

## Status vocabulary (honest)

| Label | Meaning |
| --- | --- |
| **Code-complete** | Implementation + unit/integration tests exist for the path |
| **Demo-verified** | `npm test` + `npm run demo:ceremony` exercise the labeled demo path |
| **Live-not-executed** | Live connectors are wired but **not** run with real KYC credentials, chain writes, or paymaster calls in CI |

## F0–F5 matrix

| Phase | Status | Evidence |
| --- | --- | --- |
| F0 KYC + SIWB | Code-complete + demo-verified; live SIWB wired, live-not-executed | `src/kyc/*`, `src/auth/siwb.ts`, wizard |
| F1 Enrollment + Principal | Code-complete + demo-verified | `src/services/ceremony.ts` |
| F2 Registry register path | Code-complete (demo simulate / live encode + capability paymaster); live-not-executed | `src/registry/identity.ts`, `src/server/paymaster.ts` |
| F3 Events + JWS + challenge | Code-complete + demo-verified; live watcher wired, live-not-executed | `src/registry/events.ts`, `src/credentials/jws.ts`, `server/index.ts` |
| F4 Rotate/revoke + Incode/Veriff | Code-complete + demo-verified (rotation/rebind tests); live adapters live-not-executed | ceremony + `src/kyc/incode.ts`, `veriff.ts` |
| F5 Mainnet gate | Code-complete (flags + exact `getVersion === 2.0.0`; no hardcoded trust) | `SUPPORTED_IDENTITY_REGISTRY_VERSION`, `selectLiveWatcherChains` |

## Threat boundaries

| Threat | Mitigation |
| --- | --- |
| Relayer owns Agent NFT | User Base Account submits `register`; ownership checks via `ownerOf` |
| Copied JWT abuse | Bound to local key via `cnf.jkt`; challenges require private key |
| KYC PII leakage | Store session/provider refs + assurance only; strip from agentURI/JWS |
| Webhook forgery / replay | Provider-specific auth + eventId idempotency |
| Demo KYC in live | Adapter/routes forbid `demo` when `KYA_MODE=live` |
| Open paymaster relay | Capability URL from authenticated prepare-register; raw token never persisted (SHA-256 + scope metadata); sender/chain/callData containment before forward |
| Paymaster AA binding residual | Containment of registry + exact `register(agentURI)` calldata in userOp.callData — not full AA execute decode; provider policy must allowlist the registry |
| SIWB presentation | `parseSiweMessage` + `verifySiweMessage` (ERC-6492); domain/URI/chain/nonce/issuedAt/exp/notBefore; consume-after-valid |
| wallet_sendCalls shape | Checksummed `from` (owner) required per `@base-org/account` WalletSendCallsParams |
| Watcher confirmations | Pending queue + flush on callbacks/timer; `stop` clears pending |
| JWT alg confusion | ES256 allowlist only; reject `none` |
| Mainnet wrong address | Promotion flags **and** live code/`getVersion` (no hardcoded true) |
| Paymaster secret in browser | Capability-gated `/v1/paymaster/proxy` only |
| Platform signing private key | Demo: in-memory ephemeral. Live: fail-closed without injected JWK |
| Popup breakage | `Cross-Origin-Opener-Policy: same-origin-allow-popups` |

## Live configuration

1. Copy `.env.example` → `.env` (no placeholder secrets in code defaults).
2. Set `KYA_MODE=live`.
3. Set `BASE_SEPOLIA_RPC_URL` to a production Base RPC.
4. Set Didit `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID`, `DIDIT_WEBHOOK_SECRET`.
5. Point Didit webhooks to `POST /v1/kyc/webhooks/didit`.
6. Optionally enable `PAYMASTER_PROXY_ENABLED=true` and set server-only `PAYMASTER_URL` (browser receives capability URL only).
7. Set `KYA_SIGNING_PRIVATE_JWK` or `KYA_SIGNING_KEY_FILE`.
8. For Incode/Veriff, set their env vars and use `?provider=incode|veriff` (never `demo`).
9. Mainnet: verify curated address, confirm `getVersion` + bytecode, then set `MAINNET_REGISTRY_VERIFIED=true` and `MAINNET_PROMOTION_ENABLED=true`.

**Do not** run real KYC, chain txs, or paymaster calls from automated tests — mocks and encoding tests cover those paths.

## Demo wizard

`npm run dev` + `npm run dev:web` → http://localhost:5173

Demo steps are labeled. Live mode wires `baseAccount.ts` (SIWB + `wallet_sendCalls`) and never calls `confirm-demo`.

## Related docs

- [`FLOW.md`](../FLOW.md) — product source of truth
- [`SOURCES.md`](./SOURCES.md) — external provenance
- [`SKILLS.md`](./SKILLS.md) — skill search/install inventory (2026-08-29)
