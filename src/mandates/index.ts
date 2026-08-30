import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../domain/state-machine.js';
import { InMemoryMandateReplayStore } from './replay-store.js';
import type {
  CheckoutMandatePayload,
  CheckoutSnapshot,
  MandateReplayStore,
  MerchantSigner,
  PaymentMandatePayload,
} from './types.js';

const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: 'currency') => string[] }).supportedValuesOf;
// Node >=20 (the supported runtime) supplies the complete ISO 4217 list. The fallback only
// keeps the local development CLI usable on older runtimes; deployment still requires Node 20.
const currencies = new Set(supportedValuesOf ? supportedValuesOf('currency') : [
  'AED', 'ARS', 'AUD', 'BRL', 'CAD', 'CHF', 'CLP', 'CNY', 'COP', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD',
  'HUF', 'IDR', 'INR', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD', 'PEN', 'PHP', 'PLN', 'RON', 'SAR',
  'SEK', 'SGD', 'THB', 'TRY', 'TWD', 'UAH', 'USD', 'UYU', 'VND', 'ZAR',
]);
const currency = z.string().regex(/^[A-Z]{3}$/).refine((value) => currencies.has(value), 'ISO 4217 currency required');
const opaqueId = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/, 'Opaque identifier required');
const nonce = opaqueId.max(512);
const utcDate = z.string().datetime({ offset: true }).refine((value) => value.endsWith('Z'), 'UTC ISO 8601 timestamp required');
const url = z.string().url().refine((value) => /^https?:\/\//.test(value), 'HTTP(S) URL required');
const minor = z.number().int().safe().nonnegative();
const amount = z.number().int().safe().positive();

const checkoutSchema = z.object({
  transactionId: opaqueId,
  merchant: z.object({ id: opaqueId, legalName: z.string().min(1).max(300), displayName: z.string().min(1).max(300).optional(), website: url }).strict(),
  customerReference: opaqueId.optional(),
  lineItems: z.array(z.object({
    productId: opaqueId, supplierId: opaqueId.optional(), title: z.string().min(1).max(500), variantId: opaqueId.optional(), quantity: amount,
    unitAmountMinor: minor, taxAmountMinor: minor.optional(), discountAmountMinor: minor.optional(),
  }).strict()).min(1),
  shipping: z.object({ optionId: opaqueId, amountMinor: minor, label: z.string().min(1).max(300).optional() }).strict().optional(),
  totals: z.object({ subtotalMinor: minor, taxMinor: minor, discountMinor: minor, totalMinor: minor, currency }).strict(),
  issuedAt: utcDate, expiresAt: utcDate,
  source: z.object({ type: z.enum(['manual', 'llm']), requestId: opaqueId }).strict(),
}).strict();

const checkoutDraftSchema = z.object({
  checkoutJwt: z.string().min(1), checkoutHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/), transactionId: opaqueId,
  userReference: opaqueId, nonce, issuedAt: utcDate, expiresAt: utcDate,
}).strict();

const paymentDraftSchema = z.object({
  transactionId: opaqueId, checkoutJwt: z.string().min(1), checkoutHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/), checkoutMandateDraftId: opaqueId,
  payee: z.object({ id: opaqueId, name: z.string().min(1).max(300), website: url }).strict(),
  paymentAmount: z.object({ amountMinor: minor, currency }).strict(),
  paymentInstrument: z.object({ id: opaqueId, type: z.string().min(1).max(100), descriptionMasked: z.string().min(5).max(200) }).strict(),
  userReference: opaqueId, nonce, issuedAt: utcDate, expiresAt: utcDate,
}).strict();

export type CreateMerchantCheckoutInput = z.input<typeof checkoutSchema>;
export type CreateCheckoutMandateDraftInput = z.input<typeof checkoutDraftSchema>;
export type CreatePaymentMandateDraftInput = z.input<typeof paymentDraftSchema>;

export type CreateMandateServiceOptions = {
  merchantSigner: MerchantSigner;
  replayStore?: MandateReplayStore;
  maxTtlSeconds?: number;
  credentialProviderAudience?: string;
  now?: () => Date;
};

export function checkoutHash(jwt: string): string {
  return createHash('sha256').update(jwt).digest('base64url');
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  try { return schema.parse(input); }
  catch (error) { throw new DomainError(`Invalid mandate input: ${(error as z.ZodError).message}`, 'MANDATE_INPUT'); }
}

function validatePeriod(issuedAt: string, expiresAt: string, maxTtlSeconds: number, now: Date): void {
  const issued = Date.parse(issuedAt); const expires = Date.parse(expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) throw new DomainError('Expiry must be after issuance', 'MANDATE_EXPIRY');
  if ((expires - issued) / 1000 > maxTtlSeconds) throw new DomainError('Mandate lifetime exceeds configured maximum', 'MANDATE_EXPIRY');
  if (expires <= now.getTime()) throw new DomainError('Mandate has expired', 'MANDATE_EXPIRED');
}

