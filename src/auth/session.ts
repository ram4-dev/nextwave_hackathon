import { decodeProtectedHeader, importJWK, jwtVerify, SignJWT } from 'jose';
import type { AppConfig } from '../config/env.js';
import type { Principal } from '../domain/types.js';
import { DomainError } from '../domain/state-machine.js';
import type { Repository } from '../persistence/repository.js';

const SESSION_AUDIENCE = 'kya-human-session';
const SESSION_TTL_SECONDS = 15 * 60;
export const HUMAN_SESSION_TYP = 'KYA-HUMAN-SESSION+JWT';

export type HumanSession = { principalId: string; wallet: `0x${string}` };

export async function issueHumanSession(repo: Repository, config: AppConfig, principal: Principal): Promise<string> {
  const { ensureSigningKey, importActivePrivateKey } = await import('../credentials/signer.js');
  const key = await ensureSigningKey(repo, config);
  const privateKey = await importActivePrivateKey(key);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ wallet: principal.ownerAddress, typ: 'kya_session' })
    .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: HUMAN_SESSION_TYP })
    .setIssuer(config.KYA_ISSUER).setAudience(SESSION_AUDIENCE).setSubject(principal.id)
    .setIssuedAt(now).setExpirationTime(now + SESSION_TTL_SECONDS).sign(privateKey);
}

export async function verifyHumanSession(repo: Repository, config: AppConfig, token: string): Promise<HumanSession> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try { header = decodeProtectedHeader(token); } catch { throw new DomainError('Invalid session token', 'UNAUTHORIZED'); }
  if (header.alg !== 'ES256' || !header.kid) {
    throw new DomainError('Invalid session alg', 'JWT_ALG');
  }
  if (header.typ !== HUMAN_SESSION_TYP) {
    throw new DomainError('Invalid session token class', 'UNAUTHORIZED');
  }
  const store = await repo.getStore();
  const keys = store.signingKeys
    .filter((item) => item.kid === header.kid)
    .sort((a, b) => Number(b.active) - Number(a.active) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (keys.length === 0) throw new DomainError('Unknown session key', 'UNAUTHORIZED');
  let payload;
  for (const key of keys) {
    try {
      payload = (await jwtVerify(token, await importJWK(key.publicJwk, 'ES256'), {
        issuer: config.KYA_ISSUER,
        audience: SESSION_AUDIENCE,
        algorithms: ['ES256'],
        typ: HUMAN_SESSION_TYP,
      })).payload;
      break;
    } catch {
      // A historical duplicate kid may have been signed by an older retained key.
    }
  }
  if (!payload) throw new DomainError('Invalid session token', 'UNAUTHORIZED');
  const principalId = String(payload.sub ?? ''); const wallet = String(payload.wallet ?? '');
  if (payload.typ !== 'kya_session' || !principalId || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) throw new DomainError('Invalid session claims', 'UNAUTHORIZED');
  const principal = store.principals.find((item) => item.id === principalId);
  if (!principal || principal.ownerAddress.toLowerCase() !== wallet.toLowerCase()) throw new DomainError('Session principal binding changed', 'UNAUTHORIZED');
  return { principalId, wallet: wallet.toLowerCase() as `0x${string}` };
}
