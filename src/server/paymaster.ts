import { createHash, randomBytes } from 'node:crypto';
import { getAddress, type Hex } from 'viem';
import type { AppConfig } from '../config/env.js';
import { DomainError } from '../domain/state-machine.js';
import type { PaymasterCapability } from '../domain/types.js';
import type { Repository } from '../persistence/repository.js';
import { encodeRegisterAgentUri } from '../registry/identity.js';

/** ERC-7677 / Coinbase paymaster JSON-RPC methods accepted by the proxy. */
export const ALLOWED_PAYMASTER_METHODS = new Set([
  'pm_getPaymasterStubData',
  'pm_getPaymasterData',
  'pm_sponsorUserOperation',
  'pm_validatePaymasterUserOp',
]);

export const PAYMASTER_MAX_BODY_BYTES = 64 * 1024;

export function hashCapabilityToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * Issue a high-entropy raw capability token. Persist only SHA-256(token) +
 * public scope metadata (never the raw bearer).
 */
export async function issuePaymasterCapability(
  repo: Repository,
  config: AppConfig,
  input: {
    agentUuid: string;
    chainId: number;
    registry: `0x${string}`;
    agentURI: string;
    ownerAddress: `0x${string}`;
  },
): Promise<{ rawToken: string; record: PaymasterCapability }> {
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = hashCapabilityToken(rawToken);
  const registry = getAddress(input.registry);
  const expectedCalldata = encodeRegisterAgentUri(input.agentURI);
  const now = new Date();
  const record: PaymasterCapability = {
    tokenHash,
    agentUuid: input.agentUuid,
    chainId: input.chainId,
    registry,
    ownerAddress: getAddress(input.ownerAddress).toLowerCase() as `0x${string}`,
    agentURI: input.agentURI,
    expectedCalldata,
    createdAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + config.PAYMASTER_CAPABILITY_TTL_SECONDS * 1000,
    ).toISOString(),
    useCount: 0,
  };
  await repo.withLock(async (store) => {
    store.paymasterCapabilities.push(record);
  });
  return { rawToken, record };
}

export function capabilityProxyUrl(config: AppConfig, rawToken: string): string {
  return `${config.PUBLIC_BASE_URL}/v1/paymaster/proxy?c=${encodeURIComponent(rawToken)}`;
}

/** Look up by hash of the presented raw token. Does not increment useCount. */
export async function lookupPaymasterCapability(
  repo: Repository,
  rawToken: string | undefined,
): Promise<PaymasterCapability> {
  if (!rawToken) {
    throw new DomainError('Paymaster capability required', 'PAYMASTER_CAPABILITY');
  }
  const tokenHash = hashCapabilityToken(rawToken);
  const store = await repo.getStore();
  const cap = store.paymasterCapabilities.find((c) => c.tokenHash === tokenHash);
  if (!cap) {
    throw new DomainError('Unknown paymaster capability', 'PAYMASTER_CAPABILITY');
  }
  if (new Date(cap.expiresAt).getTime() <= Date.now()) {
    throw new DomainError('Paymaster capability expired', 'PAYMASTER_EXPIRED');
  }
  return { ...cap };
}

export async function incrementPaymasterCapabilityUse(
  repo: Repository,
  tokenHash: string,
): Promise<void> {
  await repo.withLock(async (store) => {
    const cap = store.paymasterCapabilities.find((c) => c.tokenHash === tokenHash);
    if (!cap) {
      throw new DomainError('Unknown paymaster capability', 'PAYMASTER_CAPABILITY');
    }
    if (cap.useCount >= 50) {
      throw new DomainError('Paymaster capability rate limited', 'PAYMASTER_RATE');
    }
    cap.useCount += 1;
  });
}

function asHexString(value: unknown): Hex | null {
  if (typeof value !== 'string') return null;
  if (!/^0x[0-9a-fA-F]*$/.test(value)) return null;
  return value as Hex;
}

function extractUserOpAndChain(params: unknown[]): {
  userOp: Record<string, unknown>;
  chainIdHex?: string;
} {
  if (!Array.isArray(params) || params.length === 0) {
    throw new DomainError('Paymaster params empty', 'PAYMASTER_PARAMS');
  }
  const first = params[0];
  // pm_sponsorUserOperation sometimes nests { userOperation }
  let userOp: Record<string, unknown> | null = null;
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const obj = first as Record<string, unknown>;
    if (obj.sender != null || obj.callData != null) {
      userOp = obj;
    } else if (obj.userOperation && typeof obj.userOperation === 'object') {
      userOp = obj.userOperation as Record<string, unknown>;
    }
  }
  if (!userOp) {
    throw new DomainError('Paymaster userOperation missing', 'PAYMASTER_PARAMS');
  }

  let chainIdHex: string | undefined;
  // ERC-7677: [userOp, entryPoint, chainId, context]
  if (typeof params[2] === 'string' && params[2].startsWith('0x')) {
    chainIdHex = params[2];
  } else if (typeof params[1] === 'string' && /^0x[0-9a-fA-F]+$/.test(params[1]) && params[1].length <= 10) {
    // Some legacy shapes put chainId second
    chainIdHex = params[1];
  }
  return { userOp, chainIdHex };
}