function snapshot(input: CreateMerchantCheckoutInput): CheckoutSnapshot {
  return {
    ...input,
    lineItems: input.lineItems.map((item) => ({ ...item, taxAmountMinor: item.taxAmountMinor ?? 0, discountAmountMinor: item.discountAmountMinor ?? 0 })),
  };
}

function verifyTotals(value: CheckoutSnapshot): void {
  let subtotal = 0n; let tax = 0n; let discount = 0n;
  for (const item of value.lineItems) {
    subtotal += BigInt(item.quantity) * BigInt(item.unitAmountMinor);
    tax += BigInt(item.taxAmountMinor);
    discount += BigInt(item.discountAmountMinor);
  }
  const shipping = BigInt(value.shipping?.amountMinor ?? 0);
  const expectedTotal = subtotal + tax + shipping - discount;
  const totals = value.totals;
  if (subtotal !== BigInt(totals.subtotalMinor) || tax !== BigInt(totals.taxMinor) || discount !== BigInt(totals.discountMinor) || expectedTotal !== BigInt(totals.totalMinor) || expectedTotal < 0n) {
    throw new DomainError('Checkout totals do not match line items', 'CHECKOUT_TOTALS');
  }
}

function rejectSensitiveInstrument(instrument: { id: string; type: string; descriptionMasked: string }): void {
  const raw = JSON.stringify(instrument);
  if (/\b(?:pan|cvc|cvv|token|yuno|card_number|security_code)\b/i.test(raw) || /\d{12,}/.test(instrument.id) || !/[•*xX]{2,}/.test(instrument.descriptionMasked)) {
    throw new DomainError('Payment instrument must be opaque and masked', 'PAYMENT_INSTRUMENT');
  }
}

