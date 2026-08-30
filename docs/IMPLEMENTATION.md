# KYA Implementation

## CDP user-wallet custody boundary

KYA uses CDP **end-user authentication**, not an API-key/server wallet: email
OTP plus `createOnLogin: "smart"` creates an embedded EOA and its Smart Account
for the person after successful login. The Smart Account is the only address
that KYA binds to the pseudonymous Principal and the only sender accepted for
ERC-8004 registration. The app and KYA backend never receive its raw private
key, seed phrase, Temporary Wallet Secret, or Wallet Secret.

CDP performs key generation and signing within its TEE. A user may export its
own wallet only through CDP's isolated secure iframe; host-app JavaScript does
not receive the raw key. API-key/server wallets, imported application keys, and
backend pre-login end-user generation are deliberately rejected for this flow:
they would change the owner/custody model before EWL-001 authentication.

The backend's CDP API credentials validate the opaque end-user access token;
they do not authorize KYA to sign the user's UserOperation. Sponsorship uses
CDP Portal policy and `useCdpPaymaster: true`, never a Vite paymaster URL.

## Architecture

```
Browser wizard (Vite/React) — reference API client
  ├─ AgentKeyProvider + IndexedDB CryptoKey handle (never localStorage private JWK)
  └─ CDP email OTP → exchange → Principal session (`KYA-HUMAN-SESSION+JWT`)
        │
        ▼
Hono API (:8787)
  ├─ POST /v1/auth/cdp/exchange
  ├─ POST /v1/device-enrollments (+ claim / token poll; hashed codes; no attach bypass)
  ├─ KYC sessions/status; GET /v1/kyc/callback 303; signed webhook authority
  ├─ CDP registration-intent / submissions / resolve + viem watcher
  ├─ challenge → ≤10m DPoP-bound access JWT (typ KYA-AGENT-ACCESS+JWT)
  ├─ requireAgentAuth + GET /v1/agent/me
  ├─ GET /health (liveness) · GET /ready (deps/schema)
  └─ catalog search / ACP (unchanged Juno slice)
        │
        ▼
Persistence: InMemory (tests) · JSON (local demo) · Supabase service-role (live shared)
  Never silently fall back from Supabase to JSON
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

## Local Juno catalog workflow

The catalog is a synthetic, offline Juno mock: 10 Spanish offers from Argentine
merchants, priced in ARS. It is independent of `KyaStore`, has no real Juno
API credentials, and exposes only public `POST /v1/catalog/search`; auth is
intentionally deferred.

Node.js 20+ is required (release evidence used Node 22 LTS). The server and
loader must use the same `CATALOG_EMBEDDING_MODEL`; its default is the local
384-d `Xenova/paraphrase-multilingual-MiniLM-L12-v2` provider. The first load
may download that model, while subsequent query inference reads the local cache.

```bash
npm run catalog:up
CATALOG_DATABASE_URL=postgres://catalog:catalog@127.0.0.1:55432/juno_catalog npm run catalog:migrate
CATALOG_DATABASE_URL=postgres://catalog:catalog@127.0.0.1:55432/juno_catalog npm run catalog:load
CATALOG_DATABASE_URL=postgres://catalog:catalog@127.0.0.1:55432/juno_catalog npm run dev
curl -sS -X POST http://127.0.0.1:8787/v1/catalog/search \
  -H 'content-type: application/json' \
  --data '{"query":"papas fritas","top_k":5}'
