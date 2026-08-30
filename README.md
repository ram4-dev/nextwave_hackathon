# KYA — Know Your Agent

Local-agent authentication for buyer agents running on a user's PC. KYA binds a **pseudonymous verified Principal** to an **ERC-8004 Agent ID** on Base and to the agent's **local P-256 public key** (`cnf.jkt`). The current implementation covers that identity ceremony; the next planned workstream adds a mock Juno merchant catalog and semantic product discovery. Real Juno connectivity, checkout, payment execution, settlement, and AP2 remain out of scope.

**Authoritative product scope:** [`FLOW.md`](./FLOW.md)

## Status (honest)

| Claim | Meaning |
| --- | --- |
| **Code-complete** | Path implemented with tests |
| **Demo-verified** | `npm test` + `npm run demo:ceremony` pass on labeled demo path |
| **Live-not-executed** | Live wiring exists; CI does **not** run real KYC or public-chain writes |
| **Planned** | Product contract documented; no implementation is claimed |

Default `KYA_MODE=demo`. Live connectors stay disabled until env is configured.

## What the current MVP does (F0–F5)

| Phase | Delivery | Status |
| --- | --- | --- |
| F0 | KYC adapters + browser wallet SIWE (demo bypass labeled; live viem verify) | Code-complete + demo-verified; live-not-executed |
| F1 | Device enrollment + fingerprint + Principal | Code-complete + demo-verified |
| F2 | Direct browser-wallet `register(agentURI)` with simulate-before-write | Code-complete; live-not-executed |
| F3 | Event watchers + JWS + challenge (`ownerOf` fail-closed) | Code-complete + demo-verified; live watcher wired |
| F4 | Rotation / transfer rebind + Incode/Veriff adapters | Code-complete + demo-verified |
| F5 | Mainnet gate (flags + live code/`getVersion`) | Code-complete |

## Planned Juno catalog extension (J0–J2)

The target experience is that an authenticated buyer agent can submit a natural-language query such as **“papas fritas”** and receive the most relevant products across merchants that accept Juno, with merchant, product, price, currency, availability, and catalog freshness included in every result.

| Phase | Delivery | Status |
| --- | --- | --- |
| J0 | Mock Juno API with merchants, Juno acceptance, products, prices, and availability | Planned |
| J1 | Offline ingestion that validates and normalizes catalog snapshots, then publishes a versioned vector index | Planned |
| J2 | Agent-facing semantic search with optional structured filters and ranked, source-backed results | Planned |

The structured catalog snapshot remains the source of truth. Embeddings and the vector index are derived, rebuildable search artifacts; exact fields such as price, currency, merchant, and availability are never inferred by the model. This extension discovers offers only—it does not place an order or execute a payment.

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
- `viem` (EIP-1193 browser wallet, SIWE, Base Sepolia/Mainnet reads)
- `jose` (ES256 JWS/JWT, RFC 7638 thumbprints)
- File/JSON persistence for hackathon MVP
- Vitest + ESLint
- Planned: provider-neutral embeddings and vector search for the Juno mock catalog

## Security boundaries

- KYC verifies **people only**; providers never see the agent.
- `KYA_MODE=live` forbids demo KYC adapter, demo webhooks, and demo completion bypass.
- One verified Principal may authorize **multiple** agents; re-KYC only if missing/expired.
- Local private keys never leave the device; browser WebCrypto is **not** claimed as hardware proof.
- `register(agentURI)` is simulated and submitted by the **authenticated browser wallet** — KYA is never `msg.sender`.
- The same address signs SIWE, owns the verified Principal, submits the transaction, and must match `ownerOf` before credential issuance.
- The user wallet needs Base Sepolia ETH for gas; the MVP does not sponsor transactions.
- Enrollment detail requires session + owner auth; public `/v1/resolve` has no PII.
- `accountsChanged`, `chainChanged`, and `disconnect` invalidate sensitive live steps.
- The Juno mock uses synthetic catalog data and no real provider credential.
- Agent identity and Principal data are not embedded in the catalog index.

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
- [`docs/BROWSER_WALLET_MIGRATION_SPEC.md`](./docs/BROWSER_WALLET_MIGRATION_SPEC.md) — accepted and implemented wallet migration
- [`FLOW.md`](./FLOW.md) — product flow and acceptance checklist

## Scripts

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run demo:ceremony
```

## License

Private hackathon MVP.
