import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  stringToHex,
  type Abi,
  type Hex,
} from 'viem';
import { base, baseSepolia } from 'viem/chains';
import identityRegistryAbi from '../../abis/IdentityRegistry.json' with { type: 'json' };
import {
  IDENTITY_REGISTRY_MAINNET,
  IDENTITY_REGISTRY_SEPOLIA,
  type AppConfig,
} from '../config/env.js';
import { DomainError, mainnetPromotionAllowed } from '../domain/state-machine.js';

export { IDENTITY_REGISTRY_MAINNET, IDENTITY_REGISTRY_SEPOLIA };

export const IDENTITY_REGISTRY_ABI = identityRegistryAbi as Abi;

/**
 * Supported Identity Registry `getVersion()` for KYA F5 readiness.
 * Provenance (read-only, 2026-08-29): live `getVersion()` on curated Base Sepolia
 * `0x8004A818…BD9e` and Base Mainnet `0x8004A169…a432` both returned `2.0.0`
 * (proxy bytecode 130 bytes). Exact equality required — non-empty alone is insufficient.
 */
export const SUPPORTED_IDENTITY_REGISTRY_VERSION = '2.0.0' as const;

export function isSupportedIdentityRegistryVersion(version: unknown): version is string {
  return typeof version === 'string' && version === SUPPORTED_IDENTITY_REGISTRY_VERSION;
}

export function agentRegistryRef(chainId: number, registry: `0x${string}`): string {
  return `eip155:${chainId}:${getAddress(registry)}`;
}

