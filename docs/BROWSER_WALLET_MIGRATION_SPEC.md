# Browser Wallet-Only Migration Specification

> **SUPERSEDED / HISTORICAL (2026-08-30):** This document records the removed
> BrowserWallet/SIWE experiment. Production uses CDP email OTP and a CDP Smart
> Account UserOperation; see [`../FLOW.md`](../FLOW.md) and
> [`IMPLEMENTATION.md`](./IMPLEMENTATION.md). Nothing below is current runtime
> behavior or a rollout instruction.

**Decision:** Accepted
**Implementation status:** Code-complete; automated verification passed; manual live E2E pending
**Decision date:** 2026-08-29
**Target network:** Base Sepolia (`84532`, `0x14a34`)
**Production wallet connector:** `BrowserWalletConnector` only

## 1. Outcome

KYA will use one browser-injected EVM wallet connector for the complete live
ceremony. The same wallet address MUST:

1. sign the SIWE login message;
2. own the KYC-backed `Principal`;
3. approve the agent fingerprint;
4. submit `IdentityRegistry.register(agentURI)` on Base Sepolia; and
5. own the resulting ERC-8004 Agent NFT before KYA issues a credential.

The release implementing this specification MUST remove the Base Account SDK,
`wallet_connect`, `wallet_sendCalls`, ERC-4337/paymaster support, SIWB-specific
naming, and every runtime/test/config branch that exists only for that path.
This is a replacement, not an additional wallet option.

`FLOW.md` remains the product source of truth and now reflects this migration.
The code, tests, configuration schema, and product documentation implement the
delta. Final live acceptance still requires the manual Base Sepolia transaction
and credential challenge described in section 13.

## 2. Why this change

The current Base Account flow depends on provider-specific capabilities and a
smart-account transaction path. In the tested Base Sepolia flow, Base Account
can reject the chain after KYC even though the application is configured for
Base Sepolia. The upstream SDK has a matching open report for newly created
accounts.

A browser wallet gives the E2E a simpler and observable contract:

- injected providers expose the standard EIP-1193 interface;
- EIP-6963 lets the user select the intended wallet when several are installed;
- SIWE uses the standard ERC-4361 message and a normal wallet signature;
- the user submits one ordinary Base Sepolia transaction;
- KYA never receives or operates the user's private key; and
- the on-chain owner remains the same address that passed authentication and
  KYC.

The tradeoff is explicit: this path has no sponsored gas. The selected browser
wallet needs enough Base Sepolia ETH to submit `register(agentURI)`.

## 3. Scope

### In scope

- A single concrete `BrowserWalletConnector` production implementation.
- EIP-6963 provider discovery and user selection.
- EIP-1193 account, chain, signature, transaction, and lifecycle handling.
- viem `WalletClient` and `PublicClient` over the selected injected provider.
- Standard SIWE naming and message validation.
- Base Sepolia switch/add behavior.
- Simulation followed by the direct registry write.
- Removal of Base Account, ERC-4337, paymaster, and SIWB-only code.
- Documentation, tests, and environment cleanup.
- A real browser-wallet Base Sepolia E2E verification checklist.

### Out of scope

- WalletConnect or mobile deep links.
- A connector registry or multiple production connector implementations.
- Account abstraction, batching, passkeys, session keys, or gas sponsorship.
- Mainnet promotion.
- Migrating ownership between two wallet addresses.
- Changing Didit, ERC-8004 registry event semantics, credential issuance, or
  challenge-response behavior.
- Persisting the agent signing key across page reloads. The existing in-memory
  key lifecycle remains unchanged and requires a separate security decision.

Demo mode may remain as an explicitly labeled, non-production test path. It is
not a wallet connector and MUST NOT be selectable in live mode.

## 4. Normative invariants

The implementation MUST preserve all of these conditions:

1. **One selected provider:** discovery, account access, SIWE signature, chain
   changes, simulation, and transaction submission use the same EIP-1193
   provider object selected by the user.
2. **One owner address:** the connected address MUST equal the address in the
   SIWE message, session token, `Principal`, enrollment owner, prepared
   registration request, transaction sender, `Registered` event, `ownerOf`
   result, and credential subject binding.
3. **Exact chain:** the live MVP accepts only Base Sepolia chain ID `84532`.
   Chain IDs from providers are parsed from hexadecimal and compared as
   integers; string-shape differences are not accepted as different chains.
4. **No platform custody:** KYA MUST NOT request, read, store, export, or operate
   a user's wallet private key or seed phrase.
5. **User is `msg.sender`:** the browser wallet submits the registry call. A KYA
   relayer or backend signer MUST NOT submit it.
