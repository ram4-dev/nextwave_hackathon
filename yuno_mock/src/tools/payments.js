// Tools for the `payments` category — the 9 tools confirmed in Yuno's real
// inventory: paymentCreate, paymentAuthorize, paymentCaptureAuthorization,
// paymentRetrieve, paymentRetrieveByMerchantOrderId, paymentCancel,
// paymentRefund, paymentCancelOrRefund, paymentCancelOrRefundWithTransaction.
// Full per-tool input/output reference: docs/tools-reference.md. How
// faithful each shape is to docs.y.uno, and what was deliberately cut
// (PCI card_data, 3DS, fraud_screening, split_marketplace,
// device_fingerprints, currency_conversion, receipts/webhooks,
// additional_data.order/taxes/items): docs/scope-and-fidelity.md.
//
// Input decision worth keeping in mind: paymentCreate/paymentAuthorize take
// `checkout_session` + `payment_method` instead of the full REST body —
// everything already in the checkout session
// (description/country/amount/currency/merchant_order_id/customer_id/
// merchant_id) is derived from there, not repeated. It's a deliberate
// simplification for a tool meant for agents, not something confirmed by
// the real SDK. `account_id` is its own input field, unrelated to
// `merchant_id` (which comes from the session) — it identifies the paying
// user.
//
// `payment_method.detail.card.capture` decides auth-only vs. auth+capture
// in one step, applied to the `transactions` model as real sub-entities of
// each payment.
//
// `status`/`sub_status` vocabulary: the full official enum in UPPERCASE
// (docs.y.uno/reference/payments/status-and-response-codes/payment). The
// mock only moves through the subset that makes up a successful flow — it
// never models a failed transaction (DECLINED/REJECTED/ERROR/FRAUD/
// CHARGEBACK/IN_DISPUTE are deliberately out of scope).

import { z } from 'zod';
import { ok, fail } from '../mcp-result.js';
import {
  getCheckoutSession,
  getCustomerById,
  createPayment,
  getPaymentById,
  getPaymentsByMerchantOrderId,
  findTransaction,
  addTransaction,
  updatePaymentStatus,
} from '../store.js';

// docs.y.uno/reference/payments/capture-authorization
const CAPTURE_REASONS = ['PRODUCT_CONFIRMED', 'REQUESTED_BY_CUSTOMER'];
// docs.y.uno/reference/payments/cancel-payment
const CANCEL_REASONS = ['DUPLICATE', 'FRAUDULENT', 'REQUESTED_BY_CUSTOMER'];
// docs.y.uno/reference/payments/refund-payment (+REVERSE, absent from cancel)
const REFUND_REASONS = ['DUPLICATE', 'FRAUDULENT', 'REQUESTED_BY_CUSTOMER', 'REVERSE'];

const AMOUNT_SCHEMA = z.object({ currency: z.string(), value: z.number().positive() });

function isCancellableTransaction(payment, transaction) {
  return transaction?.type === 'AUTHORIZE' && payment.status === 'PENDING' && payment.sub_status === 'AUTHORIZED';
}

function remainingRefundable(payment) {
  return payment.amount.captured - payment.amount.refunded;
}

function tryCancel({ payment, transaction, merchant_reference }) {
  if (!isCancellableTransaction(payment, transaction)) {
    return {
      error: `No se puede cancelar la transacción "${transaction?.id}" (payment en status "${payment.status}"/sub_status "${payment.sub_status}")`,
    };
  }
  const newTransaction = addTransaction(payment, { type: 'CANCEL', amount: payment.amount, merchant_reference });
  updatePaymentStatus(payment, { status: 'CANCELED' });
  return { transaction: newTransaction };
}

function tryRefund({ payment, merchant_reference, amount }) {
  const refundable = remainingRefundable(payment);
  if (refundable <= 0) {
    return { error: `No hay saldo capturado para reembolsar en este payment (status "${payment.status}")` };
  }
  const refundValue = amount?.value ?? refundable;
  if (refundValue > refundable) {
    return {
      error: `El monto a reembolsar (${refundValue}) supera el saldo capturado disponible (${refundable})`,
    };
  }

  payment.amount.refunded += refundValue;
  const newTransaction = addTransaction(payment, { type: 'REFUND', amount: payment.amount, merchant_reference });
  const isFull = payment.amount.refunded >= payment.amount.captured;
  updatePaymentStatus(payment, {
    status: isFull ? 'REFUNDED' : 'SUCCEEDED',
    sub_status: isFull ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
  });
  return { transaction: newTransaction };
}

// Transaction wrapper with the Payment nested in it — same pattern used for
// capture/cancel/refund/cancelOrRefund, with the full Transaction shape
// (docs.y.uno/reference/payments/status-and-response-codes/transaction).
function transactionResult(transaction, payment) {
  return { ...transaction, payment };
}

