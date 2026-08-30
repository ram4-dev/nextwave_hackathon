# Public Verification API Specification

## Purpose

Expose independently verifiable identity evidence and honest service readiness without private ceremony data.

## Requirements

### Requirement: PVA-001 Public signing metadata and JWKS

Issuer metadata and JWKS MUST expose only public signing keys. KYA identity credentials (`typ=KYA-CREDENTIAL+JWT`), human sessions, and agent access JWTs (`typ=KYA-AGENT-ACCESS+JWT`) MUST NOT be interchangeable.

### Requirement: PVA-002 Public credential and status projection

Public credential/status endpoints MUST NOT expose KYC PII, Didit tokens, device/user codes, raw access JWTs, DPoP replay entries, internal `principalId`, or private JWK members.

### Requirement: PVA-003 Safe public configuration

`/v1/config` exposes non-secret client values only (origins, audiences, chain ids, registry ids, poll interval). It MUST NOT expose secrets or filesystem paths.

### Requirement: PVA-004 Liveness, readiness, and persistence compatibility

`GET /health` is liveness-only. `GET /ready` reports sanitized dependency/schema status. When `PERSISTENCE_BACKEND=supabase`, readiness fails closed without schema/service-role availability; protected traffic MUST NOT accept production readiness without durable shared DPoP replay. JSON persistence MUST NOT silently back Supabase mode.

## Source Authority

- Product/public-data rules: `FLOW.md`; `docs/SOURCES.md`.
- JOSE/DPoP: <https://www.rfc-editor.org/rfc/rfc9449>, <https://www.rfc-editor.org/rfc/rfc7638>.
