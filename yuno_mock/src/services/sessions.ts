import type { SessionRecord, YunoMockRepository, YunoMockStore } from '../persistence/types.js';
import { Errors } from '../errors.js';
import { newYunoId, nowIso } from '../domain/ids.js';
import { findCustomerById } from './customers.js';
import type { TokenizedCard } from './tokenize.js';

export type CreateSessionBody = {
  account_id: string;
  country: string;
  customer_id: string;
  callback_url?: string;
  checkout_id?: string;
};

export type PendingVault = TokenizedCard;

export function findSessionById(store: YunoMockStore, id: string): SessionRecord | undefined {
  return store.sessions.find((s) => s.id === id);
}

export async function createCustomerSession(
  repo: YunoMockRepository,
  body: CreateSessionBody,
): Promise<Record<string, unknown>> {
  return repo.withLock((store) => {
    const customer = findCustomerById(store, body.customer_id);
    if (!customer) {
      throw Errors.invalidRequest('customer_id not found');
    }
    const ts = nowIso();
    const id = newYunoId();
    const record: SessionRecord = {
      id,
      customerId: body.customer_id,
      data: {
        account_id: body.account_id,
        country: body.country,
        callback_url: body.callback_url,
        checkout_id: body.checkout_id,
      },
      createdAt: ts,
      updatedAt: ts,
    };
    store.sessions.push(record);
    return toSessionResponse(record);
  });
}

export function toSessionResponse(record: SessionRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {
    customer_session: record.id,
    customer_id: record.customerId,
    country: record.data.country,
    created_at: record.createdAt,
  };
  if (record.data.callback_url !== undefined) out.callback_url = record.data.callback_url;
  if (record.data.checkout_id !== undefined) out.checkout_id = record.data.checkout_id;
  return out;
}

export async function attachPendingVault(
  repo: YunoMockRepository,
  customerSession: string,
  vault: PendingVault,
): Promise<void> {
  await repo.withLock((store) => {
    const session = findSessionById(store, customerSession);
    if (!session) {
      throw Errors.invalidRequest('customer_session not found');
    }
    session.data.pending_vault = vault;
    session.updatedAt = nowIso();
  });
}

export function getPendingVault(session: SessionRecord): PendingVault | undefined {
  const vault = session.data.pending_vault;
  if (!vault || typeof vault !== 'object') return undefined;
  return vault as PendingVault;
}

export function clearPendingVault(session: SessionRecord): void {
  delete session.data.pending_vault;
}
