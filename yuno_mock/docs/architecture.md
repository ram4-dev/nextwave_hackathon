# Architecture

## Protocol and transport

The mock exposes MCP over **StreamableHTTP** on `POST /mcp` — the same
transport `YunoMcpClient` uses on the real client side
(`@yuno-payments/agent-toolkit`). The real SDK connects here by changing only
`url` in its configuration; the rest of the protocol (JSON-RPC, `listTools`,
`callTool`) is identical to talking to `mcp.prod.y.uno`.

## Stateless mode

`src/server.js` creates a **new** `McpServer` + `StreamableHTTPServerTransport`
**for every HTTP request** (`buildMcpServer()` inside the `POST /mcp`
handler), the same pattern as the official MCP SDK example
(`simpleStatelessStreamableHttp.js`). There are no MCP sessions kept alive
across requests — each ephemeral `McpServer` registers the same 17 tools
(`ping` + 4 `customers` + 2 `checkout` + 9 `payments` + 2 `merchants`) and is
closed once the response ends.

```
MCP client (real SDK or test script)
        │  POST /mcp
        ▼
createApp()  ──▶  buildMcpServer()  ──▶  registerCustomerTools(server)
                                          registerCheckoutTools(server)
                                          registerPaymentTools(server)
                                          registerMerchantTools(server)
        │
        ▼
transport.handleRequest(req, res)  ──▶  the called tool reads/writes src/store.js
```

`GET`/`DELETE /mcp` return 405 — there are no sessions to resume (SSE) or
terminate, precisely because the server is stateless at the MCP connection
level.

## Where the state lives

Business state (`customers`, `checkout_sessions`, `payments`, `merchants`)
lives in `src/store.js`, **outside** the ephemeral `McpServer` instances — a
module imported once per Node process, with its own module-level `Map`s in
memory. That way state survives across tool calls and across HTTP requests
for as long as the process keeps running. It's lost on restart — there's no
disk persistence, which is enough for development.

Each tool file (`src/tools/*.js`) imports only the store functions it needs
(`createCustomer`, `getPaymentById`, etc.) and builds the MCP response with
the helpers in `src/mcp-result.js` (`ok(payload)` / `fail(message)`).
Business-rule validation (which state transition is valid, whether a
referenced id exists) lives in the tool files, not in the store — the store
exposes read/write primitives, not rules.

## Entity model

```
customer ─┐
          │ customer_id (optional)
merchant ─┼─▶ checkout_session ──▶ payment ──▶ transaction[]
          │ merchant_id (optional)              (AUTHORIZE/PURCHASE/
          │                                       CAPTURE/CANCEL/REFUND)
          └─▶ catalog item[]
              (independent from payments — read-only)
```

- A **customer** can be created standalone or linked to a `checkout_session`
  via `customer_id`.
- A **merchant** (one of the ~100 seeded in `store.js`, see
  [scope-and-fidelity.md](scope-and-fidelity.md)) can be linked to a
  `checkout_session` via `merchant_id`, optional just like `customer_id`.
- A **payment** always originates from an existing `checkout_session`
  (`paymentAuthorize`/`paymentCreate` require `checkout_session`, they don't
  build one from scratch) — it inherits `amount`/`currency`/`country`/
  `merchant_order_id`/`merchant_id` from there, and resolves `customer_payer`
  if the session had a `customer_id`.
- Every action on a payment (`paymentCaptureAuthorization`/`paymentCancel`/
  `paymentRefund`/`paymentCancelOrRefund(WithTransaction)`) appends a new
  **transaction** to the `payment.transactions` array — an existing
  transaction is never overwritten, it's append-only history.
- A merchant's **catalog** is independent from `payments` — no tool purchases
  a catalog item or links it to a payment. It's purely informational (list
  merchants, list their catalog).

`account_id` (a `payments` field) is a separate concept from `merchant_id`:
it identifies the paying user, not the merchant — see
[scope-and-fidelity.md](scope-and-fidelity.md#merchants-and-catalog-a-fully-invented-layer)
for why they're kept apart.

## Ports

Each script that starts the mock uses its own port so they can all run in
parallel (e.g. in CI) without clashing:

| Script | Port |
|---|---|
| `npm start` (`src/server.js`) | `3300` (or `$MOCK_PORT`) |
| `npm run smoke-test` | `3301` |
| `npm run test:customers` | `3302` |
| `npm run test:checkout` | `3303` |
| `npm run test:payments` | `3304` |
| `npm run test:merchants` | `3305` |
