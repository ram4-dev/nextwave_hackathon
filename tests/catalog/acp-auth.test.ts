import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AcpError,
  MemoryMerchantKeyStore,
  MerchantFeedAuthorizer,
  hashApiKey,
  provisionMerchantApiKey,
  revokeMerchantApiKey,
  rotateMerchantApiKey,
} from '../../src/catalog/acp-contract.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('ACP merchant API key contract', () => {
  it('provisions an opaque key shown once and stores only prefix, hash, status, and merchant_id', () => {
    const issued = provisionMerchantApiKey({ merchantId: 'merchant_centro' });
    expect(issued.raw).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(issued.record.merchant_id).toBe('merchant_centro');
    expect(issued.record.key_prefix).toBe(issued.raw.slice(0, 8));
    expect(issued.record.key_hash).toBe(sha256(issued.raw));
    expect(issued.record.status).toBe('active');
    expect(JSON.stringify(issued.record)).not.toContain(issued.raw);
    expect(issued.record).not.toHaveProperty('raw');
    expect(issued.record).not.toHaveProperty('api_key');
  });

  it('revokes and rotates a key without persisting either raw secret', async () => {
    const store = new MemoryMerchantKeyStore();
    const first = provisionMerchantApiKey({ merchantId: 'merchant_centro' });
    store.putKey(first.record);
    store.putFeed({ feed_id: 'feed_centro', merchant_id: 'merchant_centro', target_country: 'AR' });
    const authorizer = new MerchantFeedAuthorizer(store);

    const revoked = revokeMerchantApiKey(first.record);
    expect(revoked.status).toBe('revoked');
    expect(revoked.revoked_at).toEqual(expect.any(String));
    expect(JSON.stringify(revoked)).not.toContain(first.raw);
    store.putKey(revoked);
    await expect(authorizer.authenticate(`Bearer ${first.raw}`)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      httpStatus: 401,
    });

    const rotated = rotateMerchantApiKey({ merchantId: 'merchant_centro', previous: first.record });
    expect(rotated.revoked.status).toBe('revoked');
    expect(rotated.issued.raw).not.toBe(first.raw);
    expect(rotated.issued.record.key_hash).not.toBe(first.record.key_hash);
    expect(JSON.stringify(rotated.issued.record)).not.toContain(rotated.issued.raw);
    expect(JSON.stringify(rotated.issued.record)).not.toContain(first.raw);
    store.putKey(rotated.revoked);
    store.putKey(rotated.issued.record);
    await expect(authorizer.authenticate(`Bearer ${first.raw}`)).rejects.toMatchObject({ httpStatus: 401 });
    await expect(authorizer.authenticate(`Bearer ${rotated.issued.raw}`)).resolves.toEqual({
      merchant_id: 'merchant_centro',
    });
  });

  it('hashes keys without keeping the raw secret on the hash helper surface', () => {
    const raw = `juno_${randomBytes(24).toString('base64url')}`;
    expect(hashApiKey(raw)).toBe(sha256(raw));
    expect(hashApiKey(raw)).not.toBe(raw);
  });
});

describe('MerchantFeedAuthorizer', () => {
  it('authenticates an active bearer to the provisioned merchant_id', async () => {
    const store = new MemoryMerchantKeyStore();
    const issued = provisionMerchantApiKey({ merchantId: 'merchant_palermo' });
    store.putKey(issued.record);
    store.putFeed({ feed_id: 'feed_palermo', merchant_id: 'merchant_palermo', target_country: 'AR' });
    const authorizer = new MerchantFeedAuthorizer(store);

    await expect(authorizer.authenticate(`Bearer ${issued.raw}`)).resolves.toEqual({
      merchant_id: 'merchant_palermo',
    });
    await expect(authorizer.authorizeFeed(`Bearer ${issued.raw}`, 'feed_palermo')).resolves.toEqual({
      merchant_id: 'merchant_palermo',
      feed_id: 'feed_palermo',
    });
  });

  it('fails closed with 401 for missing, unknown, or revoked keys without revealing secrets', async () => {
    const store = new MemoryMerchantKeyStore();
    const issued = provisionMerchantApiKey({ merchantId: 'merchant_centro' });
    store.putKey({ ...issued.record, status: 'revoked' });
    const authorizer = new MerchantFeedAuthorizer(store);

    const cases = [undefined, 'Bearer', 'Bearer ', `Bearer ${issued.raw}`, 'Bearer totally-unknown-key'];
    for (const header of cases) {
      try {
        await authorizer.authenticate(header);
        throw new Error('expected fail-closed auth');
      } catch (err) {
        expect(err).toBeInstanceOf(AcpError);
        expect(err).toMatchObject({ code: 'UNAUTHORIZED', httpStatus: 401 });
        expect(JSON.stringify(err)).not.toContain(issued.raw);
      }
    }
  });

  it('treats a foreign feed as 404 and never trusts seller from the body', async () => {
    const store = new MemoryMerchantKeyStore();
    const owner = provisionMerchantApiKey({ merchantId: 'merchant_centro' });
    const other = provisionMerchantApiKey({ merchantId: 'merchant_palermo' });
    store.putKey(owner.record);
    store.putKey(other.record);
    store.putFeed({ feed_id: 'feed_centro', merchant_id: 'merchant_centro', target_country: 'AR' });
    const authorizer = new MerchantFeedAuthorizer(store);

    await expect(authorizer.authorizeFeed(`Bearer ${other.raw}`, 'feed_centro')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });
    await expect(
      authorizer.authorizeFeed(`Bearer ${other.raw}`, 'feed_centro', { seller: { name: 'merchant_centro' } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    await expect(authorizer.authorizeFeed(`Bearer ${owner.raw}`, 'feed_missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });
  });

  it('does not consult KyaStore or session credentials', async () => {
    const store = new MemoryMerchantKeyStore();
    const issued = provisionMerchantApiKey({ merchantId: 'merchant_centro' });
    store.putKey(issued.record);
    store.putFeed({ feed_id: 'feed_centro', merchant_id: 'merchant_centro', target_country: 'AR' });
    const authorizer = new MerchantFeedAuthorizer(store);
    const kya = { getStore: async () => ({ principals: [{ id: 'principal-1' }] }) };

    await authorizer.authenticate(`Bearer ${issued.raw}`);
    expect(store.lookups.every((lookup) => lookup.kind === 'hash' || lookup.kind === 'feed')).toBe(true);
    await expect(kya.getStore()).resolves.toMatchObject({ principals: [{ id: 'principal-1' }] });
  });
});
