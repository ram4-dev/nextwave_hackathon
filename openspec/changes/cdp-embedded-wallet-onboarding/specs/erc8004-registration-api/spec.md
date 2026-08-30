# Delta for ERC-8004 Registration API

## MODIFIED Requirements

### Requirement: ERC-001 Registration intent

`POST /v1/enrollments/:agentUuid/registration-intent` MUST require the owning CDP-authenticated human session, approved KYC, current fingerprint approval, and registration eligibility. It SHALL return Base Sepolia chain-id 84532, sourced registry address, exact `register(agentURI)` call, enrollment-bound intent hash, and public sponsorship readiness only. The ERC-4337 sender and ERC-8004 owner MUST equal the Smart Account address bound to the owning Principal ID; KYA MUST NOT sign or submit it.

(Previously: The intent targeted an authenticated browser-wallet address without Smart Account or sponsorship binding.)

#### Scenario: Eligible enrollment

- GIVEN an authorized enrollment and sponsorship readiness
- WHEN the frontend requests an intent
- THEN it receives one bounded Base Sepolia call for its bound Smart Account

#### Scenario: Missing prerequisite or account mismatch

- GIVEN ceremony readiness is absent or the CDP Smart Account differs from the Principal ID's bound wallet
- WHEN an intent is requested
- THEN the API rejects it without executable stale calldata

### Requirement: ERC-002 User-approved Smart Account write

The frontend SHALL obtain explicit user approval and submit the exact intent as a CDP Smart Account UserOperation on Base Sepolia. Gas MUST use either configured CDP native sponsorship or an allowlisted ERC-7677 paymaster. Paymaster URL, credentials, and context secrets MUST remain server-side or in CDP Portal and MUST NOT be returned in the intent or exposed client-side. Missing capability, denial/outage, simulation failure, or user rejection MUST fail closed; no user-pays or wallet fallback MAY run.

(Previously: An EIP-1193 Browser Wallet switched chains, simulated, and directly submitted the transaction.)

#### Scenario: Sponsored user approval

- GIVEN the bound Smart Account, valid intent, and approved sponsor are ready
- WHEN the user approves the UserOperation
- THEN the Smart Account submits exactly `register(agentURI)` on chain-id 84532

#### Scenario: Paymaster or user denies execution

- GIVEN sponsorship is denied/unavailable or the user rejects approval
- WHEN registration is attempted
- THEN no UserOperation is treated as submitted or confirmed
- AND the API exposes a normalized retryable or terminal error

### Requirement: ERC-003 Submission and confirmation

`POST /v1/enrollments/:agentUuid/registration-submissions` SHALL accept and idempotently record only the `userOpHash` for the current intent and bound Smart Account. The system MUST resolve and record the transaction hash from authoritative CDP/UserOperation status; a frontend-provided transaction hash MUST NOT be trusted as evidence. UserOperation status alone MUST NOT confirm registration. The viem watcher MUST verify chain-id, successful receipt, expected registry, `Registered` event and arguments, intent, and `ownerOf` equal to the bound Smart Account before confirmation or credential issuance.

(Previously: Submission accepted only a transaction hash and compared ownership to a generic human Principal.)

#### Scenario: Matching UserOperation confirms on-chain

- GIVEN a recorded `userOpHash` resolves authoritatively to the expected transaction
- WHEN watcher evidence and `ownerOf` match the bound Smart Account
- THEN the agent ID and confirmed state are recorded exactly once

#### Scenario: Duplicate or mismatched submission

- GIVEN a replayed `userOpHash`, frontend transaction hash, or mismatched chain evidence
- WHEN confirmation is evaluated
- THEN duplicates are idempotent and untrusted or mismatched evidence never issues a credential

## RENAMED Requirements

### Requirement: ERC-002 Browser-wallet write → ERC-002 User-approved Smart Account write

(Reason: Registration is now submitted by the CDP User Smart Account, not an injected Browser Wallet.)
(Migration: Replace BrowserWallet and EIP-1193 references in clients, tests, and documentation with the modified ERC-002 UserOperation contract.)

## Source Authority

- Product/ABI/address authority: `FLOW.md`, `docs/SOURCES.md`.
- CDP Smart Account/UserOperation/paymaster: <https://docs.cdp.coinbase.com/wallets/using-wallets/smart-accounts>.
- Account abstraction: <https://eips.ethereum.org/EIPS/eip-4337>.
- Sponsorship interface: <https://eips.ethereum.org/EIPS/eip-7677>.
- Registration semantics: <https://eips.ethereum.org/EIPS/eip-8004>.
