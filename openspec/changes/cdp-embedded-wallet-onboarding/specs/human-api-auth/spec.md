# Delta for Human API Authentication

## MODIFIED Requirements

### Requirement: HAA-003 Human authorization boundary

Human ceremony endpoints MUST validate a short-lived KYA session issued only after server-side validation of the CDP access token. Authorization MUST use the pseudonymous Principal ID resolved or reused from verified CDP `userId` and its bound Smart Account wallet/owner address; it MUST NOT trust a frontend address. Expired sessions SHALL require CDP email-OTP login again. CORS MUST allow only the configured frontend origin, and provider errors MUST be normalized without exposing CDP tokens or objects.

(Previously: Human authorization used a SIWE session to bind an injected-wallet address to a Principal ID.)

#### Scenario: Enrollment owner acts

- GIVEN a valid KYA session for the owning Principal ID and its bound Smart Account
- WHEN the frontend requests an allowed ceremony transition
- THEN the API performs only that Principal ID's transition

#### Scenario: Cross-Principal access

- GIVEN a valid session for a different Principal ID
- WHEN it references another Principal ID's enrollment
- THEN the API returns a permission error without disclosing protected state

#### Scenario: Address or account mismatch

- GIVEN a frontend address differs from the Smart Account resolved for the validated CDP user
- WHEN a protected ceremony operation is requested
- THEN the API rejects it without changing the Principal ID or wallet binding

## REMOVED Requirements

### Requirement: HAA-001 SIWE challenge

(Reason: Production human authentication now uses CDP built-in email OTP and has no public SIWE challenge.)
(Migration: Remove `/v1/auth/siwe/challenge`, ERC-4361 challenge state, UI calls, tests, dependencies, and documentation; clients start CDP email OTP instead.)

### Requirement: HAA-002 SIWE verification and human session

(Reason: CDP end-user access-token validation replaces wallet-signature verification as the human trust root.)
(Migration: Remove `/v1/auth/siwe/verify` and its verifier; exchange a server-validated CDP access token for the short KYA human session defined by EWL-003.)

## Source Authority

- Product boundary: `FLOW.md`; provenance: `docs/SOURCES.md`.
- CDP authentication: <https://docs.cdp.coinbase.com/wallets/authentication/overview>.
- Required server validation: <https://docs.cdp.coinbase.com/wallets/authentication/implementation-guide>.
- Validation API: <https://docs.cdp.coinbase.com/api-reference/v2/rest-api/end-user-accounts/validate-end-user-access-token>.
