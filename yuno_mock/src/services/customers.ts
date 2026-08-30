import type { CustomerRecord, YunoMockRepository, YunoMockStore } from '../persistence/types.js';
import { Errors } from '../errors.js';
import { newYunoId, nowIso } from '../domain/ids.js';

export type CreateCustomerBody = {
  merchant_customer_id: string;
  [key: string]: unknown;
};

export function findCustomerById(store: YunoMockStore, id: string): CustomerRecord | undefined {
  return store.customers.find((c) => c.id === id);
}

export function findCustomerByMerchantId(
  store: YunoMockStore,
  merchantCustomerId: string,
): CustomerRecord | undefined {
  return store.customers.find((c) => c.merchantCustomerId === merchantCustomerId);
}

export async function createCustomer(
  repo: YunoMockRepository,
  body: CreateCustomerBody,
): Promise<Record<string, unknown>> {
  return repo.withLock((store) => {
    if (findCustomerByMerchantId(store, body.merchant_customer_id)) {
      throw Errors.invalidRequest('merchant_customer_id already exists');
    }
    const ts = nowIso();
    const id = newYunoId();
    const record: CustomerRecord = {
      id,
      merchantCustomerId: body.merchant_customer_id,
      data: { ...body },
      createdAt: ts,
      updatedAt: ts,
    };
    store.customers.push(record);
    return toCustomerResponse(record);
  });
}

export function toCustomerResponse(record: CustomerRecord): Record<string, unknown> {
  const { merchant_customer_id: _m, ...rest } = record.data;
  void _m;
  return {
    id: record.id,
    merchant_customer_id: record.merchantCustomerId,
    ...rest,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}
