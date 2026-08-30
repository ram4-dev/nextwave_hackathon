import { calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { sanitizePublicJwk } from '../src/crypto/local-agent-key.js';

export async function generateMandateSigningJwk(): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey; kid: string }> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = sanitizePublicJwk(await exportJWK(publicKey));
  const kid = `mandate-${await calculateJwkThumbprint(publicJwk, 'sha256')}`;
  const privateJwk = Object.assign(await exportJWK(privateKey), { kid, use: 'sig', alg: 'ES256' }) as JsonWebKey;
  const registeredPublicJwk = Object.assign(publicJwk, { kid, use: 'sig', alg: 'ES256' }) as JsonWebKey;
  return { privateJwk, publicJwk: registeredPublicJwk, kid };
}

async function main() {
  const { privateJwk, publicJwk, kid } = await generateMandateSigningJwk();
  // stdout is intentionally private-JWK-only so it can be sent directly to a
  // secret manager. Never commit or paste this output into chat.
  process.stdout.write(`${JSON.stringify(privateJwk)}\n`);
  // Keep registration material visible without mixing it into the secret value.
  console.error(JSON.stringify({ kid, publicJwk, next: 'Register publicJwk in KYA for this agent; store stdout as MANDATE_SIGNING_PRIVATE_JWK.' }, null, 2));
}

if (process.argv[1]?.endsWith('generate-mandate-signing-jwk.ts')) {
  main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