6. **Prepared intent is immutable:** the frontend MUST verify the chain,
   account, registry, value, and encoded calldata returned by the backend before
   prompting the wallet.
7. **Simulation before write:** the exact call MUST be simulated immediately
   before the wallet write. A failed simulation MUST stop submission.
8. **Receipt is not binding:** a successful transaction receipt alone does not
   authorize credential issuance. The existing finalized `Registered` event,
   registry, `agentURI`, event owner, and `ownerOf` checks remain authoritative.
9. **Provider metadata is display-only:** EIP-6963 name, icon, and reverse-DNS
   fields MUST NOT be treated as authenticated wallet identity.
10. **Lifecycle changes fail closed:** `accountsChanged`, `chainChanged`, or
    `disconnect` invalidates the active signing/registration step. The user must
    reconnect and reauthenticate where ownership may have changed.

## 5. User flow

```text
Create agent key and enrollment
  -> Discover injected wallets
  -> User selects one wallet
  -> Request account access
  -> Switch/add Base Sepolia
  -> Request backend nonce
  -> Build and sign ERC-4361 SIWE message
  -> Backend verifies message and creates address-bound session
  -> Complete/reuse KYC for that Principal
  -> Approve agent fingerprint
  -> Backend prepares exact register intent
  -> Re-check provider, address, and chain
  -> Simulate IdentityRegistry.register(agentURI)
  -> User confirms direct wallet transaction
  -> Wait for successful receipt
  -> Wait for finalized Registered event and owner binding
  -> Claim credential
  -> Complete agent challenge
```

Connecting a wallet and signing SIWE SHOULD be one user-facing step. Internally,
chain validation occurs before signing so the SIWE message contains chain ID
`84532`. KYC follows authentication because KYA must bind the provider session
to a verified wallet-controlled `Principal`; the UI MUST explain this before
opening Didit.

## 6. `BrowserWalletConnector` contract

The production implementation SHOULD live at
`web/src/browserWalletConnector.ts`. It is the only production connector; a
generic multi-wallet framework MUST NOT be introduced for this migration.
Tests may use a small fake EIP-1193 provider.

The connector owns this state:

```ts
type BrowserWalletState =
  | { status: 'idle' }
  | { status: 'discovering' }
  | { status: 'selecting'; wallets: WalletOption[] }
  | {
      status: 'connected';
      walletId: string;
      address: `0x${string}`;
      chainId: number;
    }
  | { status: 'invalidated'; reason: 'account' | 'chain' | 'disconnect' };
```

The concrete connector MUST expose behavior equivalent to:

```ts
class BrowserWalletConnector {
  discover(): Promise<WalletOption[]>;
  connect(walletId: string): Promise<{ address: `0x${string}`; chainId: number }>;
  ensureBaseSepolia(): Promise<void>;
  signMessage(message: string): Promise<`0x${string}`>;
  simulateRegister(request: RegisterRequest): Promise<void>;
  sendRegister(request: RegisterRequest): Promise<`0x${string}`>;
  waitForReceipt(hash: `0x${string}`): Promise<void>;
  subscribe(listener: (event: WalletLifecycleEvent) => void): () => void;
}
```

The exact surface can be smaller, but responsibilities MUST NOT leak back into
`App.tsx` as raw `provider.request(...)` calls.

### Discovery

- Listen for `eip6963:announceProvider` and dispatch
  `eip6963:requestProvider`.
- Deduplicate providers by EIP-6963 UUID for the current page lifetime.
- Present an explicit selector when more than one provider is announced.
- If no provider announces through EIP-6963, `window.ethereum` MAY be offered
  as one generic legacy fallback.
- Do not guess MetaMask/Coinbase/Rabby from mutable provider flags.
- If no provider exists, show installation guidance and keep live actions
  disabled.

### Connection and chain handling

On an explicit user action:

1. call `eth_requestAccounts`;
2. normalize the first address with viem `getAddress`;
3. read `eth_chainId`;
4. call `wallet_switchEthereumChain` with `0x14a34` when needed; and
5. only when the provider reports an unknown chain, call
   `wallet_addEthereumChain` using:

```json
{
  "chainId": "0x14a34",
  "chainName": "Base Sepolia",
  "nativeCurrency": { "name": "Ether", "symbol": "ETH", "decimals": 18 },
  "rpcUrls": ["https://sepolia.base.org"],
  "blockExplorerUrls": ["https://sepolia.basescan.org"]
}
```

Re-read `eth_accounts` and `eth_chainId` after switch/add. Success MUST be based
on the values returned by the provider, not on the absence of an error.