// Builds a new Payment from an existing checkout session — derives
// description/country/amount/currency/merchant_order_id/merchant_id from it
// (see note above), and resolves customer_payer from the real customer if
// the session has a customer_id (read-only reuse of src/store.js, without
// touching its shape).
function buildPaymentFromSession({ checkout_session, payment_method, account_id, merchant_reference, idempotency_key, capture }) {
  const session = getCheckoutSession(checkout_session);
  if (!session) return { error: `No existe un checkout_session "${checkout_session}"` };

  const customer = session.customer_id ? getCustomerById(session.customer_id) : null;
  const customerPayer = customer
    ? {
        id: customer.id,
        merchant_customer_id: customer.merchant_customer_id,
        first_name: customer.first_name,
        last_name: customer.last_name,
        email: customer.email,
        phone: customer.phone,
      }
    : null;

  const payment = createPayment({
    account_id,
    merchant_order_id: session.merchant_order_id,
    merchant_id: session.merchant_id,
    description: session.description ?? `Pago para la orden ${session.merchant_order_id}`,
    country: session.country,
    amount: { currency: session.currency, value: session.amount },
    payment_method,
    checkout_session,
    customer_payer: customerPayer,
    merchant_reference,
    idempotency_key,
    capture,
  });
  return { payment };
}

