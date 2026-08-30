# KYC Lifecycle API — Delta (api-first-agent-onboarding)

## ADDED Requirements

### Requirement: KYC-H1 Callback vs webhook authority

`GET /v1/kyc/callback` MUST only navigate (303) and MUST NOT mutate KYC decision state. Signed provider webhooks remain the sole authority for status transitions, with idempotent event processing.

### Requirement: KYC-H2 Owner-scoped status

KYC session status reads MUST authorize the owning Principal only. Cross-principal reads MUST fail closed without leaking session existence details beyond sanitized errors.
