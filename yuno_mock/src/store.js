// In-memory state for the mock.
//
// Lives outside the McpServer instances (which server.js creates one per
// request, in stateless mode) — so state survives across tool calls for as
// long as the Node process keeps running. It's lost on restart: enough for
// development, no disk persistence (see docs/architecture.md).

import { randomUUID } from 'node:crypto';

function generateId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

// --- customers ---------------------------------------------------------

const customers = new Map(); // id -> customer
const customerIdByMerchantCustomerId = new Map(); // merchant_customer_id -> id (lookup index)

export class DuplicateMerchantCustomerIdError extends Error {
  constructor(merchantCustomerId) {
    super(`Ya existe un customer con merchant_customer_id "${merchantCustomerId}"`);
    this.name = 'DuplicateMerchantCustomerIdError';
  }
}

export function createCustomer({ first_name, last_name, email, phone, merchant_customer_id }) {
  if (merchant_customer_id && customerIdByMerchantCustomerId.has(merchant_customer_id)) {
    throw new DuplicateMerchantCustomerIdError(merchant_customer_id);
  }

  const id = generateId('cus');
  const customer = {
    id,
    first_name,
    last_name,
    email,
    phone: phone ?? null,
    merchant_customer_id: merchant_customer_id ?? null,
    created_at: new Date().toISOString(),
  };

  customers.set(id, customer);
  if (merchant_customer_id) customerIdByMerchantCustomerId.set(merchant_customer_id, id);

  return customer;
}

export function getCustomerById(customerId) {
  return customers.get(customerId) ?? null;
}

export function getCustomerByMerchantCustomerId(merchantCustomerId) {
  const id = customerIdByMerchantCustomerId.get(merchantCustomerId);
  return id ? customers.get(id) : null;
}

export function updateCustomer(customerId, patch) {
  const existing = customers.get(customerId);
  if (!existing) return null;

  const updated = {
    ...existing,
    ...patch,
    id: existing.id, // never overwritten by the patch
    updated_at: new Date().toISOString(),
  };

  customers.set(customerId, updated);
  return updated;
}

// --- checkout sessions ---------------------------------------------------

const checkoutSessions = new Map(); // checkout_session -> session

export function createCheckoutSession({
  amount,
  currency,
  country,
  merchant_order_id,
  description,
  customer_id,
  merchant_id,
}) {
  const checkoutSessionId = generateId('chk');
  const session = {
    checkout_session: checkoutSessionId,
    status: 'created',
    amount,
    currency,
    country,
    merchant_order_id,
    description: description ?? null,
    customer_id: customer_id ?? null,
    // merchant_id: cascades into payments the same way customer_id does
    // (see src/tools/merchants.js). Not a real field from Yuno's docs.
    merchant_id: merchant_id ?? null,
    created_at: new Date().toISOString(),
  };

  checkoutSessions.set(checkoutSessionId, session);
  return session;
}

export function getCheckoutSession(checkoutSessionId) {
  return checkoutSessions.get(checkoutSessionId) ?? null;
}

// --- payments --------------------------------------------------------------
//
// Model kept faithful to docs.y.uno (see docs/scope-and-fidelity.md and
// docs/tools-reference.md). Worth keeping in mind when touching this
// section (don't simplify it — see the payments-simulation-is-core memory):
// - Every Payment has `transactions: Transaction[]` — real sub-entities with
//   their own `id`, instead of the old flat `history` of annotations.
//   Actions (capture/cancel/refund) operate on `payment_id` +
//   `transaction_id`, as the real REST API documents it (`paymentCancelOrRefund`
//   is still just `payment_id` — it's the "smart" variant).
// - `status`/`sub_status` are separate fields, using the official UPPERCASE
//   vocabulary (docs.y.uno/reference/payments/status-and-response-codes/payment).
// - A `merchant_order_id` can have more than one payment (retries) —
//   `paymentIdsByMerchantOrderId` is a `Map<string, Set<id>>`, not 1:1.
// - Dedupe by `idempotency_key`: the same `account_id` + the same key
//   returns the payment already created instead of duplicating it (MCP
//   tools don't carry HTTP headers, so it's modeled as an optional input
//   field).
//
// Deliberate simplification, same as before: the mock never models a failed
// transaction — every transaction that runs ends up `SUCCEEDED`. PCI
// `card_data`, 3DS, `fraud_screening`, `split_marketplace`,
// `device_fingerprints`, `currency_conversion`, and receipts/webhooks are
// not modeled — separate subsystems that aren't part of a payment's state
// machine.

