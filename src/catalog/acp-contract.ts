import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../domain/state-machine.js';

export const ACP_API_VERSION = '2025-09-12';
export const ACP_TARGET_COUNTRY = 'AR' as const;
export const ACP_CURRENCY = 'ARS' as const;
export const ACP_ACCEPT_LANGUAGE = 'es-AR' as const;
export const ACP_REQUEST_LIMIT_BYTES = 1_048_576;
export const ACP_PRODUCTS_PER_PATCH = 100;
export const ACP_VARIANTS_PER_PRODUCT = 100;
export const ACP_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

export type ApiKeyStatus = 'active' | 'revoked';

export interface MerchantApiKeyRecord {
  merchant_id: string;
  key_prefix: string;
  key_hash: string;
  status: ApiKeyStatus;
  revoked_at?: string;
}

export interface ProductFeedRecord {
  feed_id: string;
  merchant_id: string;
  target_country: typeof ACP_TARGET_COUNTRY;
}

export type MerchantKeyLookup =
  | { kind: 'hash'; key_hash: string }
  | { kind: 'feed'; feed_id: string };

export interface MerchantKeyStore {
  lookups: MerchantKeyLookup[];
  findActiveByHash(keyHash: string): Promise<MerchantApiKeyRecord | undefined>;
  findFeed(feedId: string): Promise<ProductFeedRecord | undefined>;
}

export class AcpError extends DomainError {
  constructor(
    message: string,
    code: string,
    readonly httpStatus: number,
  ) {
    super(message, code);
    this.name = 'AcpError';
  }
}

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function provisionMerchantApiKey(input: { merchantId: string }): {
  raw: string;
  record: MerchantApiKeyRecord;
} {
  const raw = `juno_${randomBytes(24).toString('base64url')}`;
  return {
    raw,
    record: {
      merchant_id: input.merchantId,
      key_prefix: raw.slice(0, 8),
      key_hash: hashApiKey(raw),
      status: 'active',
    },
  };
}

export function revokeMerchantApiKey(
  record: MerchantApiKeyRecord,
  now = new Date(),
): MerchantApiKeyRecord {
  return {
    merchant_id: record.merchant_id,
    key_prefix: record.key_prefix,
    key_hash: record.key_hash,
    status: 'revoked',
    revoked_at: now.toISOString(),
  };
}

export function rotateMerchantApiKey(input: {
  merchantId: string;
  previous: MerchantApiKeyRecord;
}): {
  revoked: MerchantApiKeyRecord;
  issued: { raw: string; record: MerchantApiKeyRecord };
} {
  return {
    revoked: revokeMerchantApiKey(input.previous),
    issued: provisionMerchantApiKey({ merchantId: input.merchantId }),
  };
}

function safeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function parseBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/.exec(header);
  return match?.[1];
}

export class MemoryMerchantKeyStore implements MerchantKeyStore {
  lookups: MerchantKeyLookup[] = [];
  private readonly keys = new Map<string, MerchantApiKeyRecord>();
  private readonly feeds = new Map<string, ProductFeedRecord>();

  putKey(record: MerchantApiKeyRecord): void {
    this.keys.set(record.key_hash, { ...record });
  }

  putFeed(feed: ProductFeedRecord): void {
    this.feeds.set(feed.feed_id, { ...feed });
  }

  async findActiveByHash(keyHash: string): Promise<MerchantApiKeyRecord | undefined> {
    this.lookups.push({ kind: 'hash', key_hash: keyHash });
    const record = this.keys.get(keyHash);
    return record ? { ...record } : undefined;
  }

  async findFeed(feedId: string): Promise<ProductFeedRecord | undefined> {
    this.lookups.push({ kind: 'feed', feed_id: feedId });
    const feed = this.feeds.get(feedId);
    return feed ? { ...feed } : undefined;
  }
}

export class MerchantFeedAuthorizer {
  constructor(private readonly store: MerchantKeyStore) {}

  async authenticate(authorization: string | undefined): Promise<{ merchant_id: string }> {
    const raw = parseBearer(authorization);
    if (!raw) {
      throw new AcpError('No autorizado', 'UNAUTHORIZED', 401);
    }
    const digest = hashApiKey(raw);
    const record = await this.store.findActiveByHash(digest);
    if (!record || record.status !== 'active' || !safeEqualHex(record.key_hash, digest)) {
      throw new AcpError('No autorizado', 'UNAUTHORIZED', 401);
    }
    return { merchant_id: record.merchant_id };
  }

  async authorizeFeed(
    authorization: string | undefined,
    feedId: string,
    _untrustedBody?: unknown,
  ): Promise<{ merchant_id: string; feed_id: string }> {
    const { merchant_id } = await this.authenticate(authorization);
    const feed = await this.store.findFeed(feedId);
    if (!feed || feed.merchant_id !== merchant_id) {
      throw new AcpError('Feed no encontrado', 'NOT_FOUND', 404);
    }
    return { merchant_id, feed_id: feed.feed_id };
  }
}
