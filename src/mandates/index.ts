import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../domain/state-machine.js';
import { canonicalJson, checkoutHash, sha256Base64Url } from './canonical.js';
import { InMemoryMandateReplayStore } from './replay-store.js';
export {
  Eip712TrustedSurfaceService,
  InMemoryTrustedSurfaceApprovalStore,
  createBaseTypedDataVerifier,
  mandateApprovalDomain,
  mandateApprovalTypes,
  type Eip712ApprovalChallenge,
  type Eip712ApprovalProof,
  type MandateApprovalMessage,
  type TrustedSurfaceApprovalStore,
  type TypedDataVerifier,
} from './trusted-surface.js';
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

const checkoutMandatePayloadSchema = z.object({
  vct: z.literal('mandate.checkout.1'),
  transaction_id: opaqueId,
  checkout_hash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  checkout_jwt: z.string().min(1),
  sub: opaqueId,
  aud: opaqueId,
  iat: z.number().int().safe(),
  exp: z.number().int().safe(),
  nonce,
  jti: opaqueId,
}).strict();

const paymentMandatePayloadSchema = z.object({
  vct: z.literal('mandate.payment.1'),
  transaction_id: opaqueId,
  checkout_hash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  checkout_mandate_draft_id: opaqueId,
  payee: z.object({ id: opaqueId, name: z.string().min(1).max(300), website: url }).strict(),
  payment_amount: z.object({ amount_minor: minor, currency }).strict(),
  payment_instrument: z.object({ id: opaqueId, type: z.string().min(1).max(100), description_masked: z.string().min(5).max(200) }).strict(),
  sub: opaqueId,
  aud: opaqueId,
  iat: z.number().int().safe(),
  exp: z.number().int().safe(),
  nonce,
  jti: opaqueId,
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
  /** Explicit small clock skew for future issuedAt rejection (milliseconds). Default 5000. */
  clockSkewMs?: number;
};

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  try { return schema.parse(input); }
  catch (error) { throw new DomainError(`Invalid mandate input: ${(error as z.ZodError).message}`, 'MANDATE_INPUT'); }
}

