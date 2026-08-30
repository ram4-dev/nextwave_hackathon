# KYA — Know Your Agent

Local-agent authentication for buyer agents running on a user's PC. KYA binds a **pseudonymous verified Principal** to an **ERC-8004 Agent ID** on Base and to the agent's **local P-256 public key** (`cnf.jkt`). It also includes a local-only first phase for AP2 checkout/payment **drafts**; it does not create payments or final user-signed mandates.

**Authoritative product scope:** [`FLOW.md`](./FLOW.md)

## Status (honest)

| Claim | Meaning |
| --- | --- |
| **Code-complete** | Path implemented with tests |
| **Demo-verified** | `npm test` + `npm run demo:ceremony` pass on labeled demo path |
| **Live-not-executed** | Live wiring exists; CI does **not** run real KYC, chain writes, or paymaster calls |

Default `KYA_MODE=demo`. Live connectors stay disabled until env is configured.

## What this MVP does (F0–F5)

| Phase | Delivery | Status |
| --- | --- | --- |
| F0 | KYC adapters + SIWB (demo bypass labeled; live viem verify) | Code-complete + demo-verified; live-not-executed |
| F1 | Device enrollment + fingerprint + Principal | Code-complete + demo-verified |
| F2 | `wallet_sendCalls` encoding + capability-gated paymaster proxy | Code-complete; live-not-executed |
| F3 | Event watchers + JWS + challenge (`ownerOf` fail-closed) | Code-complete + demo-verified; live watcher wired |
| F4 | Rotation / transfer rebind + Incode/Veriff adapters | Code-complete + demo-verified |
| F5 | Mainnet gate (flags + live code/`getVersion`) | Code-complete |

## Quick start

```bash
npm install
cp .env.example .env   # names only; keep KYA_MODE=demo
npm run dev            # API on :8787
npm run dev:web        # wizard on :5173 (proxies to API)
```

Open http://localhost:5173 and run the ceremony wizard, or:

```bash
npm run demo:ceremony
```

## Stack

- TypeScript, Hono API, Vite + React wizard (`AgentKeyProvider` for CryptoKey handle)
- `viem` (Base Sepolia/Mainnet), `@base-org/account` (live SIWB / sendCalls)
- `jose` (ES256 JWS/JWT, RFC 7638 thumbprints)
- File/JSON persistence for hackathon MVP
- Vitest + ESLint

## Security boundaries

- KYC verifies **people only**; providers never see the agent.
- `KYA_MODE=live` forbids demo KYC adapter, demo webhooks, and demo completion bypass.
- One verified Principal may authorize **multiple** agents; re-KYC only if missing/expired.
- Local private keys never leave the device; browser WebCrypto is **not** claimed as hardware proof.
- `register(agentURI)` is submitted by the **user's Base Account** — KYA is never `msg.sender`.
- Paymaster proxy requires a short-lived capability from authenticated `prepare-register`.
- Enrollment detail requires session + owner auth; public `/v1/resolve` has no PII.
- COOP: `same-origin-allow-popups` for Base Account popups.

## Curated Identity Registry

| Network | Chain ID | Address |
| --- | --- | --- |
| Base Sepolia | 84532 | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| Base Mainnet | 8453 | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (promotion gate) |

ABI: [`abis/IdentityRegistry.json`](./abis/IdentityRegistry.json) from [erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts).

## Docs

- [`docs/IMPLEMENTATION.md`](./docs/IMPLEMENTATION.md) — architecture, status vocabulary, live config
- [`docs/SOURCES.md`](./docs/SOURCES.md) — provenance for every external dependency
- [`docs/SKILLS.md`](./docs/SKILLS.md) — skill search/install inventory (2026-08-29)
- [`FLOW.md`](./FLOW.md) — product flow and acceptance checklist

## Scripts

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run demo:ceremony
npm run demo:purchase
```

## AP2 mandate drafts (phase 1)

The domain library at `src/mandates` creates an immutable merchant ES256 Checkout JWT, its SHA-256 base64url hash, and unsigned AP2 checkout/payment draft payloads. Every boundary is strict Zod validation: integer minor units only, ISO 4217 currency, HTTP(S) merchant/payee URLs, total reconciliation, expiry, JWT/hash verification, opaque masked payment references, and per-transaction nonce replay prevention.

```bash
npm run mandates:create -- --input ./fixtures/validated-checkout.json
```

The input fixture is intentionally fake. `MERCHANT_SIGNING_PRIVATE_JWK` may provide a P-256 private JWK in development/test. Without it, development/test generates a process-local key; production rejects the local signer and requires an injected `MerchantSigner` backed by the deployment's secret provider or HSM. To print JWTs in an explicit development/test session only, set `MANDATES_ALLOW_FULL_OUTPUT=true`; normal output is redacted. Local replay metadata goes to ignored `.mandate-artifacts/` and contains no JWTs, payment credentials, or private keys.

See [`docs/AP2_MANDATES.md`](./docs/AP2_MANDATES.md) for flow and integration boundaries.
For the local JSON data model and the configuration needed before a blockchain anchor, see [`docs/AP2_IMPLEMENTATION_SETUP.md`](./docs/AP2_IMPLEMENTATION_SETUP.md).

## AP2 purchase demo

`npm run demo:purchase` is the complete offline demonstration: it creates a KYA-bound demo agent, signs a merchant checkout, obtains two explicit EIP-712 approvals, evaluates trust/policy, and emits closed-mandate hashes. It performs no merchant, Yuno, Supabase, or blockchain write.

In `KYA_MODE=demo`, the same flow is reachable over the protected `/v1/mandates/*` routes. These routes are intentionally process-local and demo-only: they use a demo ES256 agent signer, a local merchant signer, in-memory mandates/policies, and explicit demo tenant/risk adapters. They must not be enabled for production.

## License

Private hackathon MVP.
