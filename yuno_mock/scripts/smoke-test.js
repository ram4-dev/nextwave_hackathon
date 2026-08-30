// Smoke test: confirms the REAL Yuno SDK (@yuno-payments/agent-toolkit)
// connects to our local mock exactly the way it would connect to
// mcp.prod.y.uno, just by changing `url`.
//
// Uses createYunoOpenAIToolkit because internally it does the same thing as
// createYunoMcpServer on the client side: it instantiates YunoMcpClient
// (StreamableHTTPClientTransport + auth headers) and calls connect() +
// listTools() — dist/openai/index.mjs and dist/modelcontextprotocol/index.mjs
// share that same YunoMcpClient class. We pick the OpenAI adapter here only
// because it exposes getTools()/handleToolCall() directly, without also
// having to spin up an MCP client to talk to the McpServer that
// createYunoMcpServer builds — the connection to our mock is identical
// either way.

import { createYunoOpenAIToolkit } from '@yuno-payments/agent-toolkit/openai';
import { startServer } from '../src/server.js';

const PORT = 3301; // own port so it doesn't clash with a manual instance on 3300

async function main() {
  const httpServer = await startServer(PORT);

  let toolkit;
  try {
    toolkit = await createYunoOpenAIToolkit({
      accountCode: 'test-account',
      publicApiKey: 'test-public-key',
      privateSecretKey: 'test-private-key',
      url: `http://localhost:${PORT}/mcp`,
      // no `actions`: no filter, every tool the mock exposes is available
    });
  } catch (error) {
    console.error('❌ Could not connect the real Yuno SDK to the mock:', error);
    httpServer.close();
    process.exitCode = 1;
    return;
  }

  const tools = toolkit.getTools();
  console.log(`✅ Connected. Tools listed by the mock: ${tools.map((t) => t.function.name).join(', ')}`);

  if (!tools.some((t) => t.function.name === 'ping')) {
    console.error('❌ The "ping" tool is not in the list.');
    process.exitCode = 1;
  } else {
    // handleToolCall doesn't unwrap the MCP result (only
    // unwrapMcpResult inside YunoWorkflows does that,
    // dist/openai/index.mjs:162-176) — it returns the raw, stringified
    // CallToolResult: { content: [{ type, text }] }.
    const raw = await toolkit.handleToolCall('ping', { echo: 'hello from the real SDK' });
    const mcpResult = JSON.parse(raw);
    const parsed = JSON.parse(mcpResult.content[0].text);
    console.log('✅ Ping response (unwrapped):', parsed);

    if (parsed.ok !== true || parsed.echo !== 'hello from the real SDK') {
      console.error('❌ The ping response does not have the expected shape.');
      process.exitCode = 1;
    } else {
      console.log('✅ Smoke test OK: the real Yuno SDK speaks MCP with the local mock unchanged.');
    }
  }

  await toolkit.close();
  httpServer.close();
}

main();