export function createMandateService(options: CreateMandateServiceOptions) {
  const replayStore = options.replayStore ?? new InMemoryMandateReplayStore();
  const maxTtlSeconds = options.maxTtlSeconds ?? 900;
  const credentialProviderAudience = options.credentialProviderAudience ?? 'credential-provider';
  const now = options.now ?? (() => new Date());
  if (!Number.isSafeInteger(maxTtlSeconds) || maxTtlSeconds <= 0) throw new DomainError('maxTtlSeconds must be positive', 'MANDATE_CONFIG');

  async function verifiedCheckout(checkoutJwt: string, expectedHash: string, transactionId: string): Promise<CheckoutSnapshot> {
    if (checkoutHash(checkoutJwt) !== expectedHash) throw new DomainError('Checkout hash does not match JWT', 'CHECKOUT_HASH');
    const value = await options.merchantSigner.verifyCheckout(checkoutJwt);
    // JWT registered claims are verified by the signer; they are not checkout fields.
    const { iss: _iss, aud: _aud, iat: _iat, exp: _exp, nbf: _nbf, jti: _jti, ...checkoutPayload } = value as CheckoutSnapshot & Record<string, unknown>;
    const checked = snapshot(parse(checkoutSchema, checkoutPayload));
    verifyTotals(checked);
    validatePeriod(checked.issuedAt, checked.expiresAt, maxTtlSeconds, now());
    if (checked.transactionId !== transactionId) throw new DomainError('Transaction does not match checkout', 'CHECKOUT_TRANSACTION');
    return checked;
  }

  return {
    async createMerchantCheckout(input: CreateMerchantCheckoutInput) {
      const checked = snapshot(parse(checkoutSchema, input));
      validatePeriod(checked.issuedAt, checked.expiresAt, maxTtlSeconds, now());
      verifyTotals(checked);
      const checkoutJwt = await options.merchantSigner.signCheckout(checked);
      const hash = checkoutHash(checkoutJwt);
      return {
        checkoutJwt, checkoutHash: hash, transactionId: checked.transactionId, expiresAt: checked.expiresAt, checkoutSnapshot: structuredClone(checked),
        auditMetadata: { source: checked.source, merchantId: checked.merchant.id, createdAt: now().toISOString(), checkoutHash: hash },
      };
    },

    async createCheckoutMandateDraft(input: CreateCheckoutMandateDraftInput) {
      const checked = parse(checkoutDraftSchema, input);
      validatePeriod(checked.issuedAt, checked.expiresAt, maxTtlSeconds, now());
      await verifiedCheckout(checked.checkoutJwt, checked.checkoutHash, checked.transactionId);
      await replayStore.consumeNonce(checked.transactionId, checked.nonce);
      const id = `checkout_draft_${randomUUID().replace(/-/g, '')}`;
      const unsignedMandatePayload: CheckoutMandatePayload = {
        vct: 'mandate.checkout.1', transaction_id: checked.transactionId, checkout_hash: checked.checkoutHash, checkout_jwt: checked.checkoutJwt,
        sub: checked.userReference, aud: credentialProviderAudience, iat: Math.floor(Date.parse(checked.issuedAt) / 1000), exp: Math.floor(Date.parse(checked.expiresAt) / 1000), nonce: checked.nonce, jti: id,
      };
      await replayStore.rememberCheckoutDraft(id, checked.transactionId, checked.checkoutHash);
      return {
        id, mandateType: 'checkout' as const, status: 'awaiting_user_signature' as const, unsignedMandatePayload,
        signingRequest: { format: 'ap2-unsigned-payload', audience: credentialProviderAudience, payload: unsignedMandatePayload },
        mandatePreview: { merchantCheckout: checked.transactionId, expiresAt: checked.expiresAt, checkoutHash: checked.checkoutHash },
        transactionId: checked.transactionId, checkoutHash: checked.checkoutHash, expiresAt: checked.expiresAt,
      };
    },

    async createPaymentMandateDraft(input: CreatePaymentMandateDraftInput) {
      const checked = parse(paymentDraftSchema, input);
      validatePeriod(checked.issuedAt, checked.expiresAt, maxTtlSeconds, now());
      rejectSensitiveInstrument(checked.paymentInstrument);
      const checkout = await verifiedCheckout(checked.checkoutJwt, checked.checkoutHash, checked.transactionId);
      if (checkout.totals.totalMinor !== checked.paymentAmount.amountMinor || checkout.totals.currency !== checked.paymentAmount.currency) throw new DomainError('Payment amount must exactly match checkout', 'PAYMENT_AMOUNT');
      const checkoutDraft = await replayStore.getCheckoutDraft(checked.checkoutMandateDraftId);
      if (!checkoutDraft || checkoutDraft.transactionId !== checked.transactionId || checkoutDraft.checkoutHash !== checked.checkoutHash) throw new DomainError('Checkout mandate reference is invalid', 'CHECKOUT_MANDATE_REFERENCE');
      await replayStore.consumeNonce(checked.transactionId, checked.nonce);
      const id = `payment_draft_${randomUUID().replace(/-/g, '')}`;
      const unsignedMandatePayload: PaymentMandatePayload = {
        vct: 'mandate.payment.1', transaction_id: checked.transactionId, checkout_hash: checked.checkoutHash, checkout_mandate_draft_id: checked.checkoutMandateDraftId,
        payee: checked.payee, payment_amount: { amount_minor: checked.paymentAmount.amountMinor, currency: checked.paymentAmount.currency },
        payment_instrument: { id: checked.paymentInstrument.id, type: checked.paymentInstrument.type, description_masked: checked.paymentInstrument.descriptionMasked },
        sub: checked.userReference, aud: credentialProviderAudience, iat: Math.floor(Date.parse(checked.issuedAt) / 1000), exp: Math.floor(Date.parse(checked.expiresAt) / 1000), nonce: checked.nonce, jti: id,
      };
      return { id, mandateType: 'payment' as const, status: 'awaiting_user_signature' as const, unsignedMandatePayload,
        signingRequest: { format: 'ap2-unsigned-payload', audience: credentialProviderAudience, payload: unsignedMandatePayload },
        mandatePreview: { payee: checked.payee.name, amountMinor: checked.paymentAmount.amountMinor, currency: checked.paymentAmount.currency, instrument: checked.paymentInstrument.descriptionMasked, expiresAt: checked.expiresAt },
        transactionId: checked.transactionId, checkoutHash: checked.checkoutHash, expiresAt: checked.expiresAt };
    },

    async verifyDraftConsistency(input: { checkoutJwt: string; checkoutHash: string; transactionId: string; draft: CheckoutMandatePayload | PaymentMandatePayload }) {
      const checkout = await verifiedCheckout(input.checkoutJwt, input.checkoutHash, input.transactionId);
      const draft = input.draft;
      if (draft.transaction_id !== checkout.transactionId || draft.checkout_hash !== input.checkoutHash || draft.exp <= draft.iat || draft.exp * 1000 <= now().getTime()) throw new DomainError('Draft is inconsistent or expired', 'DRAFT_CONSISTENCY');
      if (draft.vct === 'mandate.payment.1' && (draft.payment_amount.amount_minor !== checkout.totals.totalMinor || draft.payment_amount.currency !== checkout.totals.currency)) throw new DomainError('Payment draft differs from checkout', 'DRAFT_CONSISTENCY');
      return { valid: true as const, transactionId: checkout.transactionId, checkoutHash: input.checkoutHash };
    },
  };
}

export type MandateService = ReturnType<typeof createMandateService>;
export * from './merchant-signer.js';
export * from './replay-store.js';
export * from './types.js';
export * from './agent-trust.js';
export * from './policy.js';
export * from './autonomy.js';
