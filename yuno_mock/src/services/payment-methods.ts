import type {
  PaymentMethodRecord,
  YunoMockRepository,
  YunoMockStore,
} from '../persistence/types.js';
import { Errors } from '../errors.js';
import { newYunoId, nowIso } from '../domain/ids.js';
import { availabilityForCountry } from './catalog.js';
import { findCustomerById } from './customers.js';
import {
  clearPendingVault,
  findSessionById,
  getPendingVault,
  type PendingVault,
} from './sessions.js';

export type EnrollBody = {
  account_id: string;
  payment_method_type: string;
  country: string;
  account_updater?: boolean;
  verify?: { vault_on_success: boolean; currency?: string };
};

export type PaymentMethodStatus = 'ENROLLED' | 'UNENROLLED' | 'READY_TO_ENROLL';

type StoredMethodData = {
  account_id: string;
  country: string;
  category: string;
  type: string;
  name: string;
  description: string;
  status: PaymentMethodStatus;
  preferred: boolean;
  session_id: string;
  idempotency_key?: string;
  verify?: EnrollBody['verify'];
  vaulted_token: string;
  card_data: {
    brand: string;
    category: string;
    country_code: string | null;
    expiration_month: number;
    expiration_year: number;
    fingerprint: string;
    iin: string;
    issuer: string;
    lfd: string;
    number_length: number;
    security_code_length: number;
    type: string;
  };
  icon: string;
};

function asStored(record: PaymentMethodRecord): StoredMethodData {
  return record.data as unknown as StoredMethodData;
}

export function findPaymentMethodById(
  store: YunoMockStore,
  id: string,
): PaymentMethodRecord | undefined {
  return store.paymentMethods.find((p) => p.id === id);
}

export async function listAvailablePaymentMethods(
  repo: YunoMockRepository,
  customerSession: string,
): Promise<Record<string, unknown>> {
  return repo.withLock((store) => {
    const session = findSessionById(store, customerSession);
    if (!session) {
      throw Errors.invalidRequest('customer_session not found');
    }
    const country = String(session.data.country ?? '');
    const methods = availabilityForCountry(country).map((m) => ({
      ...m,
      enrollment: {
        sdk_required_action: true,
        session: session.id,
      },
    }));
    return { payment_methods: methods };
  });
}

export async function enrollPaymentMethod(
  repo: YunoMockRepository,
  customerSession: string,
  body: EnrollBody,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  return repo.withLock((store) => {
    const session = findSessionById(store, customerSession);
    if (!session) {
      throw Errors.invalidRequest('customer_session not found');
    }
    if (!session.customerId) {
      throw Errors.invalidRequest('customer_session has no customer_id');
    }
    const customer = findCustomerById(store, session.customerId);
    if (!customer) {
      throw Errors.invalidRequest('customer not found for session');
    }

    const sessionAccount = String(session.data.account_id ?? '');
    if (sessionAccount && sessionAccount !== body.account_id) {
      throw Errors.invalidRequest('account_id does not match customer session');
    }
    const sessionCountry = String(session.data.country ?? '');
    if (sessionCountry && sessionCountry !== body.country) {
      throw Errors.invalidRequest('country does not match customer session');
    }

    if (body.payment_method_type !== 'CARD') {
      throw Errors.invalidRequest(
        `payment_method_type ${body.payment_method_type} is not supported in F2 mock; use CARD`,
      );
    }

    const pending = getPendingVault(session);
    if (!pending) {
      throw Errors.invalidRequest(
        'no pending vaulted card on session; complete /test/enrollment tokenization first',
      );
    }

    // Fingerprint dedup: same fingerprint for this customer → reject duplicate enroll
    const dup = store.paymentMethods.find((pm) => {
      if (pm.customerId !== session.customerId) return false;
      const data = asStored(pm);
      return (
        data.status === 'ENROLLED' && data.card_data.fingerprint === pending.fingerprint
      );
    });
    if (dup) {
      throw Errors.invalidRequest('payment method with this fingerprint already enrolled');
    }

    const ts = nowIso();
    const id = newYunoId();
    const brand = pending.brand === 'UNKNOWN' ? 'CARD' : pending.brand;
    const name = `${brand} ****${pending.last4}`;
    const stored: StoredMethodData = {
      account_id: body.account_id,
      country: body.country,
      category: 'CARD',
      type: brand,
      name,
      description: name,
      status: 'ENROLLED',
      preferred: false,
      session_id: session.id,
      idempotency_key: idempotencyKey,
      verify: body.verify,
      vaulted_token: pending.vaulted_token,
      card_data: {
        brand: pending.brand,
        category: pending.category,
        country_code: pending.country_code,
        expiration_month: pending.expiration_month,
        expiration_year: pending.expiration_year,
        fingerprint: pending.fingerprint,
        iin: pending.iin,
        issuer: pending.issuer,
        lfd: pending.last4,
        number_length: pending.number_length,
        security_code_length: pending.security_code_length,
        type: pending.type,
      },
      icon:
        brand === 'MASTERCARD'
          ? 'https://icons.prod.y.uno/mastercard_logosimbolo.png'
          : 'https://icons.prod.y.uno/visa_logosimbolo.png',
    };

    const record: PaymentMethodRecord = {
      id,
      customerId: session.customerId,
      data: stored as unknown as Record<string, unknown>,
      createdAt: ts,
      updatedAt: ts,
    };
    store.paymentMethods.push(record);
    clearPendingVault(session);
    session.updatedAt = ts;

    return toEnrollResponse(record, customer.id);
  });
}

