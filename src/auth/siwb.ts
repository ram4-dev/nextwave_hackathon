import { createPublicClient, getAddress, http, type Hex } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { parseSiweMessage, verifySiweMessage } from 'viem/siwe';
import type { AppConfig } from '../config/env.js';
import { DomainError } from '../domain/state-machine.js';
import type { Repository } from '../persistence/repository.js';
import { newId } from '../persistence/repository.js';

const BASE_CHAIN_IDS = new Set([8453, 84532]);

/** Reject SIWE issuedAt older/newer than this skew (seconds). */
export const SIWB_ISSUED_AT_SKEW_SECONDS = 300;

export interface SiwbVerifyInput {
  address: `0x${string}`;
  message: string;
  signature: Hex;
}

export type SiwbPublicClient = {
  verifySiweMessage: (args: {
    address?: `0x${string}`;
    domain?: string;
    message: string;
    nonce?: string;
    signature: Hex;
    time?: Date;
  }) => Promise<boolean>;
};

export function createAuthPublicClient(
  config: AppConfig,
  chainId: number,
): SiwbPublicClient {
  const transport =
    chainId === 84532
      ? http(config.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org')
      : chainId === 8453
        ? http(config.BASE_MAINNET_RPC_URL ?? 'https://mainnet.base.org')
        : null;
  if (!transport) {
    throw new DomainError(`Unsupported chain id ${chainId}`, 'CHAIN_ID');
  }
  const client = createPublicClient({
    chain: chainId === 84532 ? baseSepolia : base,
    transport,
  });
  return {
    verifySiweMessage: (args) => verifySiweMessage(client, args),
  };
}

export async function issueSiwbNonce(
  repo: Repository,
  ttlSeconds: number,
): Promise<{ nonce: string; expiresAt: string }> {
  const nonce = newId('nonce').replace('nonce_', '');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  await repo.withLock(async (store) => {
    store.nonces.push({
      nonce,
      purpose: 'siwb',
      createdAt: now.toISOString(),
      expiresAt,
    });
  });
  return { nonce, expiresAt };
}

function assertNonceUsable(
  record:
    | {
        nonce: string;
        purpose: string;
        consumedAt?: string;
        expiresAt: string;
      }
    | undefined,
  nonce: string,
): void {
  if (!record || record.purpose !== 'siwb' || record.nonce !== nonce) {
    throw new DomainError('Unknown SIWB nonce', 'SIWB_NONCE');
  }
  if (record.consumedAt) {
    throw new DomainError('SIWB nonce already used', 'SIWB_REPLAY');
  }
  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    throw new DomainError('SIWB nonce expired', 'SIWB_EXPIRED');
  }
}

/**
 * Parse + field-validate SIWE presentation (exact address, URI, chain, nonce,
 * issuedAt/expiration/notBefore). Signature is verified separately via
 * verifySiweMessage (ERC-6492 / smart-account compatible).
 */
export function assertSiwePresentationFields(
  message: string,
  config: AppConfig,
  claimedAddress: `0x${string}`,
  opts?: { time?: Date },
): { nonce: string; chainId: number; domain: string } {
  let parsed: ReturnType<typeof parseSiweMessage>;
  try {
    parsed = parseSiweMessage(message);
  } catch {
    throw new DomainError('Malformed SIWE message', 'SIWB_MESSAGE');
  }

  if (!parsed.nonce) {
    throw new DomainError('SIWE message missing nonce', 'SIWB_NONCE');
  }
  if (parsed.chainId == null || !BASE_CHAIN_IDS.has(parsed.chainId)) {
    throw new DomainError(
      'SIWE chain ID must be Base (8453) or Base Sepolia (84532)',
      'CHAIN_ID',
    );
  }
  if (!parsed.domain || parsed.domain.toLowerCase() !== config.SIWB_DOMAIN.toLowerCase()) {
    throw new DomainError('SIWE domain mismatch', 'SIWB_DOMAIN');
  }
  if (!parsed.uri || parsed.uri !== config.SIWB_URI) {
    throw new DomainError('SIWE URI mismatch', 'SIWB_URI');
  }
  if (!parsed.address) {
    throw new DomainError('SIWE message missing address', 'SIWB_ADDRESS');
  }
  let messageAddress: `0x${string}`;
  try {
    messageAddress = getAddress(parsed.address) as `0x${string}`;
  } catch {
    throw new DomainError('SIWE message invalid address', 'SIWB_ADDRESS');
  }
  if (messageAddress.toLowerCase() !== claimedAddress.toLowerCase()) {
    throw new DomainError('SIWE address mismatch', 'SIWB_ADDRESS');
  }
  if (parsed.version && parsed.version !== '1') {
    throw new DomainError('SIWE version must be 1', 'SIWB_VERSION');
  }

  const time = opts?.time ?? new Date();
  if (Number.isNaN(time.getTime())) {
    throw new DomainError('Invalid SIWE validation time', 'SIWB_TIME');
  }

  if (parsed.expirationTime) {
    if (Number.isNaN(parsed.expirationTime.getTime())) {
      throw new DomainError('Invalid SIWE expirationTime', 'SIWB_EXPIRED');
    }
    if (time >= parsed.expirationTime) {
      throw new DomainError('SIWE message expired', 'SIWB_EXPIRED');
    }
  }
  if (parsed.notBefore) {
    if (Number.isNaN(parsed.notBefore.getTime())) {
      throw new DomainError('Invalid SIWE notBefore', 'SIWB_NOT_BEFORE');
    }
    if (time < parsed.notBefore) {
      throw new DomainError('SIWE message not yet valid', 'SIWB_NOT_BEFORE');
    }
  }
  if (parsed.issuedAt) {
    if (Number.isNaN(parsed.issuedAt.getTime())) {
      throw new DomainError('Invalid SIWE issuedAt', 'SIWB_ISSUED_AT');
    }
    const skewMs = SIWB_ISSUED_AT_SKEW_SECONDS * 1000;
    if (parsed.issuedAt.getTime() > time.getTime() + skewMs) {
      throw new DomainError('SIWE issuedAt is in the future', 'SIWB_ISSUED_AT');
    }
    if (parsed.issuedAt.getTime() < time.getTime() - skewMs) {
      throw new DomainError('SIWE issuedAt is too stale', 'SIWB_ISSUED_AT');
    }
  }

  return {
    nonce: parsed.nonce,
    chainId: parsed.chainId,
    domain: parsed.domain,
  };
}

