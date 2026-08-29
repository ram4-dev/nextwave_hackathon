# Skills search & install provenance

**Date:** 2026-08-29  
**Context:** Skill discovery for KYA (Base Account, viem, Didit KYC, JWT, ERC-8004).

## Requested / installed skills

| Request | Catalog result | Installs | Stars | Notes |
| --- | --- | --- | --- | --- |
| `base/skills` as `building-with-base-account` | **`build-on-base`** (current catalog name) | 360 | 114 | Use for Base Account / SIWB / paymaster / `wallet_sendCalls` guidance |
| `uniswap/uniswap-ai@viem-integration` | `viem-integration` | 1K | 228 | viem client patterns |
| `didit-protocol/skills@didit-kyc-onboarding` | `didit-kyc-onboarding` | 225 | 26 | Didit hosted KYC onboarding |
| `mindrally/skills@jwt-security` | `jwt-security` | 1.4K | 246 | JWT/JWS security practices |
| `bankrbot/skills@erc-8004` | `erc-8004` | 224 | 1.19K | **Secondary only** — scope/audit warnings; prefer official EIP + contracts repo |

## Provider-specific skill gaps (authoritative docs win)

| Provider | Skill search result | Authoritative source |
| --- | --- | --- |
| Incode | **No trusted provider-specific Incode skill found** | https://developer.incode.com/ |
| Veriff | Only low-adoption skill found — **not used** | https://devdocs.veriff.com/ (HMAC + sessions + webhooks) |

Official provider documentation linked in [`SOURCES.md`](./SOURCES.md) is authoritative for Didit, Incode, and Veriff mappings.

## Local skill paths (this machine)

- Base: `~/.claude/skills/build-on-base/SKILL.md`
- viem: `~/.claude/skills/viem-integration/SKILL.md`
- Didit: `~/.claude/skills/didit-kyc-onboarding/SKILL.md`
- JWT: `~/.claude/skills/jwt-security/SKILL.md`
- ERC-8004 (secondary): `~/.agents/skills/erc-8004/SKILL.md`
