// End-to-end test for the `checkout` category, against the real mock, using
// the real Yuno SDK (same pattern as test-customers.js).

import { createYunoOpenAIToolkit } from '@yuno-payments/agent-toolkit/openai';
import { startServer } from '../src/server.js';

const PORT = 3303;
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

  // 1. A real customer, to test the customer_id -> checkout session link
  const customer = await callTool(toolkit, 'customerCreate', {
    first_name: 'Maria',
    last_name: 'Garcia',
    email: 'maria@example.com',
  });
  const customerId = customer.data.id;

  // 2. checkoutSessionCreate happy path, with customer_id
  const session = await callTool(toolkit, 'checkoutSessionCreate', {
    amount: 15000,
    currency: 'COP',
    country: 'CO',
    merchant_order_id: 'order-001',
    customer_id: customerId,
  });
  check('checkoutSessionCreate returns checkout_session', !session.isError && typeof session.data.checkout_session === 'string');
  check('checkoutSessionCreate starts in status "created"', session.data.status === 'created');
  check('checkoutSessionCreate echoes the amount', session.data.amount === 15000);
  const checkoutSessionId = session.data.checkout_session;

  // 3. checkoutSessionCreate with a nonexistent customer_id -> error
  const badCustomer = await callTool(toolkit, 'checkoutSessionCreate', {
    amount: 100,
    currency: 'COP',
    country: 'CO',
    merchant_order_id: 'order-002',
    customer_id: 'cus_no_existe',
  });
  check('checkoutSessionCreate with a nonexistent customer_id returns isError', badCustomer.isError === true);

  // 4. checkoutSessionRetrievePaymentMethods for CO -> CARD + PSE, as a direct array
  const methodsCO = await callTool(toolkit, 'checkoutSessionRetrievePaymentMethods', {
    checkout_session: checkoutSessionId,
  });
  check('checkoutSessionRetrievePaymentMethods returns a direct array', Array.isArray(methodsCO.data));
  const typesCO = methodsCO.data?.map((m) => m.type);
  check(
    'checkoutSessionRetrievePaymentMethods returns CARD+PSE for CO',
    !methodsCO.isError && JSON.stringify(typesCO) === JSON.stringify(['CARD', 'PSE']),
  );
  check('the first method is marked preferred=true', methodsCO.data?.[0]?.preferred === true);
  check('the rest of the methods are marked preferred=false', methodsCO.data?.[1]?.preferred === false);

  // 5. A country with no entry in the table -> falls back to the default (CARD)
  const sessionAR = await callTool(toolkit, 'checkoutSessionCreate', {
    amount: 500,
    currency: 'ARS',
    country: 'AR',
    merchant_order_id: 'order-003',
  });
  const methodsAR = await callTool(toolkit, 'checkoutSessionRetrievePaymentMethods', {
    checkout_session: sessionAR.data.checkout_session,
  });
  const typesAR = methodsAR.data?.map((m) => m.type);
  check(
    'checkoutSessionRetrievePaymentMethods falls back to the default (CARD) for a country with no rule',
    !methodsAR.isError && JSON.stringify(typesAR) === JSON.stringify(['CARD']),
  );

  // 6. checkoutSessionRetrievePaymentMethods with a nonexistent checkout_session -> error
  const missingSession = await callTool(toolkit, 'checkoutSessionRetrievePaymentMethods', {
    checkout_session: 'chk_no_existe',
  });
  check('checkoutSessionRetrievePaymentMethods with a nonexistent checkout_session returns isError', missingSession.isError === true);

  await toolkit.close();
  httpServer.close();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll checkout checks passed.');
  }
}

main();
