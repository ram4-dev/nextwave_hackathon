# KYA Implementation

This describes the **current mocked build**, not the target live design. The target design (real wallet, real KYC providers, real on-chain writes) lives in [`FLOW.md`](../FLOW.md) as a planning reference and is not implemented in this codebase.

## Architecture

```
Browser wizard (Vite/React)
  └─ AgentKeyProvider (in-memory CryptoKey ref; real WebCrypto P-256 key)
        │
        ▼
Hono API (:8787)
  ├─ auth (labeled mock session — no wallet, no SIWE)
  ├─ enrollment / fingerprint approval / bind (mock register) / revoke
  ├─ public /v1/resolve (no PII)
  ├─ KYC (instant mock verification — no external provider)
  ├─ credential issue/verify + JWKS (real ES256 JWS, cnf.jkt-bound)
  ├─ challenge-response (real signature check over the local CryptoKey)
  └─ payments (F6) — provider-agnostic /v1 + /internal/webhooks/yuno
        │
        ▼
  YunoHttpClient → YUNO_BASE_URL (independent yuno_mock or future live Yuno)
        │
        ▼
Domain + JSON repositories
  KYA: .kya-data/store.json
  Payments: .kya-data/payments-store.json (separate; AES vault tokens)
```

No component in this build talks to a browser wallet, a KYC provider, or a blockchain RPC. `identityRegistrySepolia` is a display-only string echoed by `/v1/config`.

### Domain states

**Enrollment:** `awaiting_device` → `awaiting_human` → (`awaiting_kyc`?) → `awaiting_fingerprint` → `awaiting_register` → `bound` → `revoked`

**KYC (person):** `pending` · `verified` · `expired`

**Credential:** `active` · `revoked` · `expired`

## Status vocabulary (honest)

| Label | Meaning |
| --- | --- |
| **Mocked** | Implemented and exercised by `npm test` / `npm run demo:ceremony`; no real external effect |
| **Planned** | Documented in `FLOW.md`; not implemented in this codebase |

## What's mocked vs real in-process

| Concern | This build |
| --- | --- |
| Human sign-in | Labeled mock session (`POST /v1/auth/login`) — no wallet, no SIWE |
| KYC | Instant mock verification (`POST /v1/kyc/complete`) — no external provider, no PII |
| Registration | Mock bind assigns a display-plausible `agentId`/`agentRegistry` — no chain write | 
| Local agent key | Real WebCrypto P-256 key; private material never leaves the browser |
| Credential | Real ES256 JWS (`jose`), genuinely bound to the key's thumbprint (`cnf.jkt`) |
| Challenge/verify | Real signature check against the enrolled public key |

## Threat boundaries (this build)

| Threat | Mitigation |
| --- | --- |
| Copied JWT abuse | Bound to local key via `cnf.jkt`; challenges require the private key |
| Enrollment detail leakage | Requires session + owner auth; public `/v1/resolve` has no PII |
| JWT alg confusion | ES256 allowlist only; reject `none` |
| Platform signing key | In-memory ephemeral for this build |
| Mock/real confusion | Every mocked step is explicitly labeled in the wizard UI and in this doc |

## Running the demo

```bash
npm run dev            # API on :8787
npm run dev:web        # wizard on :5173
npm run demo:ceremony  # deterministic CLI ceremony, no HTTP server required
```

## Related docs

- [`FLOW.md`](../FLOW.md) — target product design (not all implemented here)
- [`PAYMENTS.md`](./PAYMENTS.md) — F6 platform payments architecture
- [`YUNO_API_MOCK_MIGRATION_SPEC.md`](./YUNO_API_MOCK_MIGRATION_SPEC.md) — F0–F7 migration
- [`SOURCES.md`](./SOURCES.md) — external provenance still relevant to this build
- [`SKILLS.md`](./SKILLS.md) — skill search/install inventory (2026-08-29)