/**
 * Verify SIWB: parseSiweMessage field checks + viem verifySiweMessage
 * (ERC-6492 / smart-account compatible), then atomically consume nonce.
 * Invalid presentation/signature must not burn the nonce.
 */
export async function verifySiwbLogin(
  repo: Repository,
  config: AppConfig,
  input: SiwbVerifyInput,
  opts?: { publicClient?: SiwbPublicClient; time?: Date },
): Promise<{ address: `0x${string}`; chainId: number }> {
  let address: `0x${string}`;
  try {
    address = getAddress(input.address) as `0x${string}`;
  } catch {
    throw new DomainError('Invalid SIWB address', 'SIWB_ADDRESS');
  }

  const time = opts?.time ?? new Date();
  const { nonce, chainId, domain } = assertSiwePresentationFields(
    input.message,
    config,
    address,
    { time },
  );

  {
    const store = await repo.getStore();
    assertNonceUsable(
      store.nonces.find((n) => n.nonce === nonce && n.purpose === 'siwb'),
      nonce,
    );
  }

  const client = opts?.publicClient ?? createAuthPublicClient(config, chainId);
  const valid = await client.verifySiweMessage({
    address,
    domain,
    message: input.message,
    nonce,
    signature: input.signature,
    time,
  });
  if (!valid) {
    throw new DomainError('Invalid SIWB signature', 'SIWB_SIGNATURE');
  }

  await repo.withLock(async (store) => {
    const record = store.nonces.find((n) => n.nonce === nonce && n.purpose === 'siwb');
    assertNonceUsable(record, nonce);
    assertSiwePresentationFields(input.message, config, address, { time });
    record!.consumedAt = new Date().toISOString();
  });

  return { address: address.toLowerCase() as `0x${string}`, chainId };
}

/** Session token for demo/hackathon — signed JWT binding wallet address. */
export async function issueSessionToken(
  repo: Repository,
  config: AppConfig,
  address: `0x${string}`,
): Promise<string> {
  const { ensureSigningKey, importActivePrivateKey } = await import(
    '../credentials/signer.js'
  );
  const { SignJWT } = await import('jose');
  const key = await ensureSigningKey(repo, config);
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
  const { ensureSigningKey } = await import('../credentials/signer.js');
  const { jwtVerify, importJWK, decodeProtectedHeader } = await import('jose');
  const header = decodeProtectedHeader(token);
  if (header.alg !== 'ES256') {
    throw new DomainError('Invalid session alg', 'JWT_ALG');
  }
  await ensureSigningKey(repo, config);
  const store = await repo.getStore();
  const key =
    store.signingKeys.find((k) => k.kid === header.kid) ??
    store.signingKeys.find((k) => k.active);
  if (!key) throw new DomainError('Unknown session key', 'JWT_KID');
  const publicKey = await importJWK(key.publicJwk, 'ES256');
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: config.KYA_ISSUER,
    audience: 'kya-session',
    algorithms: ['ES256'],
  });
  const sub = String(payload.sub ?? '');
  if (!/^0x[a-fA-F0-9]{40}$/.test(sub)) {
    throw new DomainError('Invalid session subject', 'SESSION');
  }
  return sub.toLowerCase() as `0x${string}`;
}
