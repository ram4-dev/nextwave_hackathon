# Yuno sandbox swap readiness (F7)

Offline configuration gate for pointing the same `YunoHttpClient` /
`YunoAdapter` path at a non-mock provider URL. This is **not** a live
sandbox contract run.

## Status

| Claim | Meaning |
| --- | --- |
| **F7 readiness code** | Implemented — `YUNO_PROVIDER_ENV`, fail-closed sandbox/production config, offline CLI |
| **LIVE-NOT-EXECUTED** | No real Yuno sandbox/production call was run; no user credential or authorization was supplied |
| **Poll/reconcile** | Deferred — webhooks remain the primary async path |

## Provider mode

| `YUNO_PROVIDER_ENV` | Behavior |
| --- | --- |
| `mock` (default) | Local fixture credentials allowed; HTTP mock base URL OK; legacy `YUNO_MOCK_URL` alias OK |
| `sandbox` | Explicit non-fixture secrets; **`YUNO_BASE_URL` only** (never `YUNO_MOCK_URL`); HTTPS; no URL userinfo; `YUNO_ACCOUNT_ID` must be UUID |
| `production` | Same fail-closed rules as sandbox |

Sandbox/production never fall back to `.env.example` fixture keys. Invalid
config fails in `loadConfig` before payment runtime creation.

## Offline CLI

```bash
npm run yuno:sandbox:readiness
npm run yuno:sandbox:readiness -- --fixture=ready
npm run yuno:sandbox:readiness -- --fixture=unready
```

**No-arg success requires an explicitly configured live provider mode**
(`YUNO_PROVIDER_ENV=sandbox` or `production`) plus shape-valid non-fixture
secrets and HTTPS `YUNO_BASE_URL`. A scrubbed environment (default `mock`)
exits **1** with `ready=false` and `NON_LIVE_PROVIDER_ENV` — it never exits
0 merely because mock assessment is locally ready.

Output is limited to `providerEnv`, `ready`, `liveSandboxCheck` (always
`false`), missing/invalid variable names or issue codes, and a safe
`json={...}` line with the same fields. Secret values, full URLs, and
userinfo are never printed. Fixture modes (`--fixture=ready|unready`) are
reproducible **offline shape checks only** (`liveSandboxCheck=false`) — they
do **not** prove connectivity to Yuno (**LIVE-NOT-EXECUTED**).

## Swap path

Change `YUNO_PROVIDER_ENV` + `YUNO_BASE_URL` + injected secrets. No
`if mock` branch inside `PaymentService`; the adapter/HTTP client path is
unchanged. Legacy `YUNO_MOCK_URL` remains mock-only.