function validatePeriod(issuedAt: string, expiresAt: string, maxTtlSeconds: number, now: Date, clockSkewMs: number): void {
  const issued = Date.parse(issuedAt); const expires = Date.parse(expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) throw new DomainError('Expiry must be after issuance', 'MANDATE_EXPIRY');
  if ((expires - issued) / 1000 > maxTtlSeconds) throw new DomainError('Mandate lifetime exceeds configured maximum', 'MANDATE_EXPIRY');
  if (expires <= now.getTime()) throw new DomainError('Mandate has expired', 'MANDATE_EXPIRED');
  if (issued > now.getTime() + clockSkewMs) {
    throw new DomainError('Mandate issuedAt is in the future beyond allowed clock skew', 'MANDATE_ISSUED_FUTURE');
  }
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

function rejectSensitiveInstrument(instrument: { id: string; type: string; descriptionMasked?: string; description_masked?: string }): void {
  const raw = JSON.stringify(instrument);
  const masked = instrument.descriptionMasked ?? instrument.description_masked ?? '';
  if (/\b(?:pan|cvc|cvv|token|yuno|card_number|security_code)\b/i.test(raw) || /\d{12,}/.test(instrument.id) || !/[•*xX]{2,}/.test(masked)) {
    throw new DomainError('Payment instrument must be opaque and masked', 'PAYMENT_INSTRUMENT');
  }
}

function assertPayeeMatchesMerchant(payee: { id: string; website: string }, merchant: CheckoutSnapshot['merchant']): void {
  if (payee.id !== merchant.id) {
    throw new DomainError('Payee redirection is not allowed', 'PAYEE_REDIRECT');
  }
  const normalize = (value: string) => value.replace(/\/$/, '').toLowerCase();
  if (normalize(payee.website) !== normalize(merchant.website)) {
    throw new DomainError('Payee website must match merchant website', 'PAYEE_REDIRECT');
  }
}

export function createMandateService(options: CreateMandateServiceOptions) {
  const replayStore = options.replayStore ?? new InMemoryMandateReplayStore();
  const maxTtlSeconds = options.maxTtlSeconds ?? 900;
  const credentialProviderAudience = options.credentialProviderAudience ?? 'credential-provider';
  const clock = options.now ?? (() => new Date());
  const clockSkewMs = options.clockSkewMs ?? 5_000;
  if (!Number.isSafeInteger(maxTtlSeconds) || maxTtlSeconds <= 0) throw new DomainError('maxTtlSeconds must be positive', 'MANDATE_CONFIG');
  if (!Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0) throw new DomainError('clockSkewMs must be non-negative', 'MANDATE_CONFIG');

  function currentTime(): Date {
    const current = clock();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
      throw new DomainError('Mandate service clock must return a valid Date', 'MANDATE_CLOCK');
    }
    return current;
  }

  async function verifiedCheckout(
    checkoutJwt: string,
    expectedHash: string,
    transactionId: string,
    current: Date,
  ): Promise<CheckoutSnapshot> {
    if (checkoutHash(checkoutJwt) !== expectedHash) throw new DomainError('Checkout hash does not match JWT', 'CHECKOUT_HASH');
    const value = await options.merchantSigner.verifyCheckout(checkoutJwt);
    const { iss: _iss, aud: _aud, iat: _iat, exp: _exp, nbf: _nbf, jti: _jti, ...checkoutPayload } = value as CheckoutSnapshot & Record<string, unknown>;
    const checked = snapshot(parse(checkoutSchema, checkoutPayload));
    verifyTotals(checked);
    validatePeriod(checked.issuedAt, checked.expiresAt, maxTtlSeconds, current, clockSkewMs);
    if (checked.transactionId !== transactionId) throw new DomainError('Transaction does not match checkout', 'CHECKOUT_TRANSACTION');
    return checked;
  }

  function assertCheckoutDraftPayloadWindow(
    checkout: CheckoutSnapshot,
    draft: { iat: number; exp: number },
  ): void {
    const checkoutIat = Math.floor(Date.parse(checkout.issuedAt) / 1000);
    const checkoutExp = Math.floor(Date.parse(checkout.expiresAt) / 1000);
    if (draft.iat < checkoutIat || draft.exp > checkoutExp || draft.exp <= draft.iat) {
      throw new DomainError('Checkout draft window must fall entirely within the merchant checkout JWT window', 'DRAFT_LINEAGE');
    }
  }

  function assertCheckoutDraftWindow(
    checkout: CheckoutSnapshot,
    draft: { issuedAt: string; expiresAt: string },
  ): void {
    const parseWindow = (value: { issuedAt: string; expiresAt: string }) => {
      if (typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string') {
        throw new DomainError('Checkout draft window metadata is invalid', 'DRAFT_LINEAGE');
      }
      const issuedAt = Date.parse(value.issuedAt);
      const expiresAt = Date.parse(value.expiresAt);
      if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
        throw new DomainError('Checkout draft window metadata is invalid', 'DRAFT_LINEAGE');
      }
      return { issuedAt, expiresAt };
    };
    const checkoutWindow = parseWindow(checkout);
    const draftWindow = parseWindow(draft);
    if (
      draftWindow.issuedAt < checkoutWindow.issuedAt
      || draftWindow.expiresAt > checkoutWindow.expiresAt
    ) {
      throw new DomainError('Checkout draft window must fall entirely within the merchant checkout JWT window', 'DRAFT_LINEAGE');
    }
  }

  function assertPaymentDraftWindow(
    checkoutDraft: NonNullable<Awaited<ReturnType<MandateReplayStore['getCheckoutDraft']>>>,
    payment: { issuedAt: string; expiresAt: string },
  ): void {
    if (
      typeof checkoutDraft.issuedAt !== 'string'
      || typeof checkoutDraft.expiresAt !== 'string'
      || typeof payment.issuedAt !== 'string'
      || typeof payment.expiresAt !== 'string'
    ) {
      throw new DomainError('Payment draft window metadata is invalid', 'DRAFT_LINEAGE');
    }
    const checkoutIssuedAt = Date.parse(checkoutDraft.issuedAt);
    const checkoutExpiresAt = Date.parse(checkoutDraft.expiresAt);
    const paymentIssuedAt = Date.parse(payment.issuedAt);
    const paymentExpiresAt = Date.parse(payment.expiresAt);
    if (
      !Number.isFinite(checkoutIssuedAt)
      || !Number.isFinite(checkoutExpiresAt)
      || !Number.isFinite(paymentIssuedAt)
      || !Number.isFinite(paymentExpiresAt)
      || checkoutExpiresAt <= checkoutIssuedAt
      || paymentExpiresAt <= paymentIssuedAt
      || paymentIssuedAt < checkoutIssuedAt
      || paymentExpiresAt > checkoutExpiresAt
    ) {
      throw new DomainError('Payment draft window must fall within checkout draft window', 'DRAFT_LINEAGE');
    }
  }

  function assertPaymentPayloadLineage(
    checkoutDraft: NonNullable<Awaited<ReturnType<MandateReplayStore['getCheckoutDraft']>>>,
    payment: { sub: string; aud: string; iat: number; exp: number },
  ): void {
    if (payment.sub !== checkoutDraft.sub) {
      throw new DomainError('Payment draft subject must match checkout draft', 'DRAFT_LINEAGE');
    }
    if (payment.aud !== checkoutDraft.aud) {
      throw new DomainError('Payment draft audience must match checkout draft', 'DRAFT_LINEAGE');
    }
    if (
      !Number.isSafeInteger(checkoutDraft.iat)
      || !Number.isSafeInteger(checkoutDraft.exp)
      || checkoutDraft.exp <= checkoutDraft.iat
      || payment.iat < checkoutDraft.iat
      || payment.exp > checkoutDraft.exp
      || payment.exp <= payment.iat
    ) {
      throw new DomainError('Payment draft window must fall within checkout draft window', 'DRAFT_LINEAGE');
    }
  }

  return {
    async createMerchantCheckout(input: CreateMerchantCheckoutInput) {
      const current = currentTime();
      const checked = snapshot(parse(checkoutSchema, input));
      validatePeriod(checked.issuedAt, checked.expiresAt, maxTtlSeconds, current, clockSkewMs);
      verifyTotals(checked);
      const checkoutJwt = await options.merchantSigner.signCheckout(checked);
      const hash = checkoutHash(checkoutJwt);
      return {
        checkoutJwt, checkoutHash: hash, transactionId: checked.transactionId, expiresAt: checked.expiresAt, checkoutSnapshot: structuredClone(checked),
        auditMetadata: { source: checked.source, merchantId: checked.merchant.id, createdAt: current.toISOString(), checkoutHash: hash },
      };
    },

    async createCheckoutMandateDraft(input: CreateCheckoutMandateDraftInput) {
      const current = currentTime();
      const checked = parse(checkoutDraftSchema, input);
      validatePeriod(checked.issuedAt, checked.expiresAt, maxTtlSeconds, current, clockSkewMs);
      const checkout = await verifiedCheckout(checked.checkoutJwt, checked.checkoutHash, checked.transactionId, current);
      assertCheckoutDraftWindow(checkout, checked);
      const draftWindow = {
        iat: Math.floor(Date.parse(checked.issuedAt) / 1000),
        exp: Math.floor(Date.parse(checked.expiresAt) / 1000),
      };
      assertCheckoutDraftPayloadWindow(checkout, draftWindow);
      await replayStore.consumeNonce(checked.transactionId, checked.nonce);
      const id = `checkout_draft_${randomUUID().replace(/-/g, '')}`;
      const unsignedMandatePayload: CheckoutMandatePayload = {
        vct: 'mandate.checkout.1', transaction_id: checked.transactionId, checkout_hash: checked.checkoutHash, checkout_jwt: checked.checkoutJwt,
        sub: checked.userReference, aud: credentialProviderAudience, ...draftWindow, nonce: checked.nonce, jti: id,
      };
      await replayStore.rememberCheckoutDraft(id, {
        transactionId: checked.transactionId,
        checkoutHash: checked.checkoutHash,
        payloadHash: sha256Base64Url(canonicalJson(unsignedMandatePayload)),
        sub: unsignedMandatePayload.sub,
        aud: unsignedMandatePayload.aud,
        issuedAt: checked.issuedAt,
        expiresAt: checked.expiresAt,
        iat: unsignedMandatePayload.iat,
        exp: unsignedMandatePayload.exp,
      });
      return {
        id, mandateType: 'checkout' as const, status: 'awaiting_user_signature' as const, unsignedMandatePayload,
        signingRequest: { format: 'ap2-unsigned-payload', audience: credentialProviderAudience, payload: unsignedMandatePayload },
        mandatePreview: { merchantCheckout: checked.transactionId, expiresAt: checked.expiresAt, checkoutHash: checked.checkoutHash },
        transactionId: checked.transactionId, checkoutHash: checked.checkoutHash, expiresAt: checked.expiresAt,
      };
    },

    async createPaymentMandateDraft(input: CreatePaymentMandateDraftInput) {
      const current = currentTime();
      const checked = parse(paymentDraftSchema, input);
      validatePeriod(checked.issuedAt, checked.expiresAt, maxTtlSeconds, current, clockSkewMs);
      rejectSensitiveInstrument(checked.paymentInstrument);
      const checkout = await verifiedCheckout(checked.checkoutJwt, checked.checkoutHash, checked.transactionId, current);
      assertPayeeMatchesMerchant(checked.payee, checkout.merchant);
      if (checkout.totals.totalMinor !== checked.paymentAmount.amountMinor || checkout.totals.currency !== checked.paymentAmount.currency) {
        throw new DomainError('Payment amount must exactly match checkout', 'PAYMENT_AMOUNT');
      }
      const checkoutDraft = await replayStore.getCheckoutDraft(checked.checkoutMandateDraftId);
      if (!checkoutDraft || checkoutDraft.transactionId !== checked.transactionId || checkoutDraft.checkoutHash !== checked.checkoutHash) {
        throw new DomainError('Checkout mandate reference is invalid', 'CHECKOUT_MANDATE_REFERENCE');
      }
      assertCheckoutDraftWindow(checkout, checkoutDraft);
      assertPaymentDraftWindow(checkoutDraft, checked);
      const paymentIat = Math.floor(Date.parse(checked.issuedAt) / 1000);
      const paymentExp = Math.floor(Date.parse(checked.expiresAt) / 1000);
      assertPaymentPayloadLineage(checkoutDraft, {
        sub: checked.userReference,
        aud: credentialProviderAudience,
        iat: paymentIat,
        exp: paymentExp,
      });
      await replayStore.consumeNonce(checked.transactionId, checked.nonce);
      const id = `payment_draft_${randomUUID().replace(/-/g, '')}`;
      const unsignedMandatePayload: PaymentMandatePayload = {
        vct: 'mandate.payment.1', transaction_id: checked.transactionId, checkout_hash: checked.checkoutHash, checkout_mandate_draft_id: checked.checkoutMandateDraftId,
        payee: checked.payee, payment_amount: { amount_minor: checked.paymentAmount.amountMinor, currency: checked.paymentAmount.currency },
        payment_instrument: { id: checked.paymentInstrument.id, type: checked.paymentInstrument.type, description_masked: checked.paymentInstrument.descriptionMasked },
        sub: checked.userReference, aud: credentialProviderAudience, iat: paymentIat, exp: paymentExp, nonce: checked.nonce, jti: id,
      };
      await replayStore.rememberPaymentDraft(id, {
        transactionId: checked.transactionId,
        checkoutHash: checked.checkoutHash,
        checkoutMandateDraftId: checked.checkoutMandateDraftId,
        payloadHash: sha256Base64Url(canonicalJson(unsignedMandatePayload)),
        issuedAt: checked.issuedAt,
        expiresAt: checked.expiresAt,
        iat: unsignedMandatePayload.iat,
        exp: unsignedMandatePayload.exp,
      });
      return {
        id, mandateType: 'payment' as const, status: 'awaiting_user_signature' as const, unsignedMandatePayload,
        signingRequest: { format: 'ap2-unsigned-payload', audience: credentialProviderAudience, payload: unsignedMandatePayload },
        mandatePreview: { payee: checked.payee.name, amountMinor: checked.paymentAmount.amountMinor, currency: checked.paymentAmount.currency, instrument: checked.paymentInstrument.descriptionMasked, expiresAt: checked.expiresAt },
        transactionId: checked.transactionId, checkoutHash: checked.checkoutHash, expiresAt: checked.expiresAt,
      };
    },

    async verifyDraftConsistency(input: {
      checkoutJwt: string;
      checkoutHash: string;
      transactionId: string;
      draft: CheckoutMandatePayload | PaymentMandatePayload;
      expectedUserReference?: string;
      expectedAudience?: string;
    }) {
      const current = currentTime();
      const checkout = await verifiedCheckout(input.checkoutJwt, input.checkoutHash, input.transactionId, current);
      const expectedAud = input.expectedAudience ?? credentialProviderAudience;

      if (input.draft.vct === 'mandate.checkout.1') {
        const draft = parse(checkoutMandatePayloadSchema, input.draft);
        if (draft.checkout_jwt !== input.checkoutJwt) throw new DomainError('Draft checkout JWT mismatch', 'DRAFT_CONSISTENCY');
        if (checkoutHash(draft.checkout_jwt) !== draft.checkout_hash || draft.checkout_hash !== input.checkoutHash) {
          throw new DomainError('Draft checkout hash mismatch', 'DRAFT_CONSISTENCY');
        }
        if (draft.transaction_id !== checkout.transactionId || draft.transaction_id !== input.transactionId) {
          throw new DomainError('Draft transaction mismatch', 'DRAFT_CONSISTENCY');
        }
        if (draft.aud !== expectedAud) throw new DomainError('Draft audience mismatch', 'DRAFT_CONSISTENCY');
        if (input.expectedUserReference !== undefined && draft.sub !== input.expectedUserReference) {
          throw new DomainError('Draft subject mismatch', 'DRAFT_CONSISTENCY');
        }
        if (draft.exp <= draft.iat || draft.exp * 1000 <= current.getTime()) {
          throw new DomainError('Draft is inconsistent or expired', 'DRAFT_CONSISTENCY');
        }
        assertCheckoutDraftPayloadWindow(checkout, draft);
        if (!draft.nonce || !draft.jti) throw new DomainError('Draft nonce/jti missing', 'DRAFT_CONSISTENCY');
        const storedCheckout = await replayStore.getCheckoutDraft(draft.jti);
        const liveHash = sha256Base64Url(canonicalJson(draft));
        if (
          !storedCheckout
          || storedCheckout.transactionId !== draft.transaction_id
          || storedCheckout.checkoutHash !== draft.checkout_hash
          || storedCheckout.payloadHash !== liveHash
          || storedCheckout.sub !== draft.sub
          || storedCheckout.aud !== draft.aud
          || storedCheckout.iat !== draft.iat
          || storedCheckout.exp !== draft.exp
        ) {
          throw new DomainError('Checkout draft diverges from issued canonical payload', 'DRAFT_CONSISTENCY');
        }
        assertCheckoutDraftWindow(checkout, storedCheckout);
        return { valid: true as const, transactionId: checkout.transactionId, checkoutHash: input.checkoutHash };
      }

      const draft = parse(paymentMandatePayloadSchema, input.draft);
      rejectSensitiveInstrument(draft.payment_instrument);
      assertPayeeMatchesMerchant(draft.payee, checkout.merchant);
      if (draft.checkout_hash !== input.checkoutHash) throw new DomainError('Draft checkout hash mismatch', 'DRAFT_CONSISTENCY');
      if (draft.transaction_id !== checkout.transactionId || draft.transaction_id !== input.transactionId) {
        throw new DomainError('Draft transaction mismatch', 'DRAFT_CONSISTENCY');
      }
      if (draft.aud !== expectedAud) throw new DomainError('Draft audience mismatch', 'DRAFT_CONSISTENCY');
      if (input.expectedUserReference !== undefined && draft.sub !== input.expectedUserReference) {
        throw new DomainError('Draft subject mismatch', 'DRAFT_CONSISTENCY');
      }
      if (draft.exp <= draft.iat || draft.exp * 1000 <= current.getTime()) {
        throw new DomainError('Draft is inconsistent or expired', 'DRAFT_CONSISTENCY');
      }
      if (!draft.nonce || !draft.jti) throw new DomainError('Draft nonce/jti missing', 'DRAFT_CONSISTENCY');
      if (draft.payment_amount.amount_minor !== checkout.totals.totalMinor || draft.payment_amount.currency !== checkout.totals.currency) {
        throw new DomainError('Payment draft differs from checkout', 'DRAFT_CONSISTENCY');
      }
      const checkoutDraft = await replayStore.getCheckoutDraft(draft.checkout_mandate_draft_id);
      if (!checkoutDraft || checkoutDraft.transactionId !== draft.transaction_id || checkoutDraft.checkoutHash !== draft.checkout_hash) {
        throw new DomainError('Checkout draft lineage is invalid', 'DRAFT_CONSISTENCY');
      }
      assertCheckoutDraftWindow(checkout, checkoutDraft);
      assertPaymentPayloadLineage(checkoutDraft, draft);
      const storedPayment = await replayStore.getPaymentDraft(draft.jti);
      const liveHash = sha256Base64Url(canonicalJson(draft));
      if (
        !storedPayment
        || storedPayment.transactionId !== draft.transaction_id
        || storedPayment.checkoutHash !== draft.checkout_hash
        || storedPayment.checkoutMandateDraftId !== draft.checkout_mandate_draft_id
        || storedPayment.payloadHash !== liveHash
        || storedPayment.iat !== draft.iat
        || storedPayment.exp !== draft.exp
      ) {
        throw new DomainError('Payment draft diverges from issued canonical payload', 'DRAFT_CONSISTENCY');
      }
      assertPaymentDraftWindow(checkoutDraft, storedPayment);
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
export * from './request-store.js';
export * from './canonical.js';
export * from './anchor-outbox.js';
