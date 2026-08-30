// Country -> available payment methods table.
//
// Country/method list picked by hand (see docs/tools-reference.md,
// checkoutSessionRetrievePaymentMethods). The SHAPE of each method does
// trace to the official docs: the real response from
// docs.y.uno/reference/checkout-sessions/retrieve-payment-methods-for-checkout
// is a direct ARRAY (not wrapped in an object) of methods with `name`,
// `type`, `category`, `preferred`, among other fields more specific to
// vaulted cards (`vaulted_token`, `card_data`, etc.) that don't apply here
// since this mock doesn't simulate a wallet or saved cards. `category` and
// `preferred` are still [inferred] — no source confirms which category maps
// to which type, so the assignment below is a reasonable choice of ours,
// not a confirmed fact. `name` strings are kept in Spanish, matching the
// rest of the merchant-facing seed data (see docs/scope-and-fidelity.md).

const COUNTRY_PAYMENT_METHODS = {
  CO: [
    { type: 'CARD', name: 'Tarjeta de crédito/débito', category: 'CARD' },
    { type: 'PSE', name: 'PSE', category: 'BANK_TRANSFER' },
  ],
  MX: [
    { type: 'CARD', name: 'Tarjeta de crédito/débito', category: 'CARD' },
    { type: 'OXXO', name: 'OXXO', category: 'CASH' },
    { type: 'SPEI', name: 'SPEI', category: 'BANK_TRANSFER' },
  ],
  BR: [
    { type: 'CARD', name: 'Tarjeta de crédito/débito', category: 'CARD' },
    { type: 'PIX', name: 'PIX', category: 'BANK_TRANSFER' },
  ],
};

const DEFAULT_PAYMENT_METHODS = [
  { type: 'CARD', name: 'Tarjeta de crédito/débito', category: 'CARD' },
];

export function paymentMethodsForCountry(country) {
  const methods = COUNTRY_PAYMENT_METHODS[country?.toUpperCase()] ?? DEFAULT_PAYMENT_METHODS;
  return methods.map((method, index) => ({ ...method, preferred: index === 0 }));
}
