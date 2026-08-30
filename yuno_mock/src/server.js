// Mock server scaffolding for mcp.prod.y.uno
//
// This server exposes MCP over StreamableHTTP (the same transport
// YunoMcpClient uses on the real client side — see dist/openai/index.mjs:3
// and dist/modelcontextprotocol/index.mjs:3 of @yuno-payments/agent-toolkit).
// The real Yuno SDK connects here by pointing its `url` at this server
// instead of at https://mcp.prod.y.uno/mcp — same protocol, same client,
// nothing changes on Yuno's side.
//
// Stateless mode: a new McpServer + transport is created per HTTP request
// (same pattern as the SDK's official example,
// node_modules/@modelcontextprotocol/sdk/dist/cjs/examples/server/simpleStatelessStreamableHttp.js).
// There are no sessions kept alive across requests — real business state
// (customers / checkout_sessions / payments) lives in a separate store
// module (see src/store.js), with a lifetime of its own outside these
// ephemeral McpServer instances.

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { registerCustomerTools } from './tools/customers.js';
import { registerCheckoutTools } from './tools/checkout.js';
import { registerPaymentTools } from './tools/payments.js';
import { registerMerchantTools } from './tools/merchants.js';

function buildMcpServer() {
  const server = new McpServer(
    { name: 'yuno-mock', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // Smoke tool: not a real Yuno tool. It only confirms that an MCP client
  // can connect, list tools, and call them against this server before any
  // real logic is added.
  server.registerTool(
    'ping',
    {
      description:
        "Mock's smoke tool — confirms the server is alive and responds to tool calls.",
      inputSchema: {
        echo: z.string().optional().describe('Optional text to echo back in the response'),
      },
    },
    async ({ echo }) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            echo: echo ?? null,
            servedAt: new Date().toISOString(),
          }),
        },
      ],
    }),
  );

  registerCustomerTools(server);
  registerCheckoutTools(server);
  registerPaymentTools(server);
  registerMerchantTools(server);

  return server;
}

export function createApp() {
  // createMcpExpressApp already includes express.json() and DNS-rebinding
  // protection for localhost (node_modules/@modelcontextprotocol/sdk/dist/cjs/server/express.js).
  const app = createMcpExpressApp();

  app.post('/mcp', async (req, res) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[yuno-mock] Error manejando request MCP:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // Stateless mode means there are no sessions to resume (GET/SSE) or
  // terminate (DELETE).
  app.get('/mcp', (_req, res) => {
    res.status(405).json({ error: 'Method not allowed: este mock corre en modo stateless' });
  });
  app.delete('/mcp', (_req, res) => {
    res.status(405).json({ error: 'Method not allowed: este mock corre en modo stateless' });
  });

  return app;
}

export function startServer(port = Number(process.env.MOCK_PORT) || 3300) {
  const app = createApp();
  return new Promise((resolve) => {
    const httpServer = app.listen(port, () => {
      console.log(`[yuno-mock] Escuchando en http://localhost:${port}/mcp`);
      resolve(httpServer);
    });
  });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startServer();
}