export function createRegistryPublicClient(
  config: AppConfig,
  chainId: 84532 | 8453,
): {
  getCode: (args: { address: `0x${string}` }) => Promise<Hex | undefined>;
  readContract: (args: Record<string, unknown>) => Promise<unknown>;
  getBlockNumber: () => Promise<bigint>;
  watchContractEvent: (args: Record<string, unknown>) => () => void;
} {
  if (chainId === 84532) {
    return createPublicClient({
      chain: baseSepolia,
      transport: http(config.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org'),
    }) as never;
  }
  return createPublicClient({
    chain: base,
    transport: http(config.BASE_MAINNET_RPC_URL ?? 'https://mainnet.base.org'),
  }) as never;
}

/**
 * Resolve curated registry address. Mainnet never trusts hardcoded
 * getVersionOk/codePresent — callers must pass verified readiness.
 */
export function resolveRegistryAddress(
  config: AppConfig,
  chainId: number,
  readiness?: { codePresent: boolean; getVersionOk: boolean },
): `0x${string}` {
  if (chainId === 84532) return IDENTITY_REGISTRY_SEPOLIA;
  if (chainId === 8453) {
    if (!readiness) {
      throw new DomainError(
        'Mainnet registry requires live code/getVersion verification',
        'MAINNET_GATE',
      );
    }
    const gate = mainnetPromotionAllowed({
      enabled: config.MAINNET_PROMOTION_ENABLED,
      registryVerified: config.MAINNET_REGISTRY_VERIFIED,
      getVersionOk: readiness.getVersionOk,
      codePresent: readiness.codePresent,
    });
    if (!gate.allowed) {
      throw new DomainError(gate.reason ?? 'Mainnet gated', 'MAINNET_GATE');
    }
    return IDENTITY_REGISTRY_MAINNET;
  }
  throw new DomainError(`Unsupported chain ${chainId}`, 'CHAIN_ID');
}

export function encodeRegisterAgentUri(agentURI: string): Hex {
  return encodeFunctionData({
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'register',
    args: [agentURI],
  });
}

export function hashRegisterCall(opts: {
  chainId: number;
  registry: `0x${string}`;
  agentURI: string;
}): string {
  return keccak256(
    stringToHex(
      JSON.stringify({
        chainId: opts.chainId,
        registry: getAddress(opts.registry),
        agentURI: opts.agentURI,
        fn: 'register',
      }),
    ),
  );
}

/**
 * Build wallet_sendCalls params for user Base Account.
 * KYA/relayer must NEVER be msg.sender — calls go through the user's smart account.
 * `from` is required by @base-org/account WalletSendCallsParams.
 */
export function buildRegisterSendCalls(opts: {
  chainId: number;
  registry: `0x${string}`;
  agentURI: string;
  /** Authenticated smart-account / owner address (checksummed into `from`). */
  from: `0x${string}`;
  paymasterUrl?: string;
}): {
  version: string;
  chainId: Hex;
  from: Hex;
  atomicRequired: boolean;
  calls: Array<{ to: `0x${string}`; data: Hex; value: Hex }>;
  capabilities?: {
    paymasterService?: { url: string };
  };
} {
  const data = encodeRegisterAgentUri(opts.agentURI);
  const from = getAddress(opts.from);
  const params: {
    version: string;
    chainId: Hex;
    from: Hex;
    atomicRequired: boolean;
    calls: Array<{ to: `0x${string}`; data: Hex; value: Hex }>;
    capabilities?: {
      paymasterService?: { url: string };
    };
  } = {
    version: '2.0.0',
    chainId: `0x${opts.chainId.toString(16)}` as Hex,
    from,
    atomicRequired: true,
    calls: [
      {
        to: getAddress(opts.registry),
        data,
        value: '0x0',
      },
    ],
  };
  if (opts.paymasterUrl) {
    params.capabilities = {
      paymasterService: { url: opts.paymasterUrl },
    };
  }
  return params;
}

export async function verifyRegistryReady(
  client: {
    getCode: (args: { address: `0x${string}` }) => Promise<Hex | undefined>;
    readContract: (args: Record<string, unknown>) => Promise<unknown>;
  },
  address: `0x${string}`,
): Promise<{ codePresent: boolean; version?: string; getVersionOk: boolean }> {
  const code = await client.getCode({ address });
  const codePresent = Boolean(code && code !== '0x');
  if (!codePresent) return { codePresent: false, getVersionOk: false };
  try {
    const version = (await client.readContract({
      address,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'getVersion',
    })) as string;
    if (!isSupportedIdentityRegistryVersion(version)) {
      return {
        codePresent: true,
        version: typeof version === 'string' ? version : undefined,
        getVersionOk: false,
      };
    }
    return { codePresent: true, version, getVersionOk: true };
  } catch {
    return { codePresent: true, getVersionOk: false };
  }
}

/**
 * Which chains get live event watchers.
 * Always Sepolia (84532) in live mode. Mainnet (8453) only when both promotion
 * flags are set — readiness/exact version are checked before starting that watcher.
 */
export function selectLiveWatcherChains(config: {
  MAINNET_PROMOTION_ENABLED: boolean;
  MAINNET_REGISTRY_VERIFIED: boolean;
}): Array<84532 | 8453> {
  const chains: Array<84532 | 8453> = [84532];
  if (config.MAINNET_PROMOTION_ENABLED && config.MAINNET_REGISTRY_VERIFIED) {
    chains.push(8453);
  }
  return chains;
}

/** Fail-closed readiness for prepare/watch on Sepolia or Mainnet. */
export async function assertRegistryReadyForChain(
  config: AppConfig,
  chainId: number,
  client?: Parameters<typeof verifyRegistryReady>[0],
): Promise<{ registry: `0x${string}`; version: string }> {
  const provisional =
    chainId === 84532
      ? IDENTITY_REGISTRY_SEPOLIA
      : chainId === 8453
        ? IDENTITY_REGISTRY_MAINNET
        : null;
  if (!provisional) throw new DomainError(`Unsupported chain ${chainId}`, 'CHAIN_ID');

  const rpcClient =
    client ??
    createRegistryPublicClient(config, chainId as 84532 | 8453);

  const ready = await verifyRegistryReady(rpcClient, provisional);
  if (!ready.codePresent || !ready.getVersionOk || !ready.version) {
    throw new DomainError(
      `Identity Registry not ready on chain ${chainId} (code/getVersion must be ${SUPPORTED_IDENTITY_REGISTRY_VERSION}; got ${ready.version ?? 'none'})`,
      'REGISTRY_NOT_READY',
    );
  }

  const registry = resolveRegistryAddress(config, chainId, {
    codePresent: ready.codePresent,
    getVersionOk: ready.getVersionOk,
  });
  return { registry, version: ready.version };
}

export async function readOwnerOf(
  client: { readContract: (args: Record<string, unknown>) => Promise<unknown> },
  registry: `0x${string}`,
  agentId: bigint,
): Promise<`0x${string}`> {
  const owner = (await client.readContract({
    address: registry,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'ownerOf',
    args: [agentId],
  })) as `0x${string}`;
  return getAddress(owner);
}

export async function readTokenUri(
  client: { readContract: (args: Record<string, unknown>) => Promise<unknown> },
  registry: `0x${string}`,
  agentId: bigint,
): Promise<string> {
  return (await client.readContract({
    address: registry,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'tokenURI',
    args: [agentId],
  })) as string;
}

export async function assertMainnetGate(
  config: AppConfig,
  client: Parameters<typeof verifyRegistryReady>[0],
): Promise<void> {
  const ready = await verifyRegistryReady(client, IDENTITY_REGISTRY_MAINNET);
  const gate = mainnetPromotionAllowed({
    enabled: config.MAINNET_PROMOTION_ENABLED,
    registryVerified: config.MAINNET_REGISTRY_VERIFIED,
    getVersionOk: ready.getVersionOk,
    codePresent: ready.codePresent,
  });
  if (!gate.allowed) {
    throw new DomainError(gate.reason ?? 'Mainnet gate closed', 'MAINNET_GATE');
  }
}

/** Demo-mode simulated registration — no chain write. */
export function demoRegisterResult(opts: {
  chainId: number;
  registry: `0x${string}`;
  owner: `0x${string}`;
  agentURI: string;
  agentId?: bigint;
}): {
  agentId: string;
  agentRegistry: string;
  owner: `0x${string}`;
  agentURI: string;
  demo: true;
} {
  const agentId = (opts.agentId ?? 8004n).toString();
  return {
    agentId,
    agentRegistry: agentRegistryRef(opts.chainId, opts.registry),
    owner: getAddress(opts.owner),
    agentURI: opts.agentURI,
    demo: true,
  };
}
