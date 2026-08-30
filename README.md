# KYA — Know Your Agent

Local-agent authentication for buyer agents running on a user's PC. KYA binds a **pseudonymous verified Principal** to an **ERC-8004 Agent ID** on Base and to the agent's **local P-256 public key** (`cnf.jkt`). The current implementation covers that identity ceremony and a local mock Juno catalog search over PostgreSQL/pgvector. The next specified architecture removes Juno as the runtime catalog source: registered merchants will maintain their own feeds through ACP-compatible endpoints. Local AP2 mandate drafts (merchant JWT, Trusted Surface, policy, hash-only outbox) are in scope as a domain library; payment execution, settlement, and real chain writes remain out of scope.

**Authoritative product scope:** [`FLOW.md`](./FLOW.md)

## Status (honest)

| Claim | Meaning |
| --- | --- |
| **Code-complete** | Path implemented with tests |
| **Demo-verified** | `npm test` + `npm run demo:ceremony` pass on labeled demo path |
| **Live-not-executed** | Live wiring exists; CI does **not** run real KYC or public-chain writes |
| **Planned** | Product contract documented; no implementation is claimed |
| **Specified** | Technical contract is reviewable; implementation is not claimed |
| **Catalog-demo** | Offline fixture load + `POST /v1/catalog/search` verified locally when pgvector is provisioned |

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

## Juno catalog search (J0–J2)

A buyer agent can submit a natural-language query such as **“papas fritas”** and receive the most relevant products across merchants that accept Juno, with merchant, product, price, currency, availability, and catalog freshness included in every result. Search is intentionally unauthenticated in this slice; auth will be added later at the route boundary.

| Phase | Delivery | Status |
| --- | --- | --- |
| J0 | PostgreSQL schema + synthetic Juno dataset with merchants, products, prices, and availability | Code-complete |
| J1 | Offline ingestion that validates and normalizes catalog snapshots, then publishes HNSW/GIN indexes | Code-complete |
| J2 | Public `POST /v1/catalog/search` with filters and ranked, source-backed results | Code-complete |

PostgreSQL holds both responsibilities without becoming two databases. A minimal search projection stores `item_id`, name, description, item information, and the derived embedding; pgvector maintains HNSW as rows change. The offline pipeline still creates those embeddings and publishes each catalog version. Search embeds the query, over-fetches HNSW + lexical `item_id`s, then bulk-hydrates authoritative price, currency, merchant, and availability from the same transactional snapshot. Exact vector search is an observable fallback only after an explicit HNSW readiness/index failure. This extension discovers offers only—it does not place an order or execute a payment.

### Merchant-maintained ACP ingestion (implemented)

The target architecture keeps the search half above and replaces only the
catalog input/publication model. A registered merchant sends partial product
upserts to `PATCH /product_feeds/{feed_id}/products`. PostgreSQL commits current
price and stock immediately and writes a transactional outbox entry only when
searchable text must be re-embedded. A local worker updates the minimal pgvector
projection; HNSW, exact fallback, hybrid ranking, and bulk SQL hydration remain.
The target response removes global `catalog_version` and exposes per-item
`data_revision`, `search_revision`, and `index_revision`. This MVP accepts only
Argentina feeds, Spanish catalog content, and ARS prices.

For the MVP, each merchant is provisioned manually and receives an opaque API
key for server-to-server `Authorization: Bearer` requests. Only its hash and
merchant association are stored; the raw key is shown once and never logged.
The fail-closed authorizer derives feed ownership from that association and
remains separate from KYA. Merchant login, a self-service portal, OAuth, and
merchant KYC are out of scope. The boundary follows the official ACP Feeds and
Products surfaces, including idempotency and request tracing. See
[`docs/ACP_MERCHANT_CATALOG_INGESTION.md`](./docs/ACP_MERCHANT_CATALOG_INGESTION.md).

Local embeddings use `@huggingface/transformers` with `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384 dimensions). Query text is not sent to an external embedding API. Node.js 20 or newer is required; release evidence used Node 22 LTS. Tests inject `DeterministicEmbeddingProvider`; the loader can set `CATALOG_EMBEDDING_PROVIDER=deterministic` only for test fixtures.

```bash
npm run catalog:up   # docker-compose.catalog.yml pins pgvector/pgvector:0.8.1-pg16
CATALOG_DATABASE_URL=postgres://catalog:catalog@127.0.0.1:55432/juno_catalog npm run catalog:migrate
CATALOG_DATABASE_URL=postgres://catalog:catalog@127.0.0.1:55432/juno_catalog npm run catalog:provision -- merchant_acp_demo
# Optional: npm run catalog:revoke -- <api_key>
# Optional: npm run catalog:rotate -- <previous_api_key>
CATALOG_DATABASE_URL=postgres://catalog:catalog@127.0.0.1:55432/juno_catalog npm run catalog:worker
CATALOG_DATABASE_URL=postgres://catalog:catalog@127.0.0.1:55432/juno_catalog npm run catalog:harness
# Optional seed/test only: npm run catalog:load
```

Rollback without dropping SQL: set `CATALOG_ACP_ENABLED=false` and/or `CATALOG_WORKER_ENABLED=false`. The Juno fixture remains seed/test only; runtime search reads current-state rows.

The first load downloads the model; later inference is local from its cache. If a partial/corrupt local model cache prevents loading, remove that model cache and repeat the load. Then `POST /v1/catalog/search` against the API. If `CATALOG_DATABASE_URL` is unset, KYA routes stay up and catalog search returns `503 CATALOG_UNAVAILABLE`.

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
- File/JSON persistence for hackathon MVP identity state
- PostgreSQL 16 + pgvector 0.8.1 (`pgvector/pgvector:0.8.1-pg16`; `pg`, plain SQL migrations, `docker-compose.catalog.yml`)
- Local multilingual embeddings via `@huggingface/transformers`
- Vitest + ESLint

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
- [`docs/JUNO_CATALOG_SEARCH_SPEC.md`](./docs/JUNO_CATALOG_SEARCH_SPEC.md) — PostgreSQL schema, indexes, offline loader, and public search contract
- [`docs/ACP_MERCHANT_CATALOG_INGESTION.md`](./docs/ACP_MERCHANT_CATALOG_INGESTION.md) — merchant-owned ACP ingestion, outbox worker, and current-state search
- [`FLOW.md`](./FLOW.md) — product flow and acceptance checklist

## Scripts

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run demo:ceremony
npm run catalog:up
npm run catalog:migrate
npm run catalog:provision
npm run catalog:revoke
npm run catalog:rotate
npm run catalog:worker
npm run catalog:harness
npm run catalog:load
```


## AP2 mandate drafts (local domain library)

The domain library at `src/mandates` creates an immutable merchant ES256 Checkout JWT, its SHA-256 base64url hash, unsigned AP2 checkout/payment draft payloads, Trusted Surface activation, deterministic policy reservation, and a hash-only anchor outbox boundary. It does **not** create payments, final user-authorized processor charges, or real chain writes.

```bash
npm run mandates:create -- --input ./fixtures/validated-checkout.json
npm run contracts:compile
npm run contracts:test
```

`MERCHANT_SIGNING_PRIVATE_JWK` may provide a P-256 private JWK in development/test. Production rejects the local signer; inject a KMS/HSM `MerchantSigner` instead. CLI requires an explicit environment:

```bash
NODE_ENV=test npm run mandates:create -- --input ./fixtures/validated-checkout.json
```

## License

Private hackathon MVP.
