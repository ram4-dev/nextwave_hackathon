import { importJWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { generateMandateSigningJwk } from '../scripts/generate-mandate-signing-jwk.js';

describe('mandate signing JWK generator', () => {
  it('generates a separate ES256 private JWK and safe public registration JWK', async () => {
    const generated = await generateMandateSigningJwk();
    expect(generated.privateJwk).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: generated.kid });
    expect(generated.privateJwk.d).toEqual(expect.any(String));
    expect(generated.publicJwk).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: generated.kid });
    expect(generated.publicJwk).not.toHaveProperty('d');
    await expect(importJWK(generated.privateJwk, 'ES256')).resolves.toBeDefined();
  });
});