export async function getPaymentMethod(
  repo: YunoMockRepository,
  paymentMethodId: string,
): Promise<Record<string, unknown>> {
  return repo.withLock((store) => {
    const record = findPaymentMethodById(store, paymentMethodId);
    if (!record) {
      throw Errors.invalidRequest('payment_method_id not found');
    }
    return toGetResponse(record);
  });
}

export async function listCustomerPaymentMethods(
  repo: YunoMockRepository,
  customerId: string,
): Promise<Record<string, unknown>> {
  return repo.withLock((store) => {
    if (!findCustomerById(store, customerId)) {
      throw Errors.invalidRequest('customer_id not found');
    }
    const methods = store.paymentMethods
      .filter((pm) => pm.customerId === customerId && asStored(pm).status === 'ENROLLED')
      .map((pm) => toListItem(pm));
    return { payment_methods: methods };
  });
}

export async function unenrollPaymentMethod(
  repo: YunoMockRepository,
  paymentMethodId: string,
): Promise<Record<string, unknown>> {
  return repo.withLock((store) => {
    const record = findPaymentMethodById(store, paymentMethodId);
    if (!record) {
      throw Errors.invalidRequest('payment_method_id not found');
    }
    const data = asStored(record);
    if (data.status === 'UNENROLLED') {
      throw Errors.invalidRequest('payment method is already unenrolled');
    }
    data.status = 'UNENROLLED';
    record.updatedAt = nowIso();
    // Invalidate vaulted token reference for provider-side use.
    data.vaulted_token = `invalidated_${data.vaulted_token}`;
    return toGetResponse(record);
  });
}

function providerBlock(): Record<string, unknown> {
  return { id: 'YUNO', type: 'YUNO', provider_status: 'OK' };
}

function toEnrollResponse(
  record: PaymentMethodRecord,
  customerId: string,
): Record<string, unknown> {
  const data = asStored(record);
  return {
    id: record.id,
    account_id: data.account_id,
    category: data.category,
    type: data.type,
    name: data.name,
    description: data.description,
    status: data.status,
    country: data.country,
    preferred: data.preferred,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    enrollment: { sdk_required_action: false, session: data.session_id },
    provider: providerBlock(),
    customer_payer: { id: customerId },
    ...(data.verify ? { verify: data.verify } : {}),
  };
}

function toGetResponse(record: PaymentMethodRecord): Record<string, unknown> {
  const data = asStored(record);
  return {
    id: record.id,
    account_id: data.account_id,
    category: data.category,
    type: data.type,
    name: data.name,
    description: data.description,
    status: data.status,
    country: data.country,
    preferred: data.preferred,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    enrollment: { sdk_required_action: false, session: data.session_id },
    provider: providerBlock(),
    idempotency_key: data.idempotency_key ?? null,
    card_data: { ...data.card_data },
    ...(data.verify ? { verify: data.verify } : {}),
  };
}

function toListItem(record: PaymentMethodRecord): Record<string, unknown> {
  const data = asStored(record);
  return {
    vaulted_token: data.vaulted_token,
    category: data.category,
    type: 'CARD',
    name: data.name,
    description: data.description,
    status: data.status,
    country: data.country,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    icon: data.icon,
    last_successfully_used: false,
    last_successfully_used_at: '',
    card_data: {
      brand: data.card_data.brand,
      category: data.card_data.category,
      expiration_month: data.card_data.expiration_month,
      expiration_year: data.card_data.expiration_year,
      iin: data.card_data.iin,
      issuer: data.card_data.issuer,
      lfd: data.card_data.lfd,
      number_length: data.card_data.number_length,
      security_code_length: data.card_data.security_code_length,
      type: data.card_data.type,
    },
    idempotency_key: data.idempotency_key ?? null,
  };
}

/** Test helper: expose pending vault shape without PAN. */
export type { PendingVault };
