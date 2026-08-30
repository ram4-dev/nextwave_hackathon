# KYA — Know Your Agent

Local-agent authentication for buyer agents running on a user's PC. KYA binds a **pseudonymous verified Principal** to an **ERC-8004 Agent ID** on Base and to the agent's **local P-256 public key** (`cnf.jkt`). This build mocks the entire ceremony end-to-end for demo purposes: no real wallet, no real KYC provider, no on-chain writes. The next planned workstream adds a mock Juno merchant catalog and semantic product discovery. Real Juno connectivity, checkout, payment execution, settlement, and AP2 remain out of scope.

**Authoritative product scope (target design):** [`FLOW.md`](./FLOW.md)

## Status (honest)

This build is a **fully mocked demo** — every external effect (wallet sign-in, KYC verification, on-chain registration) is a labeled in-process stand-in. There is no live mode, no `KYA_MODE` flag, and no wiring to a real wallet, KYC provider, or chain in this codebase.

| Claim | Meaning |
| --- | --- |
| **Mocked** | Implemented and exercised by `npm test` / `npm run demo:ceremony`; no real external effect |
| **Planned** | Product contract documented in `FLOW.md`; not implemented in this codebase |

## What this build does

| Step | Delivery | Status |
| --- | --- | --- |
| Local agent key | P-256 WebCrypto key generation, thumbprint, fingerprint display | Mocked/real crypto — key never leaves the device |
| Human sign-in | Labeled mock session (`/v1/auth/login`) — no wallet, no SIWE | Mocked |
| KYC | Instant mock verification (`/v1/kyc/complete`) — no external provider | Mocked |
| Fingerprint approval | Confirms the enrolled public key before binding | Real (in-process) |
| Register | Assigns a display-plausible `agentId`/registry ref — no on-chain write | Mocked |
| Credential | Genuine ES256 JWS (`cnf.jkt`-bound) issued by the platform | Real (in-process) |
| Challenge / verify | Real signature challenge over the local CryptoKey | Real (in-process) |

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
cp .env.example .env
npm run dev            # API on :8787
npm run dev:web        # wizard on :5173 (proxies to API)
```

Open http://localhost:5173 and run the ceremony wizard, or run the deterministic CLI demo:

```bash
npm run demo:ceremony
```

## Stack

- TypeScript, Hono API, Vite + React wizard (`AgentKeyProvider` for CryptoKey handle)
- `viem` (address utilities only — no wallet, SIWE, or chain calls in this build)
- `jose` (ES256 JWS/JWT, RFC 7638 thumbprints)
- File/JSON persistence for hackathon MVP
- Vitest + ESLint
- Planned: provider-neutral embeddings and vector search for the Juno mock catalog

## Security boundaries

- KYC verifies **people only**; the mock KYC step never sees agent material.
- One verified Principal may authorize **multiple** agents; re-KYC only if missing/expired.
- Local private keys never leave the device; browser WebCrypto is **not** claimed as hardware proof.
- Registration is a labeled mock — no `msg.sender`, no gas, no chain write occurs in this build.
- Enrollment detail requires session + owner auth; public `/v1/resolve` has no PII.
- The Juno mock (planned) will use synthetic catalog data and no real provider credential.
- Agent identity and Principal data are not embedded in the catalog index.

## Curated Identity Registry (display-only reference)

The addresses below are the officially curated ERC-8004 Identity Registry contracts. This build only echoes the Sepolia address for display (`GET /v1/config`) — it performs no on-chain reads or writes and does not vendor the ABI.

| Network | Chain ID | Address |
| --- | --- | --- |
| Base Sepolia | 84532 | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| Base Mainnet | 8453 | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |

## Docs

- [`docs/IMPLEMENTATION.md`](./docs/IMPLEMENTATION.md) — architecture and status vocabulary for this mocked build
- [`docs/SOURCES.md`](./docs/SOURCES.md) — provenance for external references still in use
- [`docs/SKILLS.md`](./docs/SKILLS.md) — skill search/install inventory (2026-08-29)
- [`FLOW.md`](./FLOW.md) — target product flow and acceptance checklist (design reference; not all of it is implemented here)

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