/**
 * Enforce capability scope against JSON-RPC params before forwarding.
 *
 * Residual honesty: smart-account userOp.callData is typically an account
 * `execute`/`executeBatch` wrapper. We require sender == scoped owner, chainId
 * match when present, and that callData *contains* the curated registry address
 * bytes and the exact register(agentURI) calldata. That is containment binding,
 * not full AA semantic decode. Provider policy must still allowlist the registry.
 */
export function assertPaymasterRequestScoped(
  cap: PaymasterCapability,
  rawBody: string,
): { method: string } {
  if (Buffer.byteLength(rawBody, 'utf8') > PAYMASTER_MAX_BODY_BYTES) {
    throw new DomainError('Paymaster body too large', 'PAYMASTER_BODY');
  }
  let parsed: { method?: unknown; params?: unknown };
  try {
    parsed = JSON.parse(rawBody) as { method?: unknown; params?: unknown };
  } catch {
    throw new DomainError('Malformed paymaster JSON-RPC', 'PAYMASTER_BODY');
  }
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  if (!ALLOWED_PAYMASTER_METHODS.has(method)) {
    throw new DomainError(`Paymaster method not allowed: ${method}`, 'PAYMASTER_METHOD');
  }
  if (!Array.isArray(parsed.params) || parsed.params.length === 0) {
    throw new DomainError('Paymaster params empty', 'PAYMASTER_PARAMS');
  }

  const { userOp, chainIdHex } = extractUserOpAndChain(parsed.params);
  const sender = asHexString(userOp.sender);
  if (!sender) {
    throw new DomainError('Paymaster userOperation.sender required', 'PAYMASTER_SENDER');
  }
  let senderChecksummed: `0x${string}`;
  try {
    senderChecksummed = getAddress(sender);
  } catch {
    throw new DomainError('Paymaster userOperation.sender invalid', 'PAYMASTER_SENDER');
  }
  if (senderChecksummed.toLowerCase() !== cap.ownerAddress.toLowerCase()) {
    throw new DomainError('Paymaster sender does not match capability owner', 'PAYMASTER_SENDER');
  }

  if (chainIdHex) {
    const chainId = Number.parseInt(chainIdHex, 16);
    if (!Number.isFinite(chainId) || chainId !== cap.chainId) {
      throw new DomainError('Paymaster chainId mismatch', 'PAYMASTER_CHAIN');
    }
  }

  const callData = asHexString(userOp.callData);
  if (!callData || callData === '0x') {
    throw new DomainError('Paymaster callData required', 'PAYMASTER_CALLDATA');
  }
  const callDataLower = callData.toLowerCase();
  const registryBytes = cap.registry.toLowerCase().replace(/^0x/, '');
  const expectedCalldata = cap.expectedCalldata.toLowerCase();
  if (!callDataLower.includes(registryBytes)) {
    throw new DomainError(
      'Paymaster callData missing scoped registry target',
      'PAYMASTER_CALLDATA',
    );
  }
  if (!callDataLower.includes(expectedCalldata.replace(/^0x/, ''))) {
    throw new DomainError(
      'Paymaster callData missing scoped register(agentURI) calldata',
      'PAYMASTER_CALLDATA',
    );
  }

  return { method };
}

/** @deprecated use assertPaymasterRequestScoped — kept for narrow method checks in tests */
export function parsePaymasterJsonRpc(rawBody: string): {
  method: string;
  body: string;
} {
  if (Buffer.byteLength(rawBody, 'utf8') > PAYMASTER_MAX_BODY_BYTES) {
    throw new DomainError('Paymaster body too large', 'PAYMASTER_BODY');
  }
  let parsed: { method?: unknown; params?: unknown };
  try {
    parsed = JSON.parse(rawBody) as { method?: unknown; params?: unknown };
  } catch {
    throw new DomainError('Malformed paymaster JSON-RPC', 'PAYMASTER_BODY');
  }
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  if (!ALLOWED_PAYMASTER_METHODS.has(method)) {
    throw new DomainError(`Paymaster method not allowed: ${method}`, 'PAYMASTER_METHOD');
  }
  return { method, body: rawBody };
}