The official public Base RPC is suitable as the wallet-add default and for
manual testing. It is rate limited and MUST NOT replace the backend's configured
`BASE_SEPOLIA_RPC_URL` for production event watching.

### viem clients

Create the clients from the selected provider:

```ts
const transport = custom(selectedProvider);
const walletClient = createWalletClient({ chain: baseSepolia, transport });
const publicClient = createPublicClient({ chain: baseSepolia, transport });
```

The wallet client signs and writes. The public client simulates and waits for
the receipt. No frontend RPC credential is required or exposed.

## 7. Authentication contract

The HTTP endpoints stay stable:

- `GET /v1/auth/nonce`
- `POST /v1/auth/verify`

The browser constructs a canonical ERC-4361 message containing at least:

- configured `domain`;
- connected checksummed `address`;
- statement: `Sign in to KYA with your browser wallet.`;
- configured `uri`;
- version `1`;
- chain ID `84532`;
- backend-issued nonce;
- `issuedAt`; and
- short `expirationTime`.

The backend continues to parse and verify the full message with viem and MUST
validate domain, URI, address, version, chain, nonce, issued-at skew,
not-before, and expiration. A nonce is consumed only after a valid signature.

All SIWB-only names are replaced by SIWE names, including:

- `src/auth/siwb.ts` -> `src/auth/siwe.ts`;
- `issueSiwbNonce` -> `issueSiweNonce`;
- `verifySiwbLogin` -> `verifySiweLogin`;
- nonce purpose `siwb` -> `siwe`;
- `SIWB_DOMAIN` -> `SIWE_DOMAIN`;
- `SIWB_URI` -> `SIWE_URI`;
- public config `siwbDomain`/`siwbUri` -> `siweDomain`/`siweUri`; and
- error identifiers and user-visible labels from `SIWB_*` to `SIWE_*`.

There will be no compatibility aliases. Deployment configuration MUST be
migrated atomically with the code. Secrets and private keys are unaffected.

## 8. Registration API and transaction contract

`POST /v1/enrollments/:agentUuid/prepare-register` remains authenticated, but
its live response changes from provider-specific send-calls data to a direct,
single-transaction intent:

```json
{
  "mode": "live",
  "agentURI": "https://example.test/agents/<uuid>.json",
  "chainId": 84532,
  "register": {
    "from": "0xChecksummedAuthenticatedOwner",
    "to": "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    "data": "0xEncodedRegisterAgentUri",
    "value": "0x0"
  },
  "callHash": "0xPolicyBindingHash"
}
```

The backend builds this with a replacement for `buildRegisterSendCalls`, named
`buildRegisterTransaction`. The builder MUST checksum `from` and `to`, encode
only `IdentityRegistry.register(agentURI)`, set zero value, and hash the same
chain/registry/URI policy tuple currently used by `hashRegisterCall`.

Before submission, the frontend MUST:

1. compare `register.from` to the current connected address;
2. require `chainId === 84532` and current provider chain `84532`;
3. require `register.to` to equal the curated Base Sepolia registry;
4. require `value === 0`;
5. independently encode `register(agentURI)` with the curated ABI and require
   equality with `register.data`;
6. use viem `simulateContract` for the same address, account, function, and
   arguments; and
7. pass the resulting request to `walletClient.writeContract`.

After write, the UI waits for a successful receipt and then polls the existing
enrollment endpoint until the finalized registry event moves the enrollment to
`bound`. Receipt timeout, event timeout, and receipt revert are different error
states and MUST be shown distinctly.

## 9. Wallet lifecycle and recovery

The connector subscribes to EIP-1193 `accountsChanged`, `chainChanged`, and
`disconnect`, and removes all listeners on teardown.

| Event | Required behavior |
|---|---|
| `accountsChanged([])` | Clear wallet and session state; require reconnect. |
| Address changes | Invalidate session and any prepared registration; restart SIWE. Do not transfer KYC. |
| Chain changes away from `84532` | Disable signing/write actions and offer switch back. |
| `disconnect` | Clear connector state and block all wallet actions. |
| Chain returns to `84532` | Re-read account and require fresh SIWE if the previous state was invalidated. |

An in-flight transaction hash may continue to be observed after a UI lifecycle
change, but credential claim still requires the original authenticated owner
and the authoritative event/`ownerOf` checks.

## 10. User-visible errors

The UI MUST translate at least these conditions into actionable messages:

