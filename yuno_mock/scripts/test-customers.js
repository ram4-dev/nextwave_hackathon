// End-to-end test for the `customers` category, against the real mock,
// using the real Yuno SDK (same pattern as scripts/smoke-test.js).

import { createYunoOpenAIToolkit } from '@yuno-payments/agent-toolkit/openai';
import { startServer } from '../src/server.js';

const PORT = 3302;
let failures = 0;

function check(label, condition) {
  if (condition) {
    console.log(`✅ ${label}`);
  } else {
    console.error(`❌ ${label}`);
    failures += 1;
  }
}

async function callTool(toolkit, name, args) {
  const raw = await toolkit.handleToolCall(name, args);
  const mcpResult = JSON.parse(raw);
  const text = mcpResult.content?.[0]?.text;
  // OK responses are JSON (the domain object); error responses are plain
  // text with the message (see fail() in src/mcp-result.js) — we don't
  // force JSON.parse on those.
  let data;
  if (text && !mcpResult.isError) {
    data = JSON.parse(text);
  }
  return { isError: mcpResult.isError === true, data, text };
}

async function main() {
  const httpServer = await startServer(PORT);
  const toolkit = await createYunoOpenAIToolkit({
    accountCode: 'test-account',
    publicApiKey: 'test-public-key',
    privateSecretKey: 'test-private-key',
    url: `http://localhost:${PORT}/mcp`,
  });

  // 1. customerCreate with merchant_customer_id
  const created = await callTool(toolkit, 'customerCreate', {
    first_name: 'Maria',
    last_name: 'Garcia',
    email: 'maria@example.com',
    phone: '+57 3001234567',
    merchant_customer_id: 'ext-001',
  });
  check('customerCreate returns an id', !created.isError && typeof created.data.id === 'string');
  check('customerCreate echoes the fields', created.data.email === 'maria@example.com');
  const customerId = created.data.id;

  // 2. customerRetrieve by id
  const retrieved = await callTool(toolkit, 'customerRetrieve', { customer_id: customerId });
  check('customerRetrieve finds the created customer', !retrieved.isError && retrieved.data.id === customerId);

  // 3. customerRetrieveByExternalId
  const byExternal = await callTool(toolkit, 'customerRetrieveByExternalId', { merchant_customer_id: 'ext-001' });
  check('customerRetrieveByExternalId finds the same customer', !byExternal.isError && byExternal.data.id === customerId);

  // 4. customerUpdate
  const updated = await callTool(toolkit, 'customerUpdate', { customer_id: customerId, phone: '+57 3009999999' });
  check('customerUpdate updates the requested field', !updated.isError && updated.data.phone === '+57 3009999999');
  check('customerUpdate leaves untouched fields alone', updated.data.email === 'maria@example.com');

  // 5. customerRetrieve with a nonexistent id -> error
  const notFound = await callTool(toolkit, 'customerRetrieve', { customer_id: 'cus_no_existe' });
  check('customerRetrieve with a nonexistent id returns isError', notFound.isError === true);

  // 6. customerCreate with a duplicate merchant_customer_id -> error
  const duplicate = await callTool(toolkit, 'customerCreate', {
    first_name: 'Otro',
    last_name: 'Cliente',
    email: 'otro@example.com',
    merchant_customer_id: 'ext-001',
  });
  check('customerCreate with a duplicate merchant_customer_id returns isError', duplicate.isError === true);

  await toolkit.close();
  httpServer.close();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll customers checks passed.');
  }
}

main();
