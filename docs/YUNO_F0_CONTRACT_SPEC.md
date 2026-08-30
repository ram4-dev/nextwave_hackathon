# Yuno F0 — Contract acquisition executable spec

Executable specification for **F0: pin the official Yuno OpenAPI snapshot**,
keep it verifiable, and generate TypeScript types plus runtime validators
from that pin. This is not an implementation of the Yuno mock, adapter, or
platform payment API.

Companion artifacts:

- `contracts/yuno/openapi.json` — pinned bytes
- `contracts/yuno/METADATA.md` — provenance and policy
- `docs/YUNO_API_MOCK_MIGRATION_SPEC.md` — full migration design
- `scripts/update-yuno-openapi.mjs` / `scripts/verify-yuno-openapi.mjs`
- `scripts/generate-yuno-contract.mjs` / `scripts/yuno-mvp-operations.mjs`
- `src/providers/yuno/generated/*` — generated types + MVP registry
- `src/providers/yuno/validate.ts` — handwritten validator facade

## 1. Goals

- Acquire and pin the official Yuno OpenAPI document as the sole snapshot
  authority for later provider-mock and adapter work.
- Record complete provenance (URL, retrieval time, hash, size, upstream repo
  commit evidence) in `METADATA.md`.
- Provide Node scripts to **update** (deliberate refresh), **verify** the pin,
  **generate** types/MVP validators from the pin, and **check** generated
  drift — without reading secrets or fetching live docs during generate/verify.
- Keep migration-spec OpenAPI claims current once the snapshot and generators
  are present.

## 2. Non-goals

- Implementing Yuno REST mock routes, enrollment UI, or webhooks (F1+).
- Changing platform `/v1` payment APIs, MCP tools, or `yuno_mock` MCP behavior.
- Live calls to Yuno sandbox/production APIs, or storing credentials.
- Silently rewriting `METADATA.md` on OpenAPI update.
- Inventing provider fields absent from the pin to “fix” schema gaps.

## 3. Pinned authority

| Item | Authority |
| --- | --- |
| Paths, methods, headers, schemas, status codes for provider compatibility | `contracts/yuno/openapi.json` |
| Provenance, hash/size, update policy, known observations | `contracts/yuno/METADATA.md` |
| Product architecture and MVP route *intent* | `docs/YUNO_API_MOCK_MIGRATION_SPEC.md` |
| Operational semantics missing from OpenAPI (e.g. HMAC details) | Official Yuno guides, after the snapshot |

Hierarchy: pinned OpenAPI → official flow/reference guides → Docs MCP /
summaries. See `METADATA.md`.

**Current pin (verified acquisition):**

| Field | Value |
| --- | --- |
| Source URL | `https://docs.y.uno/openapi.json` |
| SHA-256 | `6b4b1001cecb4cff1a808478da9142e16a78c3ee36ea14db23fb539e48f0da19` |
| Size | `5675961` bytes |
| Retrieved | `2026-08-30T03:38:02Z` |
| OpenAPI / title / version | `3.1.0` / `Yuno Payments API` / `1.0.0` |
| Paths / schemas / webhooks | `119` / `50` / `1` |
| Upstream docs commit (byte match) | `447bc3116475ffbbaedeb1a25d0acc9e50718c31` |

## 4. Acquisition and update flow

### Initial acquisition (done for this pin)

1. Download exact bytes from `https://docs.y.uno/openapi.json`.
2. Record SHA-256, size, HTTP `Last-Modified` / `ETag`, retrieval timestamp.
3. Cross-check against `yuno-payments/yuno-docs` commit when available.
4. Copy bytes unchanged into `contracts/yuno/openapi.json`.
5. Write `METADATA.md` with provenance and observations.
6. Run `npm run yuno:contract:verify`.

### Deliberate refresh

```bash
npm run yuno:contract:update
```

The update script must:

1. Download **only** `https://docs.y.uno/openapi.json` (no alternate mirrors
   unless this spec is amended).
2. Validate: non-empty body, parseable JSON, `openapi` 3.1.x, title
   `Yuno Payments API`, required servers present.
3. On success, atomically replace `contracts/yuno/openapi.json` (write temp in
   the same directory, then rename).
