import type { Abi, Log } from 'viem';
import { getAddress, parseAbiItem } from 'viem';
import { suspendOnTransfer } from '../domain/state-machine.js';
import { eventId, type Repository } from '../persistence/repository.js';
import { IDENTITY_REGISTRY_ABI } from './identity.js';
import { setCredentialStatus } from '../credentials/jws.js';

type WatchClient = {
  getBlockNumber: () => Promise<bigint>;
  getContractEvents?: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  watchContractEvent?: (args: Record<string, unknown>) => () => void;
};

export interface RegisteredPayload {
  agentId: string;
  agentURI: string;
  owner: `0x${string}`;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
}

export interface TransferPayload {
  from: `0x${string}`;
  to: `0x${string}`;
  tokenId: string;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
}

type PendingRegistered = {
  kind: 'Registered';
  chainId: number;
  payload: RegisteredPayload;
  registryAddress: `0x${string}`;
  publicBaseUrl?: string;
};

type PendingTransfer = {
  kind: 'Transfer';
  chainId: number;
  payload: TransferPayload;
  registryAddress: `0x${string}`;
};

type PendingEvent = PendingRegistered | PendingTransfer;

/** Confirmation depth: block itself counts as 1. */
export function hasEnoughConfirmations(
  blockNumber: bigint,
  currentBlock: bigint,
  confirmations: number,
): boolean {
  const depth = currentBlock - blockNumber + 1n;
  return depth >= BigInt(confirmations);
}

function expectedAgentUri(publicBaseUrl: string, agentUriPath: string): string {
  return `${publicBaseUrl.replace(/\/$/, '')}${agentUriPath}`;
}

export interface ApplyRegisteredResult {
  applied: boolean;
  bound: boolean;
  reason?: string;
}

/**
 * Idempotent, confirmation-aware event application.
 * Fail closed: matching URI without Principal, or owner ≠ principal, never binds.
 * Cursor is scoped by chainId + registryAddress.
 */
