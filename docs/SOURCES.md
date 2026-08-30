# Sources & provenance

Retrieval date for existing entries: **2026-08-29**. ACP entries were retrieved
**2026-08-30**. Marked **generated/demo** where data is synthetic.

| Topic | Authoritative URL / value | What depends on it |
| --- | --- | --- |
| EIP-8004 (Identity Registry, registration-v1) | https://eips.ethereum.org/EIPS/eip-8004 | `agent-uri/document.ts` `type` field; registry semantics |
| Official contracts repo | https://github.com/erc-8004/erc-8004-contracts | ABI provenance; curated addresses |
| Official contracts master commit (verified 2026-08-29) | `b9e466c250744a7e06b13dff9d3c2844ed64f825` | Pin for vendored IdentityRegistry ABI |
| IdentityRegistry ABI (pinned raw) | https://raw.githubusercontent.com/erc-8004/erc-8004-contracts/b9e466c250744a7e06b13dff9d3c2844ed64f825/abis/IdentityRegistry.json | `abis/IdentityRegistry.json`, `registry/identity.ts` encode/read |
| IdentityRegistry ABI integrity | SHA-256 `cdb8e30f41a56ed53421126dab87551ff2a178b8463646f69f75bc5dc9620564` · 19561 bytes | Vendored file must match; verified identical to pin on 2026-08-29 |
| IdentityRegistry Base Sepolia 84532 | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `config/env.ts`, registry resolve, docs |
| IdentityRegistry Base Mainnet 8453 | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | Mainnet gate only |
| Identity Registry `getVersion` (read-only live check 2026-08-29) | Sepolia `0x8004A818…BD9e`: proxy code **130 bytes**, `getVersion()` = **`2.0.0`**. Mainnet `0x8004A169…a432`: proxy code **130 bytes**, `getVersion()` = **`2.0.0`**. No chain writes performed. | `SUPPORTED_IDENTITY_REGISTRY_VERSION`; F5 exact-equality readiness gate |
| Supported Identity Registry version | **`2.0.0`** (exact match required; non-empty alone fails closed) | `verifyRegistryReady`, `assertRegistryReadyForChain`, mainnet promotion |
| Base Sepolia network/RPC | https://docs.base.org/get-started/connect-to-base | Chain ID `84532`; official public development RPC `https://sepolia.base.org` (rate-limited, not production) |
| EIP-1193 provider API | https://eips.ethereum.org/EIPS/eip-1193 | Selected injected provider request API, lifecycle events, and error codes |
| EIP-6963 provider discovery | https://eips.ethereum.org/EIPS/eip-6963 | Multi-wallet discovery, deduplication, and explicit user selection |
| ERC-4361 Sign-In with Ethereum | https://eips.ethereum.org/EIPS/eip-4361 | Canonical SIWE message fields and verification contract |
| EIP-3085 add chain | https://eips.ethereum.org/EIPS/eip-3085 | `wallet_addEthereumChain` Base Sepolia metadata |
| EIP-3326 switch chain | https://eips.ethereum.org/EIPS/eip-3326 | `wallet_switchEthereumChain` Base Sepolia transition |
| viem Wallet Client | https://viem.sh/docs/clients/wallet | `custom(selectedProvider)`, message signing, and browser-wallet writes |
| viem `watchContractEvent` | https://viem.sh/docs/contract/watchContractEvent | `registry/events.ts` |
| viem `simulateContract` | https://viem.sh/docs/contract/simulateContract | Live registration path guidance |
| viem `writeContract` | https://viem.sh/docs/contract/writeContract | Direct write from the authenticated browser wallet after simulation |
| Didit create session | https://docs.didit.me/sessions-api/create-session | `kyc/didit.ts` createSession |
| Didit webhooks | https://docs.didit.me/integration/webhooks | `X-Signature-V2` = HMAC-SHA256(canonical sorted Unicode JSON); `X-Signature` = HMAC over exact rawBody; require `X-Timestamp` ±300s; reject `X-Signature-Simple` and undocumented aliases for KYA |
| Incode backend integrate | https://developer.incode.com/integrate-by-platform/backend/ | `kyc/incode.ts` session start mapping |
| Incode onboarding status webhook | https://developer.incode.com/docs/onboarding-status-webhook | Lifecycle statuses; `ONBOARDING_FINISHED` ≠ approval |
| Incode webhook overview (custom headers) | https://developer.incode.com/general-reference/webhooks-overview/ | Dashboard static custom secret headers (not HMAC) |
| Incode webhook OAuth2 client-credentials | https://developer.incode.com/general-reference/authorizing-webhooks-requests/ | Incode obtains Bearer via client_credentials; `oauth_bearer` mode |
| Incode Fetch scores (GET) | https://developer.incode.com/api-reference/get-score/ (also https://developer.incode.com/reference/getscores) | `GET /omni/get/score?id={interviewId}`; headers `api-version: 1.0`, `x-api-key`, `X-Incode-Hardware-Id` or `Authorization: Bearer` |
| Incode overall.status mapping | OK/MANUAL_OK→verified · WARN/MANUAL/MANUAL_PENDING→needs_review · FAIL/MANUAL_FAIL→rejected · UNKNOWN→pending | `normalizeIncodeOverallStatus`; raw score discarded |
| Incode webhook lifecycle statuses | `MANUAL_REVIEW_APPROVED`→verified · `MANUAL_REVIEW_REJECTED`→rejected · `EXPIRED`→expired · `ONBOARDING_FINISHED`→fetch score | `INCODE_STATUS_MAP` |
| Veriff v1 sessions | https://devdocs.veriff.com/apidocs/v1sessions | `kyc/veriff.ts` createSession |
| Veriff webhooks guide | https://devdocs.veriff.com/docs/webhooks-guide | Veriff status normalization |
| Veriff HMAC auth | https://devdocs.veriff.com/v1/docs/hmac-authentication-and-endpoint-security | Veriff webhook/request HMAC |
| jose | https://github.com/panva/jose | JWS issue/verify, JWK thumbprints |
| RFC 7519 (JWT) | https://www.rfc-editor.org/rfc/rfc7519 | Credential claim set |
| RFC 7638 (JWK thumbprint) | https://www.rfc-editor.org/rfc/rfc7638 | `cnf.jkt` |
| Web Crypto API | https://www.w3.org/TR/WebCryptoAPI/ | Local P-256 key generation |
| Base Sepolia chain ID | 84532 | Config + agentRegistry `eip155:84532:…` |
| Base Mainnet chain ID | 8453 | Mainnet gate |
| Demo KYC webhook secret | **generated/demo** `demo-kyc-webhook-secret-not-for-production` | `DemoKycAdapter` only; never for live |
| Demo owner / agent IDs | **generated/demo** | Wizard + tests |
| Didit status strings | Exact case-sensitive labels from https://docs.didit.me/integration/verification-statuses (2026-08-29): `Not Started`, `In Progress`, `Awaiting User`, `Approved`, `Declined`, `In Review`, `Resubmitted`, `Expired`, `Abandoned`, `Kyc Expired` | `DIDIT_STATUS_MAP` |
| Veriff status strings | approved / declined / resubmission_requested / … | `VERIFF_STATUS_MAP` |
| Veriff create-session HMAC | https://devdocs.veriff.com/v1/docs/hmac-authentication-and-endpoint-security (2026-08-29): **POST /v1/sessions is the exception — no X-HMAC-SIGNATURE**; webhooks use `x-hmac-signature` only | `kyc/veriff.ts` |
| SIWE verify | viem `parseSiweMessage` + `verifySiweMessage` | `src/auth/siwe.ts` |
| Browser-wallet migration rationale | https://github.com/base/account-sdk/issues/363 | Historical evidence for replacing the former provider-specific Base Sepolia path; `BROWSER_WALLET_MIGRATION_SPEC.md` |
| PostgreSQL index types and maintenance | https://www.postgresql.org/docs/current/indexes.html | PostgreSQL updates indexes when indexed table rows change; HNSW/GIN/B-tree in `migrations/001_juno_catalog.sql` |
| ACP API overview | https://developers.openai.com/commerce/specs/api/overview | Feeds/Products/Promotions surfaces; common auth, idempotency, tracing, timestamp and version headers |
| ACP Feeds | https://developers.openai.com/commerce/specs/api/feeds | Target `POST /product_feeds` and `GET /product_feeds/{id}` contracts |
| ACP Products | https://developers.openai.com/commerce/specs/api/products | Target GET/PATCH products contract, partial upsert by product ID, variants, minor-unit price and availability |
| pgvector 0.8.1 on PostgreSQL 16 | https://github.com/pgvector/pgvector · image `pgvector/pgvector:0.8.1-pg16` (local harness pin; `>= 0.8` floor; `0.8.6-pg16` pull was unreliable) | Same-database `vector(384)`, cosine `<=>`, HNSW, iterative scans, hybrid lexical search |
| Local embedding runtime and multilingual model | https://huggingface.co/docs/transformers.js · https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2 | `TransformersEmbeddingProvider`: local 384-d Spanish query/document embeddings; no embedding API egress |
| `pg` client | https://node-postgres.com/ | `PostgresCatalogRepository`, parameterized SQL |
| `@huggingface/transformers` feature extraction | https://github.com/huggingface/transformers.js | Local `pipeline('feature-extraction')`; preferred model `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384-d). Query text stays in-process. |
| Credential short TTL default | 900s (product security rule) | `CREDENTIAL_TTL_SECONDS` |
| Platform signing private key | Live: `KYA_SIGNING_PRIVATE_JWK` or `KYA_SIGNING_KEY_FILE` (secret-backed). Demo: process-local ephemeral. Never persist `d`/`privateJwk` in store.json | `credentials/signer.ts`, `JsonFileRepository` scrub |
| AP2 specification (Agent Payments Protocol) | https://github.com/google-agentic-commerce/AP2/blob/main/docs/ap2/specification.md (retrieved 2026-08-30) | Mandate draft/closed vocabulary and cart/payment intent framing for `src/mandates` |
| OpenZeppelin Contracts 5 AccessControl | https://docs.openzeppelin.com/contracts/5.x/api/access#AccessControl | `contracts/MandateAnchor.sol` roles (`DEFAULT_ADMIN_ROLE`, custom pauser/anchorer) |
| Hardhat 3 | https://hardhat.org/docs | `hardhat.config.ts`, `npm run contracts:compile` / `contracts:test` |
| BNB Chain BSC Testnet (chain 97) | https://docs.bnbchain.org/bnb-smart-chain/developers/wallet-configuration/ | Documented anchor network for mandate evidence (live writes out of scope for fake worker) |
| Supabase Postgres RLS | https://supabase.com/docs/guides/database/postgres/row-level-security | `mandate_requests` / `mandate_policy_reservations` RLS + revoke from `anon`/`authenticated` |
| Supabase Database Functions | https://supabase.com/docs/guides/database/functions | `create_mandate_request`, `reserve_mandate_policy` RPCs |
| Supabase Migrations | https://supabase.com/docs/guides/deployment/database-migrations | Unique versions: `20260830000100_create_mandate_policy_ledger.sql`, `20260830000200_create_mandate_requests.sql`, then `20260830235959_upgrade_mandate_schema_v2.sql` |

Re-verify curated registry addresses and ABI before any live promotion.