4. Print the **new** SHA-256 and byte size (and note that `METADATA.md` was
   **not** modified).
5. Exit non-zero if validation fails; leave the previous snapshot intact.

After update, a human reviews the diff, then **manually** updates
`METADATA.md` (hash, size, retrieval time, observations). Then re-run verify.

## 5. Reviewable diff classification

When the pin changes, classify diffs before any generator work:

| Class | Examples | Gate |
| --- | --- | --- |
| A — Additive | New paths/schemas unused by MVP | Document; usually low risk |
| B — MVP surface | Changes to required MVP routes/methods/params | Block mock/adapter changes until reviewed |
| C — Security / idempotency | Header schemes, idempotency requirements | Security review |
| D — Breaking remove/rename | Removed path, renamed path param (`payment_id` vs `id`) | Explicit migration decision |
| E — Metadata-only | Description text | Usually informational |

Do not regenerate types/validators on an unreviewed Class B–D change. After an
accepted pin bump: `npm run yuno:contract:generate` then update metadata.

## 6. Required MVP route and method coverage

Verify must assert these operations exist on the pinned snapshot (relative to
server `/v1` base; path keys as in OpenAPI). Parameter names match the
**snapshot**, including known inconsistencies.

| Method | Path |
| --- | --- |
| `POST` | `/customers` |
| `POST` | `/customers/sessions` |
| `GET` | `/checkout/customers/sessions/{customer_session}/payment-methods` |
| `POST` | `/customers/sessions/{customer_session}/payment-methods` |
| `GET` | `/payment-methods/{payment_method_id}` |
| `GET` | `/customers/{customer_id}/payment-methods` |
| `POST` | `/customers/payment-methods/{payment_method_id}/unenroll` |
| `POST` | `/payments` |
| `GET` | `/payments/{payment_id}` |
| `POST` | `/payments/{payment_id}/transactions/{transaction_id}/capture` |
| `POST` | `/payments/{payment_id}/transactions/{transaction_id}/cancel` |
| `POST` | `/payments/{id}/transactions/{transaction_id}/refund` |
| `POST` | `/payments/{payment_id}/cancel-or-refund` |
| `POST` | `/payments/{payment_id}/transactions/{transaction_id}/cancel-or-refund` |
| `POST` | `/webhooks` |
| `GET` | `/webhooks` |
| `PATCH` | `/webhooks/{webhook_id}` |
| `DELETE` | `/webhooks/{webhook_id}` |

Minimum structural floors (current pin): paths ≥ 119, schemas ≥ 50,
webhooks object entries ≥ 1.

## 7. Auth and idempotency boundaries

From the pinned snapshot’s `components.securitySchemes` (names are scheme
ids; header names are authoritative):

| Scheme id | Header | Role |
| --- | --- | --- |
| `PublicApiKey` | `public-api-key` | Public API key |
| `PrivateSecretKey` | `private-secret-key` | Private secret (server-side) |
| `IdempotencyKey` | `X-Idempotency-Key` | Idempotency for operations that require it |
| `AccountCode` | `X-Account-Code` | Multi-account orgs only when required |
| `XPublicApiKey` / `XPrivateSecretKey` | `X-Public-Api-Key` / `X-Private-Secret-Key` | Alternate schemes present in snapshot |

F0 rules:

- Scripts and docs never embed or read real credential values.
- Mock/adapter work (later) must honor snapshot security requirements per
  operation; do not invent headers absent from the snapshot.
- Idempotency is not required on every `POST` — only where the operation’s
  security/parameters say so (full enforcement lands with F1+ contract tests).

## 8. Type / validator generation gate (complete)

Toolchain (exact versions pinned in root `package.json`):

| Package | Version | Role |
| --- | --- | --- |
| `openapi-typescript` | `7.13.0` | Full TypeScript types from the pin |
| `ajv` | `8.20.0` | OpenAPI 3.1 / JSON Schema 2020-12 runtime validation |
| `ajv-formats` | `3.0.1` | Format validators for Ajv |

Commands:

```bash
npm run yuno:contract:generate         # write src/providers/yuno/generated/*
npm run yuno:contract:check-generated  # in-memory/temp generate; fail on drift; no tracked writes
```