| Condition | Message/action |
|---|---|
| No injected provider | Install or enable an EIP-1193 browser wallet. |
| Multiple providers | Select the wallet to use for the whole ceremony. |
| Error `4001` | The user rejected the wallet request; offer retry. |
| Error `4100` | Account access is unauthorized; reconnect. |
| Errors `4900`/`4901` | Wallet/chain disconnected; reconnect or switch network. |
| Unknown Base Sepolia | Offer `wallet_addEthereumChain`. |
| Account changed | Explain that KYC is address-bound and restart SIWE. |
| Insufficient funds | Link to an official Base Sepolia faucet/resource. |
| Simulation reverted | Do not open a write prompt; show the decoded/reason-safe error. |
| Write rejected | Keep registration pending and allow a fresh simulation/retry. |
| Receipt reverted | Show failed transaction hash; do not poll as if successful. |
| Event timeout | Show the successful hash and continue safe polling/recovery. |

Raw provider errors may be logged in development after redaction, but the UI
MUST NOT expose tokens, credential bodies, private JWKs, or provider internals.

## 11. Dead-code removal inventory

### Delete

- `web/src/baseAccount.ts`
- `tests/base-account.test.ts`
- `src/server/paymaster.ts`
- dependency `@base-org/account` from `package.json` and `package-lock.json`
- all paymaster-only capability types, persisted collections, TTL/config
  fields, proxy routes, scope validators, counters, and tests
- the popup-specific COOP override if no remaining feature requires it

### Replace or rename

- `web/src/App.tsx` imports/calls/copy -> `BrowserWalletConnector`
- `buildRegisterSendCalls` -> `buildRegisterTransaction`
- `sendCalls` response -> `register` response
- `src/auth/siwb.ts` and all symbols/config/test descriptions -> SIWE
- `Human passkey (SIWB)` UI copy -> `Browser wallet (SIWE)`
- Base Account transaction copy -> direct Base Sepolia transaction copy

### Update documentation

- `FLOW.md`
- `README.md`
- `docs/IMPLEMENTATION.md`
- `docs/SOURCES.md`
- `docs/SKILLS.md`
- `.env.example` and any deployment/runbook variable lists

`docs/SKILLS.md` may retain Base Account skill provenance only as an explicitly
rejected/historical design input. It MUST NOT describe the SDK as a runtime
dependency after the migration.

### Keep

- viem and the curated registry ABI/address checks
- backend Base Sepolia RPC and finalized event watcher
- Didit adapters/webhooks and KYC policy
- credential signing, JWKS, verification, challenge-response, and revocation
- the owner equality and on-chain `ownerOf` checks
- mainnet promotion gates, provided they remain connector-independent
- explicitly labeled demo behavior used by deterministic tests

## 12. Data and deployment migration

- Rename `SIWB_DOMAIN`/`SIWB_URI` to `SIWE_DOMAIN`/`SIWE_URI` in every deployment
  environment in the same release. Do not print their neighboring secrets.
- Remove `PAYMASTER_PROXY_ENABLED`, `PAYMASTER_URL`, and
  `PAYMASTER_CAPABILITY_TTL_SECONDS` from schema and deployment configuration.
- Existing persisted `paymasterCapabilities` data is ignored after the type and
  repository field are removed. No secret/raw capability is expected to exist
  there.
- Do not automatically delete `.kya-data` or invalidate existing Agent IDs.
- An existing verified Principal is reusable only if the browser wallet proves
  control of the same owner address. A different address requires a different
  Principal/KYC flow; there is no silent KYC transfer.
- An existing Agent NFT remains valid. The new UI can operate it only when the
  selected browser wallet controls its owner address.
- Deploy backend and frontend together because the `prepare-register` response
  and public SIWE config field names change atomically.

## 13. Verification plan

### Unit tests

Create `tests/browser-wallet.test.ts` with a fake EIP-1193 provider covering:

- EIP-6963 announcements, deduplication, selection, and fallback;
- explicit `eth_requestAccounts` only after user action;
- Base Sepolia switch and unknown-chain add/retry;
- address normalization and invalid address rejection;
- canonical SIWE signature request;
- provider errors `4001`, `4100`, `4900`, and `4901`;
- account/chain/disconnect invalidation and listener cleanup;
- exact simulation/write request; and
- rejection of mismatched sender, chain, registry, calldata, or value.

Backend tests MUST cover:

- standard SIWE success, replay, expiration, issued-at skew, domain/URI/address/
  chain mismatches, and invalid signature;
- `buildRegisterTransaction` output and checksum behavior;
- live `prepare-register` response without send-calls/paymaster fields;
- demo response remains explicitly demo-only;
- finalized `Registered` event and `ownerOf` gates; and
- credential claim still rejects every owner mismatch.

### Automated integration

Run the wizard against a deterministic fake browser provider and mocked external
KYC/chain boundaries. CI MUST NOT perform real Didit requests or write to a
public chain.