const payments = new Map(); // id -> payment
const paymentIdsByMerchantOrderId = new Map(); // merchant_order_id -> Set<id>
const paymentIdByIdempotencyKey = new Map(); // "account_id:idempotency_key" -> id

function buildTransaction({ type, amount, merchant_reference }) {
  const now = new Date().toISOString();
  return {
    id: generateId('txn'),
    type,
    status: 'SUCCEEDED',
    category: 'CARD',
    amount: { ...amount },
    merchant_reference: merchant_reference ?? null,
    created_at: now,
    updated_at: now,
    // Minimal, recognizable stubs — there's no real provider/processor
    // behind the mock, unlike what the real REST API would return.
    provider_data: { provider: 'mock-provider', id: generateId('prv') },
    connection_data: { id: generateId('conn'), name: 'mock-connection' },
    response_code: 'SUCCEEDED',
    response_message: 'Approved',
  };
}

export function createPayment({
  account_id,
  merchant_order_id,
  merchant_id,
  description,
  country,
  amount, // { currency, value }
  payment_method,
  checkout_session,
  customer_payer,
  merchant_reference,
  idempotency_key,
  capture,
}) {
  if (idempotency_key) {
    const existingId = paymentIdByIdempotencyKey.get(`${account_id}:${idempotency_key}`);
    if (existingId) return payments.get(existingId);
  }

  const id = generateId('pay');
  const now = new Date().toISOString();

  const payment = {
    id,
    account_id,
    description,
    country,
    status: capture ? 'SUCCEEDED' : 'PENDING',
    sub_status: capture ? 'CAPTURED' : 'AUTHORIZED',
    merchant_order_id,
    merchant_id: merchant_id ?? null,
    merchant_reference: merchant_reference ?? null,
    idempotency_key: idempotency_key ?? null,
    created_at: now,
    updated_at: now,
    amount: { currency: amount.currency, value: amount.value, captured: 0, refunded: 0 },
    checkout: { session: checkout_session ?? null, sdk_action_required: false },
    payment_method: payment_method ?? null,
    customer_payer: customer_payer ?? null,
    transactions: [],
    metadata: [],
  };

  if (capture) payment.amount.captured = amount.value;
  const transaction = buildTransaction({
    type: capture ? 'PURCHASE' : 'AUTHORIZE',
    amount: payment.amount,
    merchant_reference,
  });
  payment.transactions.push(transaction);

  payments.set(id, payment);

  if (!paymentIdsByMerchantOrderId.has(merchant_order_id)) {
    paymentIdsByMerchantOrderId.set(merchant_order_id, new Set());
  }
  paymentIdsByMerchantOrderId.get(merchant_order_id).add(id);

  if (idempotency_key) {
    paymentIdByIdempotencyKey.set(`${account_id}:${idempotency_key}`, id);
  }

  return payment;
}

export function getPaymentById(paymentId) {
  return payments.get(paymentId) ?? null;
}

// The real REST API returns an array — there can be more than one payment
// per order (retries). See docs/tools-reference.md, paymentRetrieveByMerchantOrderId.
export function getPaymentsByMerchantOrderId(merchantOrderId) {
  const ids = paymentIdsByMerchantOrderId.get(merchantOrderId);
  if (!ids) return [];
  return [...ids].map((paymentId) => payments.get(paymentId)).filter(Boolean);
}

export function findTransaction(payment, transactionId) {
  return payment.transactions.find((transaction) => transaction.id === transactionId) ?? null;
}

