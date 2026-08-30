# Proposal: API-First Agent Onboarding and Authenticated Agent API

## Intent

Expose KYA as an external-frontend/local-agent contract. Human login is CDP
email OTP with opaque access-token exchange. Device pairing, Didit KYC,
ERC-8004 Smart Account registration, one-time identity credential delivery,
and DPoP-bound agent access are versioned HTTP contracts. Supabase is the live
persistence and shared replay authority.

## Scope

### In Scope

- CDP human auth: email OTP → exchange → Principal bound to Smart Account.
- Device enrollments with public JWK only, hashed device/user codes, claim,
  fingerprint approval, and one-time credential delivery.
- Didit session/callback (303 navigation-only) and signed webhook authority;
  owner-scoped normalized KYC status.
- CDP Smart Account UserOperation registration + viem watcher binding.
- Agent access JWT (`typ=KYA-AGENT-ACCESS+JWT`, ≤10m) + RFC 9449 DPoP
  `requireAgentAuth` and `GET /v1/agent/me`.
- Supabase migrations/RLS, service-role client, `/ready`, JSON import/export.
- Reference web wizard (IndexedDB CryptoKey) and reusable DPoP client helpers.

### Out of Scope

- SIWE, injected Browser Wallet, server custody, paymaster URL exposure.
- Bearer compatibility, refresh tokens, mandate feature from PR #3.
- Using the KYA identity credential as an access token.

## Capabilities

- `human-api-auth` (CDP)
- `device-agent-pairing`
- `kyc-lifecycle-api`
- `erc8004-registration-api` (CDP Smart Account)
- `agent-api-auth`
- `public-verification-api` (JWKS, ready, config)

## Success Criteria

- [x] Specs/design/tasks approved for implementation (user exception-ok).
- [ ] Tests cover durability, token-class separation, DPoP failures, one-time
      delivery, callback/webhook authority, and no-secret persistence.
- [ ] Live Supabase E2E recorded as gate when Vault secrets unavailable.