### Manual live E2E

On Base Sepolia, with a browser wallet funded with test ETH:

1. select the intended injected wallet;
2. confirm network switch/add;
3. sign SIWE and verify the displayed address;
4. complete or reuse Didit KYC;
5. approve the fingerprint;
6. inspect and approve `register(agentURI)` in the wallet;
7. record the transaction hash and successful receipt;
8. verify the backend observes the finalized `Registered` event;
9. verify the Agent NFT owner equals the SIWE address;
10. claim and verify the credential; and
11. complete the agent challenge.

Evidence may include the public transaction hash, chain ID, registry address,
Agent ID, and redacted statuses. It MUST NOT include a session token, credential
body, KYC payload, private agent key, signing JWK, or wallet secret.

## 14. Completion gates

The migration is complete only when all of the following pass:

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

Use the scripts that actually exist in `package.json`; if a listed script does
not exist, add an equivalent project-standard check or document why it is not
applicable.

The runtime/package/test tree MUST have zero hits for removed concepts:

```bash
rg -n -i \
  '@base-org/account|wallet_connect|wallet_sendCalls|buildRegisterSendCalls|paymaster|SIWB|siwb|UserOperation|ERC-4337' \
  src web tests scripts package.json package-lock.json
```

Additional gates:

```bash
npm ls @base-org/account
rg -n "baseAccount|sendCalls|paymasterCapabilities" src web tests
```

Expected results:

- `npm ls @base-org/account` shows no installed dependency;
- the `rg` commands return no runtime/test/package matches;
- product documentation describes only the browser-wallet live path;
- any historical Base Account mention is confined to this migration record or
  explicitly marked historical rationale;
- a mocked browser-wallet E2E passes in automation; and
- the manual live E2E has a successful Base Sepolia transaction and completed
  credential challenge.

## 15. Acceptance scenarios

### Scenario A: first-time live enrollment

Given a user selects an injected browser wallet on Base Sepolia, when they sign
SIWE, complete KYC, approve the fingerprint, and submit the registry call, then
the same address is authenticated, is `msg.sender`, owns the minted Agent NFT,
and receives the address-bound credential.

### Scenario B: wrong chain

Given the selected wallet is on another chain, when the live flow begins, then
KYA offers a switch/add to Base Sepolia and does not issue a SIWE session or
prepare a transaction until the provider reports chain ID `84532`.

### Scenario C: account changes after KYC

Given address A authenticated and completed KYC, when the provider changes to
address B, then KYA invalidates the session and prepared transaction, does not
reuse A's KYC for B, and requires a new SIWE flow.

### Scenario D: tampered registration response

Given a prepared request whose registry, calldata, sender, chain, or value does
not match the approved enrollment, when the frontend validates it, then no
wallet transaction prompt is opened.

### Scenario E: transaction succeeds but binding is not final

Given the wallet transaction receipt succeeds, when the finalized matching
`Registered` event and `ownerOf` evidence are not yet available, then KYA keeps
the enrollment pending and does not issue a credential.

### Scenario F: repository cleanup

Given the migration is implemented, when the dead-code gates run, then no Base
Account SDK, provider-specific RPC, paymaster, ERC-4337, or SIWB runtime/test
code remains.

## 16. Sources and data provenance

Retrieved or revalidated on 2026-08-29:

| Decision/data | Authority | Used for |
|---|---|---|
| EIP-1193 | https://eips.ethereum.org/EIPS/eip-1193 | Provider `request`, lifecycle events, and standard provider errors |
| EIP-6963 | https://eips.ethereum.org/EIPS/eip-6963 | Discovery and selection of multiple injected providers |
| ERC-4361 | https://eips.ethereum.org/EIPS/eip-4361 | Canonical SIWE message and verification requirements |
| viem Wallet Client | https://viem.sh/docs/clients/wallet | EIP-1193 custom transport and wallet actions |
| viem `simulateContract` | https://viem.sh/docs/contract/simulateContract | Simulation before contract write |
| viem `writeContract` | https://viem.sh/docs/contract/writeContract | Direct user-submitted registry write |
| Base network configuration | https://docs.base.org/get-started/connect-to-base | Base Sepolia chain ID, RPC, explorer, and network metadata |
| Base Account SDK issue #363 | https://github.com/base/account-sdk/issues/363 | Upstream evidence for the observed Base Sepolia incompatibility class |
| Local curated registry evidence | `src/config/env.ts`, `src/registry/identity.ts`, `docs/SOURCES.md` | Registry address, exact supported version, watcher, and owner-binding policy |

No user, KYC, credential, or secret data was used to write this specification.