// Appends a new Transaction to an existing payment and updates
// `updated_at`. Doesn't validate business rules (which transitions are
// valid, which `payment.amount` fields to touch) — that lives in
// tools/payments.js, closer to each tool, same as before.
export function addTransaction(payment, { type, amount, merchant_reference }) {
  const transaction = buildTransaction({ type, amount, merchant_reference });
  payment.transactions.push(transaction);
  payment.updated_at = transaction.updated_at;
  return transaction;
}

export function updatePaymentStatus(payment, { status, sub_status }) {
  payment.status = status;
  if (sub_status !== undefined) payment.sub_status = sub_status;
  payment.updated_at = new Date().toISOString();
}

// --- merchants + catalog ---------------------------------------------------
//
// Merchant directory (see docs/scope-and-fidelity.md, "Merchants and
// catalog: a fully invented layer").
// Unlike customers/checkout_sessions/payments, this is NOT a real Yuno API
// resource — confirmed by fetching docs.y.uno live: no "Merchants" or
// "Catalog" category exists (the real index is Customers, Enrollment,
// Checkout, Payment Methods, Payments, Payment Links, Subscriptions,
// Payouts, Recipients for Marketplace, Reports, Installments, AI Caller,
// Communications Campaigns, Conversion Rate, Banking Connectivity). It's a
// layer of its own for this mock: reference data seeded once when the
// process starts, with stable ids (mer_001..mer_100) — not something a tool
// creates at runtime, which is why it doesn't use `generateId`/`randomUUID`.
//
// `account_id` (a real payments field) has no relation to this — it's
// exclusive to the users who pay. `merchant_id` is the new concept here, and
// it cascades through checkout/payments the same way `customer_id` does
// (see createCheckoutSession above and src/tools/checkout.js).

const CURRENCY_BY_COUNTRY = { CO: 'COP', MX: 'MXN', BR: 'BRL' };
const COUNTRIES = ['CO', 'MX', 'BR'];

// Fixed taxonomy — same approach as the country→payment-methods table in
// payment-methods.js: hand-written, editable, not dynamic. `catalogType`
// determines the catalog shape for every merchant in that category
// (deliberately differentiated by type, not one generic shape). The
// category labels themselves stay in Spanish — they're literal data
// returned by the tools and valid input values, not prose (see
// docs/scope-and-fidelity.md).
const MERCHANT_CATEGORIES = [
  { name: 'Retail/E-commerce', catalogType: 'PRODUCT', count: 9 },
  { name: 'Supermercados', catalogType: 'PRODUCT', count: 8 },
  { name: 'Moda/Indumentaria', catalogType: 'PRODUCT', count: 8 },
  { name: 'Electrónica/Tecnología', catalogType: 'PRODUCT', count: 9 },
  { name: 'Hogar/Muebles', catalogType: 'PRODUCT', count: 8 },
  { name: 'Gaming', catalogType: 'PRODUCT', count: 8 },
  { name: 'Salud/Farmacia', catalogType: 'PRODUCT', count: 8 },
  { name: 'Restaurantes/Delivery', catalogType: 'SERVICE', count: 9 },
  { name: 'Viajes/Transporte', catalogType: 'SERVICE', count: 8 },
  { name: 'Educación', catalogType: 'SERVICE', count: 9 },
  { name: 'Entretenimiento/Streaming', catalogType: 'SERVICE', count: 8 },
  { name: 'Servicios Financieros/Fintech', catalogType: 'SERVICE', count: 8 },
]; // sums to 100

