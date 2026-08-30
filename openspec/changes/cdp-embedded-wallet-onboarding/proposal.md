# Proposal: CDP Embedded Wallet Onboarding

## Intent

Replace production SIWE/injected-wallet authentication with CDP User Wallet
email OTP. After login, CDP provisions a User Smart Account
(`createOnLogin: "smart"`) owned by its managed embedded EOA. The Smart Account
is the Principal wallet and submits ERC-8004 registration on Base Sepolia.

## Scope

### In Scope

- CDP email OTP, first-login provisioning, human session, and Principal mapping.
- Replace SIWE/`BrowserWalletConnector`; remove routes, UI paths, dependencies,
  tests, and dead code.
- ERC-8004 intent/submission through CDP Smart Account with watcher authority.
- Preserve Didit, agent-held P-256, DPoP, credentials, public verification, and
  APIs; document CDP boundaries and provenance.

### Out of Scope

- SIWE, Base Account SDK, injected wallet, or production auth fallback.
- Changes to agent key custody, KYC, DPoP, credential claims, registry identity,
  or horizontal persistence.
- Runtime implementation before specs/design approval.

## Capabilities

### New Capabilities

- `embedded-wallet-lifecycle`: CDP OTP, provisioning, Smart Account lifecycle, session binding, and recovery.

### Modified Capabilities

- `human-api-auth`: replace SIWE with CDP human sessions.
- `erc8004-registration-api`: Smart Account submits `register(agentURI)` on Base Sepolia.

The existing `device-agent-pairing`, `kyc-lifecycle-api`, `agent-api-auth`, and
`public-verification-api` requirements remain unchanged and are preserved by
the scope above; they do not require deltas.

## Approach

Configure CDP for email OTP and `createOnLogin: "smart"`; provision after first
login and issue the API session from the verified CDP identity. Use the
Smart Account address for Principal ownership, simulate/submit exact
ERC-8004 call through CDP, and let viem confirm chain evidence and owner. Delete
obsolete SIWE/wallet paths; retain no production fallback.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `web/src`, `src/server`, `src/auth` | Modified | CDP login/session and removed SIWE/wallet paths |
| `src/registry`, `src/services`, `src/domain` | Modified | Smart Account registration and Principal binding |
| `tests`, `FLOW.md`, `docs/SOURCES.md` | Modified | Contract coverage and provenance |

## Risks

CDP outage/SDK drift, OTP abuse, Smart Account sender semantics, UserOp
confirmation, and owner-transfer races require rate limits, session validation,
sourced execution, and watcher/`ownerOf` checks.

## Rollback Plan

Rollback by deploying the prior tagged release; do not reintroduce dead
fallbacks. Preserve pending enrollments/credentials and gate new CDP sessions
until state is reconciled.

## Dependencies

- Official CDP auth/Smart Account docs:
  `https://docs.cdp.coinbase.com/wallets/authentication/overview`,
  `https://docs.cdp.coinbase.com/wallets/using-wallets/smart-accounts`.
- <https://eips.ethereum.org/EIPS/eip-8004>, <https://eips.ethereum.org/EIPS/eip-4337>; repository authority `FLOW.md`/`docs/SOURCES.md`; CDP
  project, Base Sepolia RPC, and registry.

## Success Criteria

- [ ] Specs define one new and two modified capabilities.
- [ ] Production has no SIWE or BrowserWalletConnector path.
- [ ] Login provisions CDP Smart Account and binds it as Principal.
- [ ] ERC-8004 registration and watcher evidence use Smart Account owner.
- [ ] Reviewers approve the contract before runtime implementation.
