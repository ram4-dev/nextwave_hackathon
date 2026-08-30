# Sources & provenance

Retrieval date for all entries: **2026-08-29**. Marked **generated/demo** where data is synthetic.

## Currently relevant (this build)

| Topic | Authoritative URL / value | What depends on it |
| --- | --- | --- |
| jose | https://github.com/panva/jose | JWS issue/verify, JWK thumbprints (`src/credentials/`) |
| RFC 7519 (JWT) | https://www.rfc-editor.org/rfc/rfc7519 | Credential claim set |
| RFC 7638 (JWK thumbprint) | https://www.rfc-editor.org/rfc/rfc7638 | `cnf.jkt` |
| Web Crypto API | https://www.w3.org/TR/WebCryptoAPI/ | Local P-256 key generation (`web/src/AgentKeyProvider.tsx`) |
| IdentityRegistry Base Sepolia 84532 | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `config/env.ts` — display-only in `/v1/config`, no on-chain reads/writes |
| IdentityRegistry Base Mainnet 8453 | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | Documented reference only; not used by any code path |
| Base Sepolia chain ID | 84532 | Config + display-only `agentRegistry` reference string |
| Demo owner / agent IDs | **generated/demo** | Wizard + CLI demo + tests |
| Credential short TTL default | 900s (product security rule) | `CREDENTIAL_TTL_SECONDS` |
| Platform signing private key | Process-local ephemeral in this build | `credentials/signer.ts`, `JsonFileRepository` scrub |

## Target design (planned, not implemented in this build)

The rows below back the live design described in `FLOW.md`. The files they used to reference (`src/kyc/*`, `src/registry/*`, `src/auth/siwe.ts`, `abis/IdentityRegistry.json`, `docs/BROWSER_WALLET_MIGRATION_SPEC.md`) were removed when the ceremony was mocked end-to-end for this demo. Keep this table only as provenance for a future live re-implementation — re-verify everything before acting on it.

| Topic | Authoritative URL / value | Would depend on it |
| --- | --- | --- |
| EIP-8004 (Identity Registry, registration-v1) | https://eips.ethereum.org/EIPS/eip-8004 | Registry semantics for a real `register(agentURI)` write |
| Official contracts repo | https://github.com/erc-8004/erc-8004-contracts | ABI provenance; curated addresses |
| EIP-1193 provider API | https://eips.ethereum.org/EIPS/eip-1193 | Real injected wallet request API |
| EIP-6963 provider discovery | https://eips.ethereum.org/EIPS/eip-6963 | Multi-wallet discovery |
| ERC-4361 Sign-In with Ethereum | https://eips.ethereum.org/EIPS/eip-4361 | Real SIWE message + verification |
| viem Wallet Client / `watchContractEvent` / `simulateContract` / `writeContract` | https://viem.sh/docs | Real chain reads/writes and event indexing |
| Didit create session / webhooks | https://docs.didit.me/sessions-api/create-session · https://docs.didit.me/integration/webhooks | A real hosted KYC provider adapter |
| Incode backend integrate / webhooks | https://developer.incode.com/integrate-by-platform/backend/ | A real hosted KYC provider adapter |
| Veriff v1 sessions / webhooks / HMAC | https://devdocs.veriff.com/apidocs/v1sessions | A real hosted KYC provider adapter |
| Browser-wallet migration rationale | https://github.com/base/account-sdk/issues/363 | Historical evidence, no longer implemented |

Re-verify curated registry addresses and ABI before any live promotion.
