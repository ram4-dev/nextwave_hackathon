/** AP2 draft types. A draft is deliberately not a user authorization or a payment. */
export type MandateSource = { type: 'manual' | 'llm'; requestId: string };

export type CheckoutSnapshot = {
  transactionId: string;
  merchant: { id: string; legalName: string; displayName?: string; website: string };
  customerReference?: string;
  lineItems: Array<{
    productId: string;
    supplierId?: string;
    title: string;
    variantId?: string;
    quantity: number;
    unitAmountMinor: number;
    taxAmountMinor: number;
    discountAmountMinor: number;
  }>;
  shipping?: { optionId: string; amountMinor: number; label?: string };
  totals: {
    subtotalMinor: number;
    taxMinor: number;
    discountMinor: number;
    totalMinor: number;
    currency: string;
  };
  issuedAt: string;
  expiresAt: string;
  source: MandateSource;
};

export type CheckoutMandatePayload = {
  vct: 'mandate.checkout.1';
  transaction_id: string;
  checkout_hash: string;
  checkout_jwt: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  nonce: string;
  jti: string;
};

export type PaymentMandatePayload = {
  vct: 'mandate.payment.1';
  transaction_id: string;
  checkout_hash: string;
  checkout_mandate_draft_id: string;
  payee: { id: string; name: string; website: string };
  payment_amount: { amount_minor: number; currency: string };
  payment_instrument: { id: string; type: string; description_masked: string };
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  nonce: string;
  jti: string;
};

export interface MerchantSigner {
  readonly issuer: string;
  signCheckout(payload: CheckoutSnapshot): Promise<string>;
  verifyCheckout(jwt: string): Promise<CheckoutSnapshot>;
}

/** Boundary for the future trusted surface. Implementations must never be silently substituted. */
export interface UserMandateSigner {
  signUserMandate(payload: CheckoutMandatePayload | PaymentMandatePayload): Promise<string>;
}

/** Alias for the future Credential Provider integration. No production implementation exists in phase 1. */
export type CredentialProviderAdapter = UserMandateSigner;

export type StoredCheckoutDraft = {
  transactionId: string;
  checkoutHash: string;
  /** SHA-256 base64url of the exact canonical checkout draft payload that was issued. */
  payloadHash: string;
  /** Hash-only lineage metadata (no JWT / PII beyond opaque subject reference already in the draft). */
  sub: string;
  aud: string;
  /** Exact UTC draft window retained before the signed payload is truncated to seconds. */
  issuedAt: string;
  expiresAt: string;
  iat: number;
  exp: number;
};

export type StoredPaymentDraft = {
  transactionId: string;
  checkoutHash: string;
  checkoutMandateDraftId: string;
  /** SHA-256 base64url of the exact canonical payment draft payload that was issued. */
  payloadHash: string;
  /** Exact UTC payment window retained before the signed payload is truncated to seconds. */
  issuedAt: string;
  expiresAt: string;
  iat: number;
  exp: number;
};

export interface MandateReplayStore {
  consumeNonce(transactionId: string, nonce: string): Promise<void>;
  rememberCheckoutDraft(id: string, record: StoredCheckoutDraft): Promise<void>;
  getCheckoutDraft(id: string): Promise<StoredCheckoutDraft | undefined>;
  rememberPaymentDraft(id: string, record: StoredPaymentDraft): Promise<void>;
  getPaymentDraft(id: string): Promise<StoredPaymentDraft | undefined>;
}
