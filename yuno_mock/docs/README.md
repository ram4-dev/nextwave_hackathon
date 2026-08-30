# yuno-mcp-mock — documentation

A local MCP server that simulates `mcp.prod.y.uno`, Yuno's real remote
server. It speaks the same protocol (MCP over StreamableHTTP) that
`@yuno-payments/agent-toolkit` expects, so the real Yuno SDK can point at
this mock (`url: http://localhost:3300/mcp`) instead of the real backend,
without changing a single line on the client side.

## Where to start

- **[architecture.md](architecture.md)** — how the server is put together:
  the protocol, the stateless mode, where the in-memory state lives, and how
  entities relate to each other (`customer` → `checkout_session` →
  `payment` → `transaction`, `merchant` → `catalog item`).
- **[tools-reference.md](tools-reference.md)** — complete reference of the 17
  tools the mock exposes: input, output, and error cases for each one.
- **[scope-and-fidelity.md](scope-and-fidelity.md)** — how faithful each part
  of the mock is to Yuno's real API (`docs.y.uno`), what was deliberately
  left out, and which categories are entirely invented for this project.

## Quickstart

```bash
npm install
npm start                # starts the mock at http://localhost:3300/mcp
```

End-to-end tests (each one spins up its own server instance on its own port
and talks to it using the real `@yuno-payments/agent-toolkit` SDK, not a
hand-rolled HTTP client):

```bash
npm run smoke-test       # confirms the real SDK connects and lists tools
npm run test:customers
npm run test:checkout
npm run test:payments
npm run test:merchants
```

## Project layout

```
src/
  server.js            # MCP + Express scaffolding, stateless per request
  store.js             # all in-memory state (customers, checkout sessions,
                        # payments+transactions, merchants+catalog)
  mcp-result.js         # ok()/fail() helpers to build the CallToolResult
  payment-methods.js    # country -> available payment methods table
  tools/
    customers.js         # `customers` category (4 tools)
    checkout.js           # `checkout` category (2 tools)
    payments.js            # `payments` category (9 tools)
    merchants.js             # `merchants` category (2 tools, invented)
scripts/
  smoke-test.js          # confirms real SDK <-> mock connectivity
  test-customers.js
  test-checkout.js
  test-payments.js
  test-merchants.js
docs/                   # this folder
```

State lives in memory (`src/store.js`) for as long as the Node process keeps
running — there is no disk persistence. Every restart starts from scratch,
except for the merchant directory, which always re-seeds identically
(deterministic, not random) as soon as the module is imported.
