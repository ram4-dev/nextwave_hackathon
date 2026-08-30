import { generateKeyPair, exportJWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { assertPublicEcP256Jwk as assertServerJwk } from '../src/crypto/local-agent-key.js';
import { assertPublicEcP256Jwk as assertBrowserJwk } from '../web/src/agent/dpopClient.js';

async function validPublicJwk(): Promise<JsonWebKey> {
  const { publicKey } = await generateKeyPair('ES256');
  return exportJWK(publicKey);
}

async function expectParityReject(jwk: JsonWebKey): Promise<void> {
  expect(() => assertServerJwk(jwk)).toThrow();
  await expect(assertBrowserJwk(jwk)).rejects.toThrow();
}

describe('public ES256 JWK metadata parity', () => {
  it('accepts absent metadata and an explicit public verification-only profile', async () => {
    const publicJwk = await validPublicJwk();
    expect(assertServerJwk(publicJwk)).toMatchObject(publicJwk);
    await expect(assertBrowserJwk(publicJwk)).resolves.toMatchObject(publicJwk);

    const explicit = {
      ...publicJwk,
      alg: 'ES256',
      use: 'sig',
      key_ops: ['verify'],
      ext: true,
      kid: 'agent-key-1',
    } as JsonWebKey;
    expect(assertServerJwk(explicit)).toMatchObject(explicit);
    await expect(assertBrowserJwk(explicit)).resolves.toMatchObject(explicit);
  });

  it('rejects incompatible alg and use values or types in both runtimes', async () => {
    const publicJwk = await validPublicJwk();
    for (const metadata of [
      { alg: 'ES384' },
      { alg: 256 },
      { use: 'enc' },
      { use: true },
    ]) {
      await expectParityReject({ ...publicJwk, ...metadata } as JsonWebKey);
    }
  });

  it('requires a unique verification-only key_ops set in both runtimes', async () => {
    const publicJwk = await validPublicJwk();
    for (const keyOps of [
      [],
      ['sign'],
      ['verify', 'sign'],
      ['verify', 'verify'],
      ['deriveKey', 'verify'],
      'verify',
      [7],
    ]) {
      await expectParityReject({ ...publicJwk, key_ops: keyOps } as JsonWebKey);
    }
  });

  it('rejects non-extractable imports and invalid kid metadata in both runtimes', async () => {
    const publicJwk = await validPublicJwk();
    for (const metadata of [
      { ext: false },
      { ext: 'true' },
      { kid: '' },
      { kid: '   ' },
      { kid: 7 },
    ]) {
      await expectParityReject({ ...publicJwk, ...metadata } as JsonWebKey);
    }
  });
});
