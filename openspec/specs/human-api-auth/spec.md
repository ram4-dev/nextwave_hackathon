# Human API Authentication Specification

## Purpose

Authenticate a separately hosted frontend human via CDP email OTP and authorize
ceremony operations against the bound Principal / Smart Account.

## Requirements

### Requirement: HAA-001 CDP access-token exchange

`POST /v1/auth/cdp/exchange` MUST be public, rate-limited, and accept only an
opaque CDP access token in the JSON body. The server SHALL validate that token
with the CDP SDK, require email authentication, resolve exactly one Smart
Account, and bind or reuse a pseudonymous Principal to that CDP `userId` and
Smart Account address. CORS MUST allow only the configured frontend origin.
Raw CDP tokens, OTP codes, and email MUST NOT be persisted or logged.

#### Scenario: Valid CDP exchange

- GIVEN a CDP access token for an email-authenticated end user with one Smart Account
- WHEN the frontend exchanges it
- THEN the API returns a short-lived human session bound to that Principal and wallet
- AND no SIWE challenge is issued

#### Scenario: Invalid, ambiguous, or unavailable CDP

- GIVEN a missing/invalid token, non-email auth, zero/multiple Smart Accounts, or CDP outage
- WHEN exchange is attempted
- THEN the API returns a sanitized authentication or dependency error without mutating bindings

### Requirement: HAA-002 Human session

Success MUST issue a short-lived human Bearer session with protected
`typ=KYA-HUMAN-SESSION+JWT`, a human-specific audience, and a dedicated verifier
(`sub=principalId`, wallet claim). The verifier MUST reject generic `JWT`,
credential, and agent-access protected types. It MUST NOT
issue a KYA identity credential, agent access token, or refresh token. Expired
sessions SHALL require a new CDP exchange. Legacy SIWE nonce/verify routes MUST
NOT be reintroduced.

#### Scenario: Valid human session authorizes ceremony

- GIVEN an unexpired human session
- WHEN the frontend calls an allowed ceremony endpoint
- THEN the API authorizes only that Principal's resources

#### Scenario: Cross-Principal access

- GIVEN a valid session for Principal A
- WHEN it references Principal B's enrollment or KYC session
- THEN the API returns a permission error without disclosing protected state

### Requirement: HAA-003 Error normalization

CDP provider and wallet errors MUST be normalized without exposing provider
objects, API secrets, email, or OTP material.

## Source Authority

- Product invariants: `FLOW.md`; provenance: `docs/SOURCES.md`.
- CDP validate access token: <https://docs.cdp.coinbase.com/api-reference/v2/rest-api/end-user-accounts/validate-end-user-access-token>
- CDP smart accounts: <https://docs.cdp.coinbase.com/wallets/using-wallets/smart-accounts>