Outputs (lint-visible, clearly labeled AUTO-GENERATED):

- `src/providers/yuno/generated/openapi-types.ts` — full `paths` / `components` types
- `src/providers/yuno/generated/mvp-operations.ts` — compact registry for the 18 MVP
  operations (method, path, required headers/security, request schema, response
  statuses/schemas) with local `$ref`s rewritten to bundled component schema ids
- `src/providers/yuno/generated/manifest.ts` — source OpenAPI SHA-256 + artifact hashes
- `src/providers/yuno/generated/index.ts` — re-exports

Handwritten facade (not generated): `src/providers/yuno/validate.ts` exposes
`validateRequest` / `validateResponse`. Runtime validation uses only the
generated registry — it does **not** read the 5.7 MB OpenAPI file or fetch
live docs.

### Observed pin gaps (documented; evidence-backed)

1. **POST `/payments` `checkout` required vs description:** JSON Schema
   `required` includes `checkout`, while the property description says checkout
   is not required for `DIRECT`/`REDIRECT`. Request validation follows the
   pinned `required` array.
2. **Prose-only length limits:** many string fields document MIN/MAX only in
   descriptions without `minLength`/`maxLength`; Ajv does not enforce prose.
3. **Overlapping response `oneOf`:** e.g. create-customer `201` “full” vs “min”
   branches both match many payloads, so strict `oneOf` fails. Response
   validation tolerates ≥1 matching branch.

Focused tests: `tests/yuno-contract-generated.test.ts`.

## 9. Contract-test strategy (F0 vs later)

| Layer | F0 now | Later (F1+) |
| --- | --- | --- |
| Pin integrity | `yuno:contract:verify` | Same, in CI |
| Generated drift | `yuno:contract:check-generated` + Vitest hash checks | Same, in CI |
| MVP schema validation | Vitest via `validateRequest` / `validateResponse` | Expand per route as mock lands |
| Mock vs snapshot | — | Full contract tests against mock server |
| Live sandbox | — | Optional suite with secret-injected creds |
| Mapping | — | Platform ↔ Yuno mapping tests |

F0 does not start the mock server. Network is used only by
`yuno:contract:update` (official OpenAPI URL).

## 10. Failure behavior

| Failure | Behavior |
| --- | --- |
| Missing `openapi.json` or `METADATA.md` | Verify exits non-zero with clear path |
| Hash or size mismatch | Verify fails; do not “fix” by rewriting metadata |
| Unparseable JSON / wrong title / wrong openapi major | Update aborts without replacing; verify fails |
| Missing official server URL | Verify fails |
| Missing required security scheme or MVP route/method | Verify fails with the missing item named |
| Generated drift | `check-generated` fails; tracked outputs untouched |
| Network error on update | Non-zero exit; previous pin untouched |
| Secrets in env | Scripts must not read payment/Yuno secret env vars |

## 11. Acceptance evidence

- [x] `contracts/yuno/openapi.json` present with expected SHA-256 and size.
- [x] `contracts/yuno/METADATA.md` documents provenance, hierarchy, summary,
      observations, update policy.
- [x] `docs/YUNO_F0_CONTRACT_SPEC.md` (this file) executable for F0.
- [x] `npm run yuno:contract:update` / `yuno:contract:verify` scripts exist.
- [x] `npm run yuno:contract:verify` passes in this worktree.
- [x] Migration spec updated for pin + generation gate; links to this F0 spec.
- [x] Lint / typecheck / test / build still pass (no functional payment mock).
- [x] `npm run yuno:contract:generate` / `yuno:contract:check-generated` exist
      and pass; focused Vitest coverage green.

## 12. Handoff to F1

F0 is complete for pin + generation. F1 (mock base) consumes:

- Pinned OpenAPI + generated MVP registry / validator facade
- Provider auth header validation
- Error shapes and idempotency replay primitives
- Route scaffolding aligned to pinned paths

F1 must not re-fetch OpenAPI at runtime.

**Commands:**

```bash
npm run yuno:contract:verify
npm run yuno:contract:generate
npm run yuno:contract:check-generated
npm run yuno:contract:update   # deliberate OpenAPI refresh only
```