```

The loader persists only the searchable projection (`item_id`, name,
description, `item_info`, embedding); price, currency, availability and
merchant data remain authoritative SQL rows and are bulk-hydrated after
retrieval. pgvector HNSW is the primary path. Exact vector search is used only
when the explicit HNSW readiness probe says the index is unavailable; query or
database failures return a sanitized error and never silently fall back.

## ACP merchant ingestion (implemented)

Registered merchants maintain feeds through ACP Feeds/Products. A valid PATCH
commits current price and stock, assigns per-item revisions, and enqueues
searchable text to a durable outbox. `catalog:worker` claims that outbox with
`FOR UPDATE SKIP LOCKED`, embeds locally, and upserts only if `search_revision`
is still current. Public search hydrates SQL current-state rows and returns
`data_revision`, `search_revision`, and `index_revision` without
`catalog_version`. The Juno fixture is seed/test only. Pause routes or the
worker with `CATALOG_ACP_ENABLED=false` / `CATALOG_WORKER_ENABLED=false`
without dropping SQL. Optional `CATALOG_ACP_RATE_LIMIT` caps in-process ACP
mutations per merchant. Manual key revoke/rotate: `catalog:revoke` and
`catalog:rotate`. See
[`ACP_MERCHANT_CATALOG_INGESTION.md`](./ACP_MERCHANT_CATALOG_INGESTION.md).

## F0–F5 matrix

| Phase | Status | Evidence |
| --- | --- | --- |
| F0 KYC + CDP OTP | Code-complete + demo-verified; live token validation wired, live-not-executed | `src/kyc/*`, `src/auth/cdp.ts`, `src/auth/session.ts`, wizard |
| F1 Enrollment + Principal | Code-complete + demo-verified | `src/services/ceremony.ts` |
| F2 Registry register path | Code-complete (demo simulation / live Smart Account intent + UserOperation evidence); live-not-executed | `src/registry/identity.ts`, `web/src/CdpAuth.tsx`, wizard |
| F3 Events + JWS + challenge | Code-complete + demo-verified; live watcher wired, live-not-executed | `src/registry/events.ts`, `src/credentials/jws.ts`, `server/index.ts` |
| F4 Rotate/revoke + Incode/Veriff | Code-complete + demo-verified (rotation/rebind tests); live adapters live-not-executed | ceremony + `src/kyc/incode.ts`, `veriff.ts` |
| F5 Mainnet gate | Code-complete (flags + exact `getVersion === 2.0.0`; no hardcoded trust) | `SUPPORTED_IDENTITY_REGISTRY_VERSION`, `selectLiveWatcherChains` |

## Threat boundaries

| Threat | Mitigation |
| --- | --- |
| Platform owns Agent NFT | CDP Smart Account submits `register`; exact UserOperation/receipt/event/`ownerOf` checks gate binding |
| Copied JWT abuse | Bound to local key via `cnf.jkt`; challenges require private key |
| Token-class confusion | Human session, identity credential, and agent access JWT use distinct protected `typ`, audience, and verifier contracts |
| Pairing by guessed agent UUID | Only `device-enrollments/claim` may bind a Principal and it must consume the hashed one-time `user_code` |
| Invalid challenge triggers chain RPC | Nonce bindings and P-256 signature are validated before `ownerOf` |
| Challenge burned without token | Nonce consumption and access-token metadata append share one repository lock/CAS |
| KYC PII leakage | Store session/provider refs + assurance only; strip from agentURI/JWS |
| Webhook forgery / replay | Provider-specific auth + eventId idempotency |
| Demo KYC in live | Adapter/routes forbid `demo` when `KYA_MODE=live` |
| OTP/token abuse | CDP validates OTP; KYA validates opaque access token server-side, stores no email/OTP/token, and issues a short session |
| Registration tampering | Require CDP status `complete`, matching non-reverted receipt, exact transaction, curated registry, intent, event, and `ownerOf` |
| Wallet lifecycle change | CDP reauthentication resolves the same user/Smart Account binding or fails closed |
| Watcher confirmations | Pending queue + flush on callbacks/timer; unresolved matching `Registered` evidence is durably retried after restart and bounded by age/count |
| JWT alg confusion | ES256 allowlist only; reject `none` |
| Mainnet wrong address | Promotion flags **and** live code/`getVersion` (no hardcoded true) |
| Platform signing private key | Demo: in-memory ephemeral. Live: fail-closed without injected JWK |
| RPC credential exposure | Browser uses the selected provider transport; backend RPC remains server-side |

## Live configuration

1. Copy `.env.example` → `.env` (no placeholder secrets in code defaults).
2. Set `KYA_MODE=live`.
3. Set `BASE_SEPOLIA_RPC_URL`. Local testing may use the official rate-limited `https://sepolia.base.org`; production must use a dedicated Base RPC.
4. Set `FRONTEND_ORIGIN` to the exact public browser origin and configure that domain in CDP Portal.
5. Set Didit `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID`, `DIDIT_WEBHOOK_SECRET`.
6. Point Didit webhooks to `POST /v1/kyc/webhooks/didit`.
7. Set exactly one signing source: Vault-injected `KYA_SIGNING_PRIVATE_JWK`, or `KYA_SIGNING_KEY_FILE` pointing to a secret-mounted ES256 private JWK. Never commit the key.
8. Configure CDP Portal sponsorship for the registry call; the browser never receives a paymaster URL.
9. For Incode/Veriff, set their env vars and use `?provider=incode|veriff` (never `demo`).
10. Mainnet: verify curated address, confirm `getVersion` + bytecode, then set `MAINNET_REGISTRY_VERIFIED=true` and `MAINNET_PROMOTION_ENABLED=true`.

**Do not** run real KYC or public-chain writes from automated tests — provider mocks and encoding tests cover those paths.

## Demo wizard

`npm run dev` + `npm run dev:web` → http://localhost:5173

Demo steps are labeled. Live mode uses CDP email OTP and one sponsored Base
Sepolia Smart Account UserOperation, and never calls `confirm-demo`.

## Related docs

- [`FLOW.md`](../FLOW.md) — product source of truth
- [`SOURCES.md`](./SOURCES.md) — external provenance
- [`SKILLS.md`](./SKILLS.md) — skill search/install inventory (2026-08-29)