const NAME_ROOTS = {
  'Retail/E-commerce': ['TiendaMax', 'ShopExpress', 'ComercioYa', 'Mercado Central'],
  Supermercados: ['SuperAndes', 'MercaFresh', 'La Canasta', 'AbastoCentral'],
  'Moda/Indumentaria': ['Moda Andina', 'Estilo Urbano', 'Ropa Total', 'Tendencia Local'],
  'Electrónica/Tecnología': ['TecnoPlus', 'DigitalHub', 'ElectroMundo', 'ByteCenter'],
  'Hogar/Muebles': ['CasaViva', 'Muebles del Sur', 'Hogar Moderno', 'DecoAndes'],
  Gaming: ['GamerZone', 'PixelPlay', 'ConsolaYa', 'Level Up'],
  'Salud/Farmacia': ['FarmaVida', 'Salud Total', 'Farmacia del Pueblo', 'BienestarYa'],
  'Restaurantes/Delivery': ['Sabor Express', 'Cocina Local', 'DeliRápido', 'Buen Sabor'],
  'Viajes/Transporte': ['ViajaYa', 'RutaSegura', 'Transporte Andino', 'MoveMax'],
  Educación: ['Aprende Ya', 'Academia Central', 'SaberMás', 'Educa Plus'],
  'Entretenimiento/Streaming': ['StreamMax', 'PlayCultura', 'CineYa', 'MúsicaTotal'],
  'Servicios Financieros/Fintech': ['FinanzasYa', 'PagoFácil', 'CréditoAndino', 'WalletPlus'],
};

// Prices as "round" numbers in whatever unit — no real FX conversion, same
// scope cut as `currency_conversion` in payments.
const PRODUCT_ITEM_POOL = {
  'Retail/E-commerce': [
    { name: 'Auriculares Bluetooth', price: 25 },
    { name: 'Mochila Urbana', price: 40 },
    { name: 'Lámpara LED', price: 15 },
    { name: 'Termo Acero Inoxidable', price: 20 },
  ],
  Supermercados: [
    { name: 'Arroz 1kg', price: 2 },
    { name: 'Aceite de Girasol 900ml', price: 4 },
    { name: 'Leche Entera 1L', price: 1.5 },
    { name: 'Café Molido 500g', price: 6 },
  ],
  'Moda/Indumentaria': [
    { name: 'Remera Básica', price: 12 },
    { name: 'Jean Slim Fit', price: 35 },
    { name: 'Campera Impermeable', price: 60 },
    { name: 'Zapatillas Running', price: 55 },
  ],
  'Electrónica/Tecnología': [
    { name: 'Smartphone 128GB', price: 350 },
    { name: 'Notebook 14"', price: 700 },
    { name: 'Smartwatch', price: 120 },
    { name: 'Cargador USB-C', price: 10 },
  ],
  'Hogar/Muebles': [
    { name: 'Silla Ergonómica', price: 90 },
    { name: 'Mesa Ratona', price: 70 },
    { name: 'Juego de Sábanas', price: 30 },
    { name: 'Organizador Modular', price: 25 },
  ],
  Gaming: [
    { name: 'Control Inalámbrico', price: 45 },
    { name: 'Auriculares Gamer', price: 55 },
    { name: 'Mousepad XL', price: 15 },
    { name: 'Silla Gamer', price: 180 },
  ],
  'Salud/Farmacia': [
    { name: 'Analgésico x20 comp.', price: 3 },
    { name: 'Vitamina C x60 comp.', price: 8 },
    { name: 'Alcohol en Gel 500ml', price: 4 },
    { name: 'Termómetro Digital', price: 10 },
  ],
};

