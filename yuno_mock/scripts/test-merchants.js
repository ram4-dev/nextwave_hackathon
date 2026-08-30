// End-to-end test for the `merchants` category (invented — see
// docs/scope-and-fidelity.md), against the real mock, using the real Yuno
// SDK (same pattern as the other tests).

import { createYunoOpenAIToolkit } from '@yuno-payments/agent-toolkit/openai';
import { startServer } from '../src/server.js';

const PORT = 3305;
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

  // 1. merchantRetrieveAll with no filter -> all ~100 seeded merchants
  const all = await callTool(toolkit, 'merchantRetrieveAll', {});
  check('merchantRetrieveAll with no filter returns 100 merchants', !all.isError && all.data.length === 100);

  // 2. merchantRetrieveAll filtered by category
  const filtered = await callTool(toolkit, 'merchantRetrieveAll', { category: 'Gaming' });
  check(
    'merchantRetrieveAll filtered by category returns only that category',
    !filtered.isError && filtered.data.length > 0 && filtered.data.every((m) => m.category === 'Gaming'),
  );

  // 3. merchantRetrieveAll with a category outside the enum -> schema error
  const badCategory = await callTool(toolkit, 'merchantRetrieveAll', { category: 'Does Not Exist' });
  check('merchantRetrieveAll with an invalid category errors out', badCategory.isError === true);

  // 4. merchantCatalogRetrieveAll for a PRODUCT-type merchant
  const productMerchant = filtered.data[0];
  const productCatalog = await callTool(toolkit, 'merchantCatalogRetrieveAll', { merchant_id: productMerchant.merchant_id });
  check(
    'merchantCatalogRetrieveAll for a PRODUCT merchant returns items with sku/stock',
    !productCatalog.isError && productCatalog.data.length > 0 && productCatalog.data.every((item) => item.type === 'PRODUCT' && typeof item.sku === 'string'),
  );

  // 5. merchantCatalogRetrieveAll for a SERVICE-type merchant
  const serviceMerchants = await callTool(toolkit, 'merchantRetrieveAll', { category: 'Educación' });
  const serviceCatalog = await callTool(toolkit, 'merchantCatalogRetrieveAll', {
    merchant_id: serviceMerchants.data[0].merchant_id,
  });
  check(
    'merchantCatalogRetrieveAll for a SERVICE merchant returns items with duration_minutes/modality',
    !serviceCatalog.isError && serviceCatalog.data.every((item) => item.type === 'SERVICE' && typeof item.duration_minutes === 'number'),
  );

  // 6. merchantCatalogRetrieveAll with a nonexistent merchant_id -> error
  const missingMerchant = await callTool(toolkit, 'merchantCatalogRetrieveAll', { merchant_id: 'mer_999' });
  check('merchantCatalogRetrieveAll with a nonexistent merchant_id errors out', missingMerchant.isError === true);

  // 7. merchant_id cascade: checkoutSessionCreate -> paymentCreate inherits merchant_id
  const session = await callTool(toolkit, 'checkoutSessionCreate', {
    amount: 5000,
    currency: 'COP',
    country: 'CO',
    merchant_order_id: 'order-merchant-cascade',
    merchant_id: productMerchant.merchant_id,
  });
  check('checkoutSessionCreate with a valid merchant_id echoes the field', !session.isError && session.data.merchant_id === productMerchant.merchant_id);

  const payment = await callTool(toolkit, 'paymentCreate', {
    checkout_session: session.data.checkout_session,
    payment_method: { type: 'CARD' },
    account_id: 'acc_payer_test',
  });
  check(
    'paymentCreate inherits merchant_id from the checkout session',
    !payment.isError && payment.data.merchant_id === productMerchant.merchant_id,
  );

  // 8. checkoutSessionCreate with a nonexistent merchant_id -> error
  const badMerchantSession = await callTool(toolkit, 'checkoutSessionCreate', {
    amount: 100,
    currency: 'COP',
    country: 'CO',
    merchant_order_id: 'order-bad-merchant',
    merchant_id: 'mer_999',
  });
  check('checkoutSessionCreate with a nonexistent merchant_id errors out', badMerchantSession.isError === true);

  await toolkit.close();
  httpServer.close();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll merchants checks passed.');
  }
}

main();
