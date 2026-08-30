# ERC-8004 Registration API Specification

## Purpose

Define CDP Smart Account Base Sepolia registration whose confirmed chain evidence binds an enrollment.

## Requirements

### Requirement: ERC-001 Registration intent

`POST /v1/enrollments/:agentUuid/registration-intent` MUST require the owning human session, approved KYC, current fingerprint approval, and registration eligibility. It SHALL return Base Sepolia chain-id 84532, the sourced registry address, exact call target/data, agent URI, and an enrollment-bound intent hash. The API MUST NOT sign or submit the UserOperation.

### Requirement: ERC-002 CDP Smart Account write

The frontend SHALL submit the exact intent via CDP `useSendUserOperation` on `base-sepolia` with `useCdpPaymaster: true`. The Smart Account MUST remain the sender; the API MUST NOT custody a wallet key, expose a paymaster URL, or become `msg.sender`.

### Requirement: ERC-003 Submission and confirmation

`POST /v1/enrollments/:agentUuid/registration-submissions` accepts `userOpHash` idempotently. Server CDP status plus a viem watcher MUST verify receipt, registry event, intent, and `ownerOf` before binding or issuing a credential.

### Requirement: ERC-004 Chain changes after confirmation

Reorganization, removal, or ownership transfer MUST suspend the binding until current chain evidence is valid again.

## Source Authority

- Product ownership flow: `FLOW.md`; address/ABI provenance: `docs/SOURCES.md`.
- CDP smart accounts / UserOperations: <https://docs.cdp.coinbase.com/wallets/using-wallets/smart-accounts>
- viem: <https://viem.sh/docs/contract/watchContractEvent>