const SERVICE_ITEM_POOL = {
  'Restaurantes/Delivery': [
    { name: 'Delivery Almuerzo Ejecutivo', price: 8, duration_minutes: 30, modality: 'IN_PERSON' },
    { name: 'Combo Familiar', price: 25, duration_minutes: 45, modality: 'IN_PERSON' },
    { name: 'Delivery Express', price: 12, duration_minutes: 20, modality: 'IN_PERSON' },
    { name: 'Reserva de Mesa', price: 0, duration_minutes: 90, modality: 'IN_PERSON' },
  ],
  'Viajes/Transporte': [
    { name: 'Traslado Aeropuerto', price: 30, duration_minutes: 45, modality: 'IN_PERSON' },
    { name: 'Alquiler de Auto (día)', price: 50, duration_minutes: 1440, modality: 'IN_PERSON' },
    { name: 'Tour Guiado Medio Día', price: 40, duration_minutes: 240, modality: 'IN_PERSON' },
    { name: 'Pase de Transporte Mensual', price: 35, duration_minutes: 43200, modality: 'IN_PERSON' },
  ],
  Educación: [
    { name: 'Clase Particular', price: 15, duration_minutes: 60, modality: 'REMOTE' },
    { name: 'Curso Online 4 Semanas', price: 80, duration_minutes: 240, modality: 'REMOTE' },
    { name: 'Tutoría Grupal', price: 10, duration_minutes: 90, modality: 'HYBRID' },
    { name: 'Taller Intensivo Fin de Semana', price: 60, duration_minutes: 480, modality: 'IN_PERSON' },
  ],
  'Entretenimiento/Streaming': [
    { name: 'Suscripción Mensual Básica', price: 6, duration_minutes: 43200, modality: 'REMOTE' },
    { name: 'Suscripción Premium', price: 12, duration_minutes: 43200, modality: 'REMOTE' },
    { name: 'Acceso Anual', price: 100, duration_minutes: 525600, modality: 'REMOTE' },
    { name: 'Plan Familiar', price: 18, duration_minutes: 43200, modality: 'REMOTE' },
  ],
  'Servicios Financieros/Fintech': [
    { name: 'Asesoría Financiera', price: 20, duration_minutes: 60, modality: 'REMOTE' },
    { name: 'Apertura de Cuenta', price: 0, duration_minutes: 30, modality: 'REMOTE' },
    { name: 'Gestión de Cartera Mensual', price: 15, duration_minutes: 43200, modality: 'REMOTE' },
    { name: 'Consultoría Tributaria', price: 25, duration_minutes: 60, modality: 'HYBRID' },
  ],
};

const merchants = new Map(); // merchant_id -> merchant
const catalogByMerchantId = new Map(); // merchant_id -> item[]

function seedMerchants() {
  const seededAt = new Date().toISOString();
  let counter = 1;

  for (const { name: category, catalogType, count } of MERCHANT_CATEGORIES) {
    const roots = NAME_ROOTS[category];
    const pool = catalogType === 'PRODUCT' ? PRODUCT_ITEM_POOL[category] : SERVICE_ITEM_POOL[category];

    for (let i = 0; i < count; i += 1) {
      const merchantId = `mer_${String(counter).padStart(3, '0')}`;
      const country = COUNTRIES[counter % COUNTRIES.length];
      const root = roots[i % roots.length];

      merchants.set(merchantId, {
        merchant_id: merchantId,
        name: `${root} ${country}-${String(i + 1).padStart(2, '0')}`,
        category,
        country,
        created_at: seededAt,
      });

      const currency = CURRENCY_BY_COUNTRY[country];
      const items = pool.map((item, itemIndex) => {
        const base = {
          id: `cat_${merchantId}_${itemIndex + 1}`,
          merchant_id: merchantId,
          type: catalogType,
          name: item.name,
          category,
          price: { currency, value: item.price },
        };
        return catalogType === 'PRODUCT'
          ? { ...base, sku: `${merchantId}-SKU-${itemIndex + 1}`, stock: 20 + itemIndex * 10 }
          : { ...base, duration_minutes: item.duration_minutes, modality: item.modality };
      });
      catalogByMerchantId.set(merchantId, items);

      counter += 1;
    }
  }
}

seedMerchants();

export const MERCHANT_CATEGORY_NAMES = MERCHANT_CATEGORIES.map((c) => c.name);

export function getAllMerchants({ category } = {}) {
  const all = [...merchants.values()];
  return category ? all.filter((merchant) => merchant.category === category) : all;
}

export function getMerchantById(merchantId) {
  return merchants.get(merchantId) ?? null;
}

// Returns `null` (not `[]`) when the merchant doesn't exist, so the tool can
// tell "merchant doesn't exist" apart from "exists but has no catalog".
export function getCatalogByMerchantId(merchantId) {
  if (!merchants.has(merchantId)) return null;
  return catalogByMerchantId.get(merchantId) ?? [];
}
