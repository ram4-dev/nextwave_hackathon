# Embedded Wallet Lifecycle Specification

## Purpose

Define CDP OTP, wallet provisioning, pseudonymous identity, and custody.

## Requirements

### Requirement: EWL-001 Built-in email OTP

Production login MUST use CDP built-in email OTP only. OTP requests SHALL be origin- and rate-limited; codes and tokens MUST NOT appear in URLs or logs. Provisioning MUST NOT precede successful verification.

#### Scenario: First successful login

- GIVEN a new user receives a CDP email OTP
- WHEN CDP verifies the code
- THEN the user becomes authenticated and wallet provisioning may begin

#### Scenario: OTP abuse or invalid code

- GIVEN an expired, incorrect, replayed, or rate-limited OTP attempt
- WHEN verification is requested
- THEN no KYA session, Principal ID, or wallet binding is created

### Requirement: EWL-002 User Smart Account provisioning

After first verified login, CDP SHALL provision one User Smart Account (`createOnLogin: "smart"`) owned by the embedded EOA. KYA MUST resolve or reuse a pseudonymous Principal ID from stable verified CDP `userId` and bind that Smart Account as its sole human wallet/owner address. It MUST NOT bind the EOA or possess either key.

#### Scenario: New account is provisioned

- GIVEN an authenticated CDP user without a wallet
- WHEN post-login provisioning completes
- THEN the Smart Account and embedded EOA are associated with that user
- AND KYA binds only its Smart Account address to the resolved Principal ID

#### Scenario: Account identity mismatch

- GIVEN a verified CDP user whose Smart Account conflicts with its Principal ID binding
- WHEN wallet binding is requested
- THEN the system fails closed without remapping ownership

### Requirement: EWL-003 Server-validated KYA session

The frontend SHALL send the CDP access token only through a protected body/header. KYA MUST validate it server-to-server for the configured project, active token, stable `userId`, and email authentication, then resolve its Principal ID and Smart Account binding. A frontend address MUST NOT establish identity. Success SHALL issue a short-lived KYA human Bearer session held in memory and bound to that Principal ID. KYA MAY persist only the identifier mapping and public addresses; it MUST NOT persist email, OTP, or CDP tokens.

#### Scenario: Valid token exchange

- GIVEN a valid CDP token for the configured project and email-authenticated user
- WHEN KYA validates and resolves the Principal ID and Smart Account binding
- THEN KYA issues a short session bound to that Principal ID

#### Scenario: Invalid token or replayed provisioning request

- GIVEN an invalid, expired, wrong-project token or a repeated exchange request
- WHEN session exchange occurs
- THEN invalid tokens produce no session
- AND repetition MUST NOT create another wallet or change the Principal ID

### Requirement: EWL-004 Recovery and dependency failure

Returning users SHALL regain the same Principal ID only after fresh CDP authentication. Recovery MUST NOT silently change its Smart Account binding. CDP validation/provisioning outages SHALL block new sessions; expiry or logout SHALL require login again.

#### Scenario: Returning user recovers access

- GIVEN CDP reauthenticates the same user and Smart Account
- WHEN KYA validates the new access token
- THEN access resumes against the existing Principal ID and enrollments

#### Scenario: CDP outage

- GIVEN CDP token validation or wallet resolution is unavailable
- WHEN login or recovery is attempted
- THEN KYA returns a dependency error and creates no trusted session

### Requirement: EWL-005 Compatibility and key separation

Production MUST NOT expose SIWE, Base Account, injected-wallet, or BrowserWallet fallback paths. The agent-held P-256 key SHALL remain independent of CDP wallets; Didit, DPoP agent authentication, KYA credentials, public verification, and watcher authority MUST remain behaviorally unchanged.

#### Scenario: Legacy path requested

- GIVEN a production client invokes a removed wallet-auth fallback
- WHEN the request is received
- THEN the path is unavailable and cannot establish a Principal ID

## Source Authority

- Product boundaries: `FLOW.md`; provenance: `docs/SOURCES.md`.
- CDP OTP/auth: <https://docs.cdp.coinbase.com/wallets/authentication/overview>.
- Token validation: <https://docs.cdp.coinbase.com/api-reference/v2/rest-api/end-user-accounts/validate-end-user-access-token>.
- Smart Accounts: <https://docs.cdp.coinbase.com/wallets/using-wallets/smart-accounts>.