export async function applyRegisteredEvent(
  repo: Repository,
  chainId: number,
  payload: RegisteredPayload,
  opts?: {
    confirmations?: number;
    currentBlock?: bigint;
    registryAddress?: `0x${string}`;
    publicBaseUrl?: string;
  },
): Promise<ApplyRegisteredResult> {
  const confirmations = opts?.confirmations ?? 1;
  if (
    opts?.currentBlock != null &&
    !hasEnoughConfirmations(payload.blockNumber, opts.currentBlock, confirmations)
  ) {
    return { applied: false, bound: false, reason: 'pending_confirmations' };
  }

  const registryAddress = opts?.registryAddress
    ? getAddress(opts.registryAddress)
    : undefined;

  const id = eventId(chainId, payload.txHash, payload.logIndex);
  return repo.withLock(async (store) => {
    if (store.processedEvents.some((e) => e.id === id)) {
      return { applied: false, bound: false, reason: 'duplicate' };
    }
    store.processedEvents.push({
      id,
      chainId,
      txHash: payload.txHash,
      logIndex: payload.logIndex,
      eventName: 'Registered',
      processedAt: new Date().toISOString(),
      payload: {
        agentId: payload.agentId,
        agentURI: payload.agentURI,
        owner: payload.owner,
      },
    });

    const enrollment = store.enrollments.find((e) => {
      if (e.status !== 'awaiting_onchain' && e.status !== 'awaiting_register') {
        return false;
      }
      if (!e.agentUriPath) return false;
      if (opts?.publicBaseUrl) {
        return payload.agentURI === expectedAgentUri(opts.publicBaseUrl, e.agentUriPath);
      }
      return payload.agentURI === e.agentUriPath || payload.agentURI.endsWith(e.agentUriPath);
    });

    let bound = false;
    if (enrollment) {
      const owner = getAddress(payload.owner);
      if (!enrollment.principalId) {
        // Fail closed: never bind without a Principal.
      } else {
        const principal = store.principals.find((p) => p.id === enrollment.principalId);
        if (
          !principal ||
          principal.ownerAddress.toLowerCase() !== owner.toLowerCase()
        ) {
          // Fail closed: wrong-owner matching URI is not bound.
        } else {
          enrollment.agentId = payload.agentId;
          enrollment.owner = owner;
          if (registryAddress) {
            enrollment.agentRegistry = `eip155:${chainId}:${registryAddress}`;
          }
          enrollment.status = 'bound';
          enrollment.updatedAt = new Date().toISOString();
          bound = true;
        }
      }
    }

    if (registryAddress) {
      const cursor = store.cursors.find(
        (c) => c.chainId === chainId && getAddress(c.registryAddress) === registryAddress,
      );
      if (
        !cursor ||
        payload.blockNumber > cursor.lastBlock ||
        (payload.blockNumber === cursor.lastBlock &&
          payload.logIndex > cursor.lastLogIndex)
      ) {
        if (cursor) {
          cursor.lastBlock = payload.blockNumber;
          cursor.lastLogIndex = payload.logIndex;
          cursor.updatedAt = new Date().toISOString();
        } else {
          store.cursors.push({
            chainId,
            registryAddress,
            lastBlock: payload.blockNumber,
            lastLogIndex: payload.logIndex,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }

    return { applied: true, bound };
  });
}

export async function applyTransferEvent(
  repo: Repository,
  chainId: number,
  payload: TransferPayload,
  opts?: {
    confirmations?: number;
    currentBlock?: bigint;
    registryAddress?: `0x${string}`;
  },
): Promise<{ applied: boolean; suspendedAgentUuid?: string }> {
  if (payload.from === '0x0000000000000000000000000000000000000000') {
    return { applied: false };
  }

  const confirmations = opts?.confirmations ?? 1;
  if (
    opts?.currentBlock != null &&
    !hasEnoughConfirmations(payload.blockNumber, opts.currentBlock, confirmations)
  ) {
    return { applied: false };
  }

  const registryAddress = opts?.registryAddress
    ? getAddress(opts.registryAddress)
    : undefined;

  const id = eventId(chainId, payload.txHash, payload.logIndex);
  let suspendedAgentUuid: string | undefined;

  await repo.withLock(async (store) => {
    if (store.processedEvents.some((e) => e.id === id)) {
      return;
    }
    store.processedEvents.push({
      id,
      chainId,
      txHash: payload.txHash,
      logIndex: payload.logIndex,
      eventName: 'Transfer',
      processedAt: new Date().toISOString(),
      payload: {
        from: payload.from,
        to: payload.to,
        tokenId: payload.tokenId,
      },
    });

    for (let i = 0; i < store.enrollments.length; i++) {
      const e = store.enrollments[i]!;
      if (e.agentId !== payload.tokenId || e.status !== 'bound') continue;
      if (registryAddress && e.agentRegistry) {
        const expected = `eip155:${chainId}:${registryAddress}`;
        if (e.agentRegistry.toLowerCase() !== expected.toLowerCase()) continue;
      } else if (e.agentRegistry) {
        const prefix = `eip155:${chainId}:`;
        if (!e.agentRegistry.toLowerCase().startsWith(prefix.toLowerCase())) continue;
      }
      store.enrollments[i] = suspendOnTransfer(e);
      store.enrollments[i]!.owner = getAddress(payload.to);
      suspendedAgentUuid = e.agentUuid;
    }

    if (registryAddress) {
      const cursor = store.cursors.find(
        (c) => c.chainId === chainId && getAddress(c.registryAddress) === registryAddress,
      );
      if (cursor) {
        if (
          payload.blockNumber > cursor.lastBlock ||
          (payload.blockNumber === cursor.lastBlock &&
            payload.logIndex > cursor.lastLogIndex)
        ) {
          cursor.lastBlock = payload.blockNumber;
          cursor.lastLogIndex = payload.logIndex;
          cursor.updatedAt = new Date().toISOString();
        }
      } else {
        store.cursors.push({
          chainId,
          registryAddress,
          lastBlock: payload.blockNumber,
          lastLogIndex: payload.logIndex,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  });

  if (suspendedAgentUuid) {
    const store = await repo.getStore();
    for (const c of store.credentials) {
      if (c.agentUuid === suspendedAgentUuid && c.status === 'active') {
        await setCredentialStatus(repo, c.jti, 'suspended');
      }
    }
  }

  return { applied: true, suspendedAgentUuid };
}

export function decodeRegisteredLog(log: Log): RegisteredPayload | null {
  try {
    const topics = log.topics;
    if (!topics[1] || !topics[2]) return null;
    const agentId = BigInt(topics[1]).toString();
    const owner = getAddress(`0x${topics[2].slice(-40)}`) as `0x${string}`;
    const agentURI =
      (log as Log & { args?: { agentURI?: string } }).args?.agentURI ?? '';
    return {
      agentId,
      agentURI,
      owner,
      txHash: log.transactionHash!,
      logIndex: log.logIndex ?? 0,
      blockNumber: log.blockNumber ?? 0n,
    };
  } catch {
    return null;
  }
}

function pendingKey(ev: PendingEvent): string {
  return eventId(ev.chainId, ev.payload.txHash, ev.payload.logIndex);
}

/**
 * Start Registered/Transfer watchers via viem.
 * HTTP/public RPCs can use stateless eth_getLogs polling to avoid provider-side
 * filters that are lost behind load balancers (`filter not found`).
 * Pending queue + timer flush when confirmations > 1 so deferred logs are not dropped.
 */
export async function startEventWatcher(
  client: WatchClient,
  repo: Repository,
  opts: {
    chainId: number;
    registry: `0x${string}`;
    confirmations?: number;
    publicBaseUrl?: string;
    onLogError?: (err: unknown) => void;
    /** Flush interval for pending confirmations (ms). */
    flushIntervalMs?: number;
    /** Use block-range eth_getLogs polling instead of stateful RPC filters. */
    statelessPolling?: boolean;
    /** Poll interval for stateless event reads (ms). */
    pollingIntervalMs?: number;
  },
): Promise<{
  stop: () => void;
  flush: () => Promise<void>;
  poll: () => Promise<void>;
  pendingCount: () => number;
}> {
  const registry = getAddress(opts.registry);
  const confirmations = opts.confirmations ?? 1;
  const onLogError =
    opts.onLogError ??
    ((err: unknown) => {
      console.error('KYA event watcher error', err);
    });

  const pending = new Map<string, PendingEvent>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let pollingTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let polling = false;

  const flush = async (): Promise<void> => {
    if (stopped) return;
    const currentBlock = await client.getBlockNumber();
    for (const [key, ev] of [...pending.entries()]) {
      if (!hasEnoughConfirmations(ev.payload.blockNumber, currentBlock, confirmations)) {
        continue;
      }
      pending.delete(key);
      try {
        if (ev.kind === 'Registered') {
          await applyRegisteredEvent(repo, ev.chainId, ev.payload, {
            confirmations,
            currentBlock,
            registryAddress: ev.registryAddress,
            publicBaseUrl: ev.publicBaseUrl,
          });
        } else {
          await applyTransferEvent(repo, ev.chainId, ev.payload, {
            confirmations,
            currentBlock,
            registryAddress: ev.registryAddress,
          });
        }
      } catch (err) {
        // Re-queue on transient failure so we don't drop permanently.
        pending.set(key, ev);
        onLogError(err);
      }
    }
  };

  const enqueueOrApply = async (ev: PendingEvent): Promise<void> => {
    const currentBlock = await client.getBlockNumber();
    if (!hasEnoughConfirmations(ev.payload.blockNumber, currentBlock, confirmations)) {
      pending.set(pendingKey(ev), ev);
      console.info(
        `${ev.kind} log queued pending confirmations`,
        ev.payload.txHash,
        ev.payload.logIndex,
      );
      return;
    }
    if (ev.kind === 'Registered') {
      await applyRegisteredEvent(repo, ev.chainId, ev.payload, {
        confirmations,
        currentBlock,
        registryAddress: ev.registryAddress,
        publicBaseUrl: ev.publicBaseUrl,
      });
    } else {
      await applyTransferEvent(repo, ev.chainId, ev.payload, {
        confirmations,
        currentBlock,
        registryAddress: ev.registryAddress,
      });
    }
    // Also flush older pending on every successful callback.
    await flush();
  };

  type RegisteredLog = {
    args?: { agentId?: bigint; agentURI?: string; owner?: `0x${string}` };
    transactionHash?: `0x${string}`;
    logIndex?: number;
    blockNumber?: bigint;
  };
  type TransferLog = {
    args?: { from?: `0x${string}`; to?: `0x${string}`; tokenId?: bigint };
    transactionHash?: `0x${string}`;
    logIndex?: number;
    blockNumber?: bigint;
  };

  const handleRegisteredLogs = async (logs: RegisteredLog[]): Promise<void> => {
    for (const log of logs) {
      const args = log.args ?? {};
      if (args.agentId == null || !args.agentURI || !args.owner || !log.transactionHash) {
        continue;
      }
      await enqueueOrApply({
        kind: 'Registered',
        chainId: opts.chainId,
        registryAddress: registry,
        publicBaseUrl: opts.publicBaseUrl,
        payload: {
          agentId: args.agentId.toString(),
          agentURI: args.agentURI,
          owner: getAddress(args.owner),
          txHash: log.transactionHash,
          logIndex: log.logIndex ?? 0,
          blockNumber: log.blockNumber ?? 0n,
        },
      });
    }
  };

  const handleTransferLogs = async (logs: TransferLog[]): Promise<void> => {
    for (const log of logs) {
      const args = log.args ?? {};
      if (!args.from || !args.to || args.tokenId == null || !log.transactionHash) {
        continue;
      }
      await enqueueOrApply({
        kind: 'Transfer',
        chainId: opts.chainId,
        registryAddress: registry,
        payload: {
          from: getAddress(args.from),
          to: getAddress(args.to),
          tokenId: args.tokenId.toString(),
          txHash: log.transactionHash,
          logIndex: log.logIndex ?? 0,
          blockNumber: log.blockNumber ?? 0n,
        },
      });
    }
  };

  let unwatchRegistered: () => void = () => undefined;
  let unwatchTransfer: () => void = () => undefined;
  let poll = async (): Promise<void> => undefined;

  if (opts.statelessPolling) {
    if (!client.getContractEvents) {
      throw new Error('Stateless event polling requires getContractEvents');
    }
    let lastPolledBlock = await client.getBlockNumber();
    poll = async (): Promise<void> => {
      if (stopped || polling) return;
      polling = true;
      try {
        const currentBlock = await client.getBlockNumber();
        if (currentBlock <= lastPolledBlock) return;
        const logs = await client.getContractEvents!({
          address: registry,
          abi: IDENTITY_REGISTRY_ABI as Abi,
          fromBlock: lastPolledBlock + 1n,
          toBlock: currentBlock,
          strict: true,
        });
        for (const log of logs) {
          if (log.eventName === 'Registered') {
            await handleRegisteredLogs([log as RegisteredLog]);
          } else if (log.eventName === 'Transfer') {
            await handleTransferLogs([log as TransferLog]);
          }
        }
        lastPolledBlock = currentBlock;
      } finally {
        polling = false;
      }
    };
    pollingTimer = setInterval(() => {
      void poll().catch(onLogError);
    }, opts.pollingIntervalMs ?? 4_000);
    if (typeof pollingTimer === 'object' && 'unref' in pollingTimer) {
      pollingTimer.unref();
    }
  } else {
    if (!client.watchContractEvent) {
      throw new Error('Event subscriptions require watchContractEvent');
    }
    unwatchRegistered = client.watchContractEvent({
      address: registry,
      abi: IDENTITY_REGISTRY_ABI as Abi,
      eventName: 'Registered',
      onLogs: async (logs: RegisteredLog[]) => {
        try {
          await handleRegisteredLogs(logs);
        } catch (err) {
          onLogError(err);
        }
      },
      onError: onLogError,
    });

    unwatchTransfer = client.watchContractEvent({
      address: registry,
      abi: IDENTITY_REGISTRY_ABI as Abi,
      eventName: 'Transfer',
      onLogs: async (logs: TransferLog[]) => {
        try {
          await handleTransferLogs(logs);
        } catch (err) {
          onLogError(err);
        }
      },
      onError: onLogError,
    });
  }

  const intervalMs = opts.flushIntervalMs ?? 12_000;
  timer = setInterval(() => {
    void flush().catch(onLogError);
  }, intervalMs);
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref();
  }

  return {
    flush,
    poll,
    pendingCount: () => pending.size,
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      if (pollingTimer) clearInterval(pollingTimer);
      timer = undefined;
      pollingTimer = undefined;
      pending.clear();
      unwatchRegistered();
      unwatchTransfer();
    },
  };
}

export const registeredEvent = parseAbiItem(
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
);
export const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
);