export function registerPaymentTools(server) {
  server.registerTool(
    'paymentAuthorize',
    {
      description: 'Authorize without capture', // README.md:299
      inputSchema: {
        checkout_session: z.string(),
        payment_method: z.record(z.string(), z.unknown()), // internal shape not confirmed
        account_id: z.string(),
        merchant_reference: z.string().optional(),
        idempotency_key: z.string().optional(),
      },
    },
    async ({ checkout_session, payment_method, account_id, merchant_reference, idempotency_key }) => {
      const { payment, error } = buildPaymentFromSession({
        checkout_session,
        payment_method,
        account_id,
        merchant_reference,
        idempotency_key,
        capture: false, // forced — this tool never captures, unlike paymentCreate
      });
      if (error) return fail(error);
      return ok(payment);
    },
  );

  server.registerTool(
    'paymentCreate',
    {
      description: 'Create a payment', // README.md:292
      inputSchema: {
        checkout_session: z.string(),
        payment_method: z.record(z.string(), z.unknown()),
        account_id: z.string(),
        merchant_reference: z.string().optional(),
        idempotency_key: z.string().optional(),
      },
    },
    async ({ checkout_session, payment_method, account_id, merchant_reference, idempotency_key }) => {
      // payment_method.detail.card.capture=false -> same behavior as
      // paymentAuthorize (confirmed by the official docs: it's the same endpoint).
      const capture = payment_method?.detail?.card?.capture ?? true;
      const { payment, error } = buildPaymentFromSession({
        checkout_session,
        payment_method,
        account_id,
        merchant_reference,
        idempotency_key,
        capture,
      });
      if (error) return fail(error);
      return ok(payment);
    },
  );

  server.registerTool(
    'paymentCaptureAuthorization',
    {
      description: 'Capture an authorized payment', // README.md:300
      inputSchema: {
        payment_id: z.string(),
        transaction_id: z.string(),
        merchant_reference: z.string(),
        reason: z.enum(CAPTURE_REASONS).optional(),
        amount: AMOUNT_SCHEMA.optional(), // partial capture
      },
    },
    async ({ payment_id, transaction_id, merchant_reference, amount }) => {
      const payment = getPaymentById(payment_id);
      if (!payment) return fail(`No existe un payment con id "${payment_id}"`);

      const transaction = findTransaction(payment, transaction_id);
      if (!transaction) return fail(`No existe una transaction "${transaction_id}" en el payment "${payment_id}"`);
      if (transaction.type !== 'AUTHORIZE' || payment.sub_status !== 'AUTHORIZED') {
        return fail(
          `No se puede capturar: la transacción "${transaction_id}" no es una autorización pendiente (payment sub_status "${payment.sub_status}")`,
        );
      }

      const captureValue = amount?.value ?? payment.amount.value;
      if (captureValue > payment.amount.value) {
        return fail(`El monto a capturar (${captureValue}) supera el monto autorizado (${payment.amount.value})`);
      }

      payment.amount.captured = captureValue;
      const newTransaction = addTransaction(payment, { type: 'CAPTURE', amount: payment.amount, merchant_reference });
      updatePaymentStatus(payment, {
        status: 'SUCCEEDED',
        sub_status: captureValue < payment.amount.value ? 'PARTIALLY_CAPTURED' : 'CAPTURED',
      });
      return ok(transactionResult(newTransaction, payment));
    },
  );

  server.registerTool(
    'paymentRetrieve',
    {
      description: 'Retrieve payment details', // README.md:293
      inputSchema: {
        payment_id: z.string(),
        // defaults to false in the real docs — when omitted, `transactions`
        // is left out of the response (see docs/tools-reference.md).
        transactions_history: z.boolean().optional(),
      },
    },
    async ({ payment_id, transactions_history }) => {
      const payment = getPaymentById(payment_id);
      if (!payment) return fail(`No existe un payment con id "${payment_id}"`);
      if (transactions_history) return ok(payment);
      const { transactions, ...withoutHistory } = payment;
      return ok(withoutHistory);
    },
  );

  server.registerTool(
    'paymentRetrieveByMerchantOrderId',
    {
      description: 'Retrieve by order ID', // README.md:294
      inputSchema: {
        merchant_order_id: z.string(),
      },
    },
    async ({ merchant_order_id }) => {
      // The real REST API returns an array (there can be more than one
      // payment per order, e.g. retries) — see docs/tools-reference.md.
      const list = getPaymentsByMerchantOrderId(merchant_order_id);
      if (list.length === 0) {
        return fail(`No existe ningún payment con merchant_order_id "${merchant_order_id}"`);
      }
      return ok(list);
    },
  );

  server.registerTool(
    'paymentCancel',
    {
      description: 'Cancel a pending payment', // README.md:296
      inputSchema: {
        payment_id: z.string(),
        transaction_id: z.string(),
        merchant_reference: z.string(),
        description: z.string().optional(),
        reason: z.enum(CANCEL_REASONS).optional(),
      },
    },
    async ({ payment_id, transaction_id, merchant_reference }) => {
      const payment = getPaymentById(payment_id);
      if (!payment) return fail(`No existe un payment con id "${payment_id}"`);
      const transaction = findTransaction(payment, transaction_id);
      if (!transaction) return fail(`No existe una transaction "${transaction_id}" en el payment "${payment_id}"`);

      const result = tryCancel({ payment, transaction, merchant_reference });
      if (result.error) return fail(result.error);
      return ok(transactionResult(result.transaction, payment));
    },
  );

  server.registerTool(
    'paymentRefund',
    {
      description: 'Refund a payment', // README.md:295
      inputSchema: {
        payment_id: z.string(),
        transaction_id: z.string(),
        merchant_reference: z.string(),
        description: z.string().optional(),
        reason: z.enum(REFUND_REASONS).optional(),
        amount: AMOUNT_SCHEMA.optional(), // partial refund
      },
    },
    async ({ payment_id, transaction_id, merchant_reference, amount }) => {
      const payment = getPaymentById(payment_id);
      if (!payment) return fail(`No existe un payment con id "${payment_id}"`);
      const transaction = findTransaction(payment, transaction_id);
      if (!transaction) return fail(`No existe una transaction "${transaction_id}" en el payment "${payment_id}"`);

      const result = tryRefund({ payment, merchant_reference, amount });
      if (result.error) return fail(result.error);
      return ok(transactionResult(result.transaction, payment));
    },
  );

  server.registerTool(
    'paymentCancelOrRefund',
    {
      description: 'Smart cancel/refund based on payment state', // README.md:297
      inputSchema: {
        payment_id: z.string(),
        description: z.string().optional(),
        merchant_reference: z.string().optional(),
        // Required here (unlike paymentCancel/paymentRefund) — confirmed by
        // docs.y.uno/reference/payments/cancel-or-refund-a-payment.
        reason: z.enum(REFUND_REASONS),
        amount: AMOUNT_SCHEMA.optional(),
      },
    },
    async ({ payment_id, merchant_reference, amount }) => {
      const payment = getPaymentById(payment_id);
      if (!payment) return fail(`No existe un payment con id "${payment_id}"`);

      // Doesn't take a transaction_id — unlike the WithTransaction variant,
      // it figures out on its own which transaction is relevant based on
      // the current state.
      const cancellable = payment.status === 'PENDING' && payment.sub_status === 'AUTHORIZED';
      const result = cancellable
        ? tryCancel({ payment, transaction: payment.transactions.find((t) => t.type === 'AUTHORIZE'), merchant_reference })
        : tryRefund({ payment, merchant_reference, amount });

      if (result.error) return fail(result.error);
      return ok(transactionResult(result.transaction, payment));
    },
  );

  server.registerTool(
    'paymentCancelOrRefundWithTransaction',
    {
      description: 'Cancel/refund a specific transaction', // README.md:298
      inputSchema: {
        payment_id: z.string(),
        transaction_id: z.string(),
        description: z.string().optional(),
        merchant_reference: z.string().optional(),
        // Unlike paymentCancelOrRefund, it's optional here (confirmed by
        // docs.y.uno/reference/cancel-or-refund-payment-with-transaction).
        reason: z.enum(REFUND_REASONS).optional(),
        amount: AMOUNT_SCHEMA.optional(),
      },
    },
    async ({ payment_id, transaction_id, merchant_reference, amount }) => {
      const payment = getPaymentById(payment_id);
      if (!payment) return fail(`No existe un payment con id "${payment_id}"`);
      const transaction = findTransaction(payment, transaction_id);
      if (!transaction) return fail(`No existe una transaction "${transaction_id}" en el payment "${payment_id}"`);

      const cancellable = isCancellableTransaction(payment, transaction);
      const result = cancellable
        ? tryCancel({ payment, transaction, merchant_reference })
        : tryRefund({ payment, merchant_reference, amount });

      if (result.error) return fail(result.error);
      return ok(transactionResult(result.transaction, payment));
    },
  );
}
