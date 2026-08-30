import type { AppConfig } from '../config/env.js';
import { DomainError } from '../domain/state-machine.js';
import type { Repository } from '../persistence/repository.js';

/**
 * Platform session token — signed JWT binding a wallet address.
 * Login itself is mocked (no wallet signature / SIWE verification in this build);
 * the address is taken as presented. See src/server/app.ts POST /v1/auth/login.
 */
export async function issueSessionToken(
  repo: Repository,
  config: AppConfig,
  address: `0x${string}`,
): Promise<string> {
  const { ensureSigningKey, importActivePrivateKey } = await import(
    '../credentials/signer.js'
  );
  const { SignJWT } = await import('jose');
  const key = await ensureSigningKey(repo);
  const privateKey = await importActivePrivateKey(key);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: address,
    typ: 'kya_session',
  })
    .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: 'JWT' })
    .setIssuer(config.KYA_ISSUER)
    .setAudience('kya-session')
    .setIssuedAt(now)
    .setExpirationTime(now + 60 * 60 * 8)
    .sign(privateKey);
}

export async function verifySessionToken(
  repo: Repository,
  config: AppConfig,
  token: string,
): Promise<`0x${string}`> {
  const { jwtVerify, importJWK, decodeProtectedHeader } = await import('jose');
  const header = decodeProtectedHeader(token);
  if (header.alg !== 'ES256') {
    throw new DomainError('Invalid session alg', 'JWT_ALG');
  }
  const store = await repo.getStore();
  const keys = store.signingKeys
    .filter((key) => key.kid === header.kid)
    .sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  if (keys.length === 0) throw new DomainError('Unknown session key', 'UNAUTHORIZED');
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'] | undefined;
  for (const key of keys) {
    try {
      const publicKey = await importJWK(key.publicJwk, 'ES256');
      payload = (
        await jwtVerify(token, publicKey, {
          issuer: config.KYA_ISSUER,
          audience: 'kya-session',
          algorithms: ['ES256'],
        })
      ).payload;
      break;
    } catch {
      // Legacy stores may contain duplicate kid values from the former rotation bug.
    }
  }
  if (!payload) {
    throw new DomainError('Invalid session token', 'UNAUTHORIZED');
  }
  const sub = String(payload.sub ?? '');
  if (!/^0x[a-fA-F0-9]{40}$/.test(sub)) {
    throw new DomainError('Invalid session subject', 'SESSION');
  }
  return sub.toLowerCase() as `0x${string}`;
}
