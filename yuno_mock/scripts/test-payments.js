// End-to-end test for the `payments` category (see docs/tools-reference.md
// and docs/scope-and-fidelity.md), against the real mock, using the real
// Yuno SDK (same pattern as the other tests).

import { createYunoOpenAIToolkit } from '@yuno-payments/agent-toolkit/openai';
import { startServer } from '../src/server.js';

const PORT = 3304;
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

async function newCheckoutSession(toolkit, { amount, country = 'CO', merchant_order_id, merchant_id }) {
  const session = await callTool(toolkit, 'checkoutSessionCreate', {
    amount,
    currency: 'COP',
    country,
    merchant_order_id,
    merchant_id,
  });
  return session.data.checkout_session;
}

async function main() {
  const httpServer = await startServer(PORT);
  const toolkit = await createYunoOpenAIToolkit({
    accountCode: 'test-account',
    publicApiKey: 'test-public-key',
    privateSecretKey: 'test-private-key',
    url: `http://localhost:${PORT}/mcp`,
  });

  const ACCOUNT_ID = 'acc_payer_test';

  // --- Two-step flow: authorize -> capture -> full refund ---
  const sessionA = await newCheckoutSession(toolkit, {
    amount: 10000,
    merchant_order_id: 'order-A',
    merchant_id: 'mer_001',
  });

  const authorized = await callTool(toolkit, 'paymentAuthorize', {
    checkout_session: sessionA,
    payment_method: { type: 'CARD', token: 'tok_test' },
    account_id: ACCOUNT_ID,
  });
  check('paymentAuthorize returns status "PENDING"/sub_status "AUTHORIZED"', !authorized.isError && authorized.data.status === 'PENDING' && authorized.data.sub_status === 'AUTHORIZED');
  check('paymentAuthorize propagates merchant_id from the session', authorized.data.merchant_id === 'mer_001');
  const paymentA = authorized.data.id;
  const authTxnA = authorized.data.transactions[0].id;
  check('paymentAuthorize creates an AUTHORIZE transaction', authorized.data.transactions[0].type === 'AUTHORIZE');

  const captured = await callTool(toolkit, 'paymentCaptureAuthorization', {
    payment_id: paymentA,
    transaction_id: authTxnA,
    merchant_reference: 'ref-capture-A',
  });
  check('paymentCaptureAuthorization returns type="CAPTURE"', !captured.isError && captured.data.type === 'CAPTURE');
  check('paymentCaptureAuthorization moves to status SUCCEEDED/sub_status CAPTURED', captured.data.payment.status === 'SUCCEEDED' && captured.data.payment.sub_status === 'CAPTURED');
  check('paymentCaptureAuthorization captures the full amount', captured.data.payment.amount.captured === 10000);

  const doubleCapture = await callTool(toolkit, 'paymentCaptureAuthorization', {
    payment_id: paymentA,
    transaction_id: authTxnA,
    merchant_reference: 'ref-capture-A-2',
  });
  check('capturing an already-captured authorization again errors out', doubleCapture.isError === true);

  const retrievedNoHistory = await callTool(toolkit, 'paymentRetrieve', { payment_id: paymentA });
  check('paymentRetrieve returns the updated state', !retrievedNoHistory.isError && retrievedNoHistory.data.status === 'SUCCEEDED');
  check('paymentRetrieve without transactions_history omits `transactions`', retrievedNoHistory.data.transactions === undefined);

  const retrievedWithHistory = await callTool(toolkit, 'paymentRetrieve', { payment_id: paymentA, transactions_history: true });
  check('paymentRetrieve with transactions_history=true includes `transactions`', Array.isArray(retrievedWithHistory.data.transactions) && retrievedWithHistory.data.transactions.length === 2);

  const byOrderId = await callTool(toolkit, 'paymentRetrieveByMerchantOrderId', { merchant_order_id: 'order-A' });
  check('paymentRetrieveByMerchantOrderId returns an array', Array.isArray(byOrderId.data) && byOrderId.data.length === 1);
  check('paymentRetrieveByMerchantOrderId finds the same payment', byOrderId.data[0].id === paymentA);

  const captureTxnA = captured.data.id;
  const refunded = await callTool(toolkit, 'paymentRefund', {
    payment_id: paymentA,
    transaction_id: captureTxnA,
    merchant_reference: 'ref-refund-A',
    reason: 'REQUESTED_BY_CUSTOMER',
  });
  check('paymentRefund returns type="REFUND"', !refunded.isError && refunded.data.type === 'REFUND');
  check('a full refund moves to status REFUNDED/sub_status REFUNDED', refunded.data.payment.status === 'REFUNDED' && refunded.data.payment.sub_status === 'REFUNDED');
  check('a full refund refunds the whole amount', refunded.data.payment.amount.refunded === 10000);

  // reason outside the enum -> schema validation error, on a fresh payment
  // (so "invalid state" isn't confused with "invalid reason")
  const sessionReason = await newCheckoutSession(toolkit, { amount: 100, merchant_order_id: 'order-reason' });
  const forReasonCheck = await callTool(toolkit, 'paymentCreate', {
    checkout_session: sessionReason,
    payment_method: { type: 'CARD' },
    account_id: ACCOUNT_ID,
  });
  const badReason = await callTool(toolkit, 'paymentRefund', {
    payment_id: forReasonCheck.data.id,
    transaction_id: forReasonCheck.data.transactions[0].id,
    merchant_reference: 'ref-bad-reason',
    reason: 'because_i_said_so',
  });
  check('paymentRefund with a reason outside the enum errors out', badReason.isError === true);

  const doubleRefund = await callTool(toolkit, 'paymentRefund', {
    payment_id: paymentA,
    transaction_id: captureTxnA,
    merchant_reference: 'ref-refund-A-2',
  });
  check('refunding an already-refunded payment again errors out', doubleRefund.isError === true);

  // --- One-step flow: paymentCreate (auth + capture together) ---
  const sessionB = await newCheckoutSession(toolkit, { amount: 5000, merchant_order_id: 'order-B' });
  const createdDirect = await callTool(toolkit, 'paymentCreate', {
    checkout_session: sessionB,
    payment_method: { type: 'CARD', token: 'tok_test' },
    account_id: ACCOUNT_ID,
  });
  check('paymentCreate leaves the direct payment in SUCCEEDED/CAPTURED', !createdDirect.isError && createdDirect.data.status === 'SUCCEEDED' && createdDirect.data.sub_status === 'CAPTURED');
  check('paymentCreate captures the full amount in one go', createdDirect.data.amount.captured === 5000);
  check('paymentCreate creates a PURCHASE transaction', createdDirect.data.transactions[0].type === 'PURCHASE');
  check('paymentCreate with no merchant_id on the session leaves merchant_id null', createdDirect.data.merchant_id === null);

  // --- Idempotency ---
  const idemA = await callTool(toolkit, 'paymentCreate', {
    checkout_session: sessionB,
    payment_method: { type: 'CARD' },
    account_id: ACCOUNT_ID,
    idempotency_key: 'idem-key-1',
  });
  const idemB = await callTool(toolkit, 'paymentCreate', {
    checkout_session: sessionB,
    payment_method: { type: 'CARD' },
    account_id: ACCOUNT_ID,
    idempotency_key: 'idem-key-1',
  });
  check('reusing idempotency_key with the same account_id returns the same payment', idemA.data.id === idemB.data.id);

  // --- Canceling an authorized (uncaptured) payment ---
  const sessionC = await newCheckoutSession(toolkit, { amount: 2000, merchant_order_id: 'order-C' });
  const toCancel = await callTool(toolkit, 'paymentAuthorize', {
    checkout_session: sessionC,
    payment_method: { type: 'CARD' },
    account_id: ACCOUNT_ID,
  });
  const canceled = await callTool(toolkit, 'paymentCancel', {
    payment_id: toCancel.data.id,
    transaction_id: toCancel.data.transactions[0].id,
    merchant_reference: 'ref-cancel-C',
    reason: 'REQUESTED_BY_CUSTOMER',
  });
  check('paymentCancel returns type="CANCEL"', !canceled.isError && canceled.data.type === 'CANCEL');
  check('paymentCancel on an authorized payment moves to status CANCELED', canceled.data.payment.status === 'CANCELED');

  const cancelCaptured = await callTool(toolkit, 'paymentCancel', {
    payment_id: createdDirect.data.id,
    transaction_id: createdDirect.data.transactions[0].id,
    merchant_reference: 'ref-cancel-captured',
  });
  check('paymentCancel on an already-SUCCEEDED payment errors out', cancelCaptured.isError === true);

  // --- paymentCancelOrRefund: the "cancel" branch (authorized payment) ---
  const sessionD = await newCheckoutSession(toolkit, { amount: 3000, merchant_order_id: 'order-D' });
  const authorizedD = await callTool(toolkit, 'paymentAuthorize', {
    checkout_session: sessionD,
    payment_method: { type: 'CARD' },
    account_id: ACCOUNT_ID,
  });
  const smartCancel = await callTool(toolkit, 'paymentCancelOrRefund', {
    payment_id: authorizedD.data.id,
    reason: 'REQUESTED_BY_CUSTOMER',
  });
  check(
    'paymentCancelOrRefund on "authorized" cancels (type=CANCEL)',
    !smartCancel.isError && smartCancel.data.type === 'CANCEL' && smartCancel.data.payment.status === 'CANCELED',
  );

  const missingReason = await callTool(toolkit, 'paymentCancelOrRefund', { payment_id: authorizedD.data.id });
  check('paymentCancelOrRefund without a reason errors out (required here, unlike Cancel/Refund)', missingReason.isError === true);

  // --- paymentCancelOrRefund: the "refund" branch (succeeded payment) ---
  const sessionE = await newCheckoutSession(toolkit, { amount: 7000, merchant_order_id: 'order-E' });
  const createdE = await callTool(toolkit, 'paymentCreate', {
    checkout_session: sessionE,
    payment_method: { type: 'CARD' },
    account_id: ACCOUNT_ID,
  });
  const smartRefund = await callTool(toolkit, 'paymentCancelOrRefund', {
    payment_id: createdE.data.id,
    reason: 'REQUESTED_BY_CUSTOMER',
  });
  check(
    'paymentCancelOrRefund on "succeeded" refunds (type=REFUND)',
    !smartRefund.isError && smartRefund.data.type === 'REFUND' && smartRefund.data.payment.status === 'REFUNDED',
  );

  // --- paymentCancelOrRefundWithTransaction ---
  const sessionG = await newCheckoutSession(toolkit, { amount: 4000, merchant_order_id: 'order-G' });
  const authorizedG = await callTool(toolkit, 'paymentAuthorize', {
    checkout_session: sessionG,
    payment_method: { type: 'CARD' },
    account_id: ACCOUNT_ID,
  });
  const withTxnCancel = await callTool(toolkit, 'paymentCancelOrRefundWithTransaction', {
    payment_id: authorizedG.data.id,
    transaction_id: authorizedG.data.transactions[0].id,
  });
  check(
    'paymentCancelOrRefundWithTransaction with no reason (optional here) cancels an authorization',
    !withTxnCancel.isError && withTxnCancel.data.type === 'CANCEL',
  );

  // --- Partial refund ---
  const sessionF = await newCheckoutSession(toolkit, { amount: 1000, merchant_order_id: 'order-F' });
  const createdF = await callTool(toolkit, 'paymentCreate', {
    checkout_session: sessionF,
    payment_method: { type: 'CARD' },
    account_id: ACCOUNT_ID,
  });
  const partialRefund = await callTool(toolkit, 'paymentRefund', {
    payment_id: createdF.data.id,
    transaction_id: createdF.data.transactions[0].id,
    merchant_reference: 'ref-partial-F',
    amount: { currency: 'COP', value: 400 },
  });
  check('a partial refund moves to sub_status PARTIALLY_REFUNDED', !partialRefund.isError && partialRefund.data.payment.sub_status === 'PARTIALLY_REFUNDED');
  check('a partial refund keeps status SUCCEEDED', partialRefund.data.payment.status === 'SUCCEEDED');
  check('a partial refund only refunds what was requested', partialRefund.data.payment.amount.refunded === 400);

  const overRefund = await callTool(toolkit, 'paymentRefund', {
    payment_id: createdF.data.id,
    transaction_id: createdF.data.transactions[0].id,
    merchant_reference: 'ref-over-F',
    amount: { currency: 'COP', value: 999999 },
  });
  check('refunding more than what is available errors out', overRefund.isError === true);

  // --- Error cases on nonexistent entities ---
  const missingPayment = await callTool(toolkit, 'paymentRetrieve', { payment_id: 'pay_no_existe' });
  check('paymentRetrieve with a nonexistent id errors out', missingPayment.isError === true);

  const missingOrder = await callTool(toolkit, 'paymentRetrieveByMerchantOrderId', { merchant_order_id: 'no-existe' });
  check('paymentRetrieveByMerchantOrderId with a nonexistent order id errors out', missingOrder.isError === true);

  const badAuthorize = await callTool(toolkit, 'paymentAuthorize', {
    checkout_session: 'chk_no_existe',
    payment_method: { type: 'CARD' },
    account_id: ACCOUNT_ID,
  });
  check('paymentAuthorize with a nonexistent checkout_session errors out', badAuthorize.isError === true);

  const missingTransaction = await callTool(toolkit, 'paymentCaptureAuthorization', {
    payment_id: paymentA,
    transaction_id: 'txn_no_existe',
    merchant_reference: 'ref-missing-txn',
  });
  check('paymentCaptureAuthorization with a nonexistent transaction_id errors out', missingTransaction.isError === true);

  await toolkit.close();
  httpServer.close();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll payments checks passed.');
  }
}

main();
