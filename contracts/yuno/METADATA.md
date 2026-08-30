# Yuno OpenAPI snapshot — metadata

Pinned contract authority for the Yuno provider mock and adapter work.
Companion file: `contracts/yuno/openapi.json`.

Executable F0 rules: `docs/YUNO_F0_CONTRACT_SPEC.md`.
Migration context: `docs/YUNO_API_MOCK_MIGRATION_SPEC.md`.

## Provenance

| Field | Value |
| --- | --- |
| Official live URL | `https://docs.y.uno/openapi.json` |
| Retrieved at (UTC) | `2026-08-30T03:38:02Z` |
| Live `Last-Modified` | `Thu, 27 Aug 2026 15:19:29 GMT` |
| Live `ETag` | `W/"uHaNIy8bDZb0tqNy"` |
| SHA-256 | `6b4b1001cecb4cff1a808478da9142e16a78c3ee36ea14db23fb539e48f0da19` |
| Byte size | `5675961` |
| Official docs repo | `https://github.com/yuno-payments/yuno-docs` |
| Docs repo commit | `447bc3116475ffbbaedeb1a25d0acc9e50718c31` |
| Repo `openapi.json` vs live download | Byte-for-byte match at the commit above |

This snapshot was copied from the verified download bytes without transformation.
Do not edit `openapi.json` by hand.

## Authority hierarchy

When sources disagree, apply this order:

1. This pinned `contracts/yuno/openapi.json` snapshot (paths, methods, headers, schemas, HTTP codes for the mock and adapter).
2. Official Yuno reference pages / flow guides for operational semantics not fully expressed by OpenAPI.
3. General docs summaries or Docs MCP search results (navigation aids only — not payment processing and not higher than 1–2).

Regenerating types/validators must use **this** snapshot, not a live fetch at
build time. Commands: `npm run yuno:contract:generate` and
`npm run yuno:contract:check-generated` (see `docs/YUNO_F0_CONTRACT_SPEC.md`).

## Snapshot summary

| Field | Value |
| --- | --- |
| OpenAPI | `3.1.0` |
| Title | `Yuno Payments API` |
| API version (`info.version`) | `1.0.0` |
| Paths | `119` |
| Schemas (`components.schemas`) | `50` |
| Webhooks object entries | `1` (`webhook-notifications-banking`) |
| Servers | `https://api-sandbox.y.uno/v1`, `https://api.y.uno/v1`, `https://api.eu.y.uno/v1` |

## Known contract observations

Recorded from the pinned snapshot (not invented outside it):

- Auth schemes include header API keys `public-api-key` (`PublicApiKey`) and `private-secret-key` (`PrivateSecretKey`), plus `X-Idempotency-Key` (`IdempotencyKey`).
- The snapshot also defines `X-Account-Code` (`AccountCode`, multi-account orgs), and alternate `X-Public-Api-Key` / `X-Private-Secret-Key` schemes. Prefer the non-`X-` public/private pair unless a specific operation’s security requirement says otherwise. Do not invent headers absent from this snapshot.
- MVP refund path parameter naming is inconsistent with sibling payment routes: refund is `POST /payments/{id}/transactions/{transaction_id}/refund`, while capture/cancel use `{payment_id}`.
- Webhook resource id parameter is `{webhook_id}` (`GET`/`PATCH`/`DELETE /webhooks/{webhook_id}`), not `{id}`.
- Checkout-workflow enrollment paths used by the migration MVP are present (customer sessions, checkout session payment-methods list, enroll, unenroll).
- Direct unenroll variants also exist; the migration MVP selects Checkout workflow and must not mix contracts casually.
- OpenAPI alone does not fully encode HMAC webhook verification algorithm details; use official webhook HMAC guides under authority level 2 for receiver behavior.
- **Schema gap — create payment `checkout`:** `POST /payments` JSON Schema `required` includes `checkout`, while the property description says it is not required for `DIRECT`/`REDIRECT`. Generated request validators follow the `required` array.
- **Schema gap — prose length limits:** many strings document MIN/MAX only in descriptions (no `minLength`/`maxLength`).
- **Schema gap — overlapping response `oneOf`:** e.g. create-customer `201` full vs min branches; response facade tolerates ≥1 matching branch.

## Generated artifacts

| Artifact | Purpose |
| --- | --- |
| `src/providers/yuno/generated/openapi-types.ts` | Full types via `openapi-typescript@7.13.0` |
| `src/providers/yuno/generated/mvp-operations.ts` | 18 MVP ops + resolved component schemas for Ajv |
| `src/providers/yuno/generated/manifest.ts` | Source SHA-256 + artifact content hashes |
| `src/providers/yuno/validate.ts` | Handwritten `validateRequest` / `validateResponse` |

After any deliberate OpenAPI pin bump: update this metadata, then
`npm run yuno:contract:generate`, then `npm run yuno:contract:check-generated`.

## Update policy

1. Run `npm run yuno:contract:update` only when deliberately refreshing the pin. It downloads **only** `https://docs.y.uno/openapi.json`, validates JSON/OpenAPI identity, and atomically replaces `openapi.json` if valid.
2. The update script **prints** the new SHA-256 and byte size. It **must not** silently rewrite this `METADATA.md`.
3. A human (or explicit follow-up edit) updates this file’s provenance fields, known observations, and summary counts after reviewing the reviewable diff (`npm run yuno:contract:verify` after metadata edit).
4. Never commit credentials, live secrets, or transformed/hand-edited OpenAPI bodies.
5. Snapshot updates are a review gate: classify path/method/schema/security diffs, then regenerate types/validators with `npm run yuno:contract:generate`.

## Verification

```bash
npm run yuno:contract:verify
npm run yuno:contract:check-generated
```

Verify checks hash/size against this file, OpenAPI identity, official servers, security schemes, minimum structural counts, and required MVP route/method coverage. Check-generated fails on drift without mutating tracked outputs. Neither command reads secrets.
