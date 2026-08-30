# KYA Implementation

## Architecture

```
Browser wizard (Vite/React)
  ├─ AgentKeyProvider (in-memory CryptoKey ref)
  └─ BrowserWalletConnector (EIP-6963 discovery + selected EIP-1193 provider)
        │
        ▼
Hono API (:8787)
  ├─ auth (SIWE nonce + viem verifySiweMessage; demo bypass labeled)
  ├─ enrollment / fingerprint / rotate / revoke / rebind / claim-credential
  ├─ public /v1/resolve (no PII)
  ├─ KYC adapters (demo only when KYA_MODE=demo | didit | incode | veriff)
  ├─ agentURI host (ERC-8004 registration-v1, no PII)
  ├─ credential issue/verify + JWKS
  └─ challenge-response (ownerOf fail-closed in live)
        │
        ▼
Domain + JSON repository (.kya-data)
  Principal · Enrollment · Credential · Nonce · KYC session · Event cursor
        │
        ▼
Base (live only)
  Identity Registry curated · simulateContract + writeContract from browser wallet
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
| **Live-not-executed** | Live connectors are wired but **not** run with real KYC credentials or public-chain writes in CI |

## F0–F5 matrix

| Phase | Status | Evidence |
| --- | --- | --- |
| F0 KYC + SIWE | Code-complete + demo-verified; live SIWE wired, live-not-executed | `src/kyc/*`, `src/auth/siwe.ts`, wizard |
| F1 Enrollment + Principal | Code-complete + demo-verified | `src/services/ceremony.ts` |
| F2 Registry register path | Code-complete (demo simulation / live intent validation + simulate-before-write); live-not-executed | `src/registry/identity.ts`, `web/src/browserWalletConnector.ts` |
| F3 Events + JWS + challenge | Code-complete + demo-verified; live watcher wired, live-not-executed | `src/registry/events.ts`, `src/credentials/jws.ts`, `server/index.ts` |
| F4 Rotate/revoke + Incode/Veriff | Code-complete + demo-verified (rotation/rebind tests); live adapters live-not-executed | ceremony + `src/kyc/incode.ts`, `veriff.ts` |
| F5 Mainnet gate | Code-complete (flags + exact `getVersion === 2.0.0`; no hardcoded trust) | `SUPPORTED_IDENTITY_REGISTRY_VERSION`, `selectLiveWatcherChains` |

## Threat boundaries

| Threat | Mitigation |
| --- | --- |
| Platform owns Agent NFT | Authenticated browser wallet submits `register`; ownership checks via `ownerOf` |
| Copied JWT abuse | Bound to local key via `cnf.jkt`; challenges require private key |
| KYC PII leakage | Store session/provider refs + assurance only; strip from agentURI/JWS |
| Webhook forgery / replay | Provider-specific auth + eventId idempotency |
| Demo KYC in live | Adapter/routes forbid `demo` when `KYA_MODE=live` |
| Wrong injected provider | EIP-6963 explicit selection; one provider object reused for connect/sign/simulate/write |
| SIWE presentation | `parseSiweMessage` + `verifySiweMessage`; exact domain/URI/address/Base Sepolia/nonce/time fields; consume-after-valid |
| Registration tampering | Compare owner, chain, curated registry, zero value, and independently encoded calldata before simulation/write |
| Wallet lifecycle change | Account/network/disconnect events invalidate the session or prepared write and require reauthentication |
| Watcher confirmations | Pending queue + flush on callbacks/timer; `stop` clears pending |
| JWT alg confusion | ES256 allowlist only; reject `none` |
| Mainnet wrong address | Promotion flags **and** live code/`getVersion` (no hardcoded true) |
| Platform signing private key | Demo: in-memory ephemeral. Live: fail-closed without injected JWK |
| RPC credential exposure | Browser uses the selected provider transport; backend RPC remains server-side |

## Live configuration

1. Copy `.env.example` → `.env` (no placeholder secrets in code defaults).
2. Set `KYA_MODE=live`.
3. Set `BASE_SEPOLIA_RPC_URL`. Local testing may use the official rate-limited `https://sepolia.base.org`; production must use a dedicated Base RPC.
4. Set `SIWE_DOMAIN` and `SIWE_URI` to the exact public browser origin and `/app/` URI.
5. Set Didit `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID`, `DIDIT_WEBHOOK_SECRET`.
6. Point Didit webhooks to `POST /v1/kyc/webhooks/didit`.
7. Set exactly one signing source: Vault-injected `KYA_SIGNING_PRIVATE_JWK`, or `KYA_SIGNING_KEY_FILE` pointing to a secret-mounted ES256 private JWK. Never commit the key.
8. Fund the browser wallet with Base Sepolia ETH for registration gas.
9. For Incode/Veriff, set their env vars and use `?provider=incode|veriff` (never `demo`).
10. Mainnet: verify curated address, confirm `getVersion` + bytecode, then set `MAINNET_REGISTRY_VERIFIED=true` and `MAINNET_PROMOTION_ENABLED=true`.

**Do not** run real KYC or public-chain writes from automated tests — provider mocks and encoding tests cover those paths.

## Demo wizard

`npm run dev` + `npm run dev:web` → http://localhost:5173

Demo steps are labeled. Live mode wires `BrowserWalletConnector` (SIWE + direct
registry transaction), requires Base Sepolia, and never calls `confirm-demo`.

## Related docs

- [`FLOW.md`](../FLOW.md) — product source of truth
- [`SOURCES.md`](./SOURCES.md) — external provenance
- [`SKILLS.md`](./SKILLS.md) — skill search/install inventory (2026-08-29)
