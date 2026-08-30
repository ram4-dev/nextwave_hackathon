import { getAddress, isAddress } from 'viem';
import type { EndUserAccount } from '@coinbase/cdp-sdk';
import type { Principal } from '../domain/types.js';
import { newId, type Repository } from '../persistence/repository.js';
import type { UserOperationStatusProvider } from '../services/ceremony.js';

export interface CdpIdentity {
  userId: string;
  emailAuthenticated: boolean;
  smartAccountAddress?: `0x${string}`;
  ownerAddresses: `0x${string}`[];
}

export interface CdpIdentityVerifier {
  validate(accessToken: string): Promise<CdpIdentity>;
}

/** Small injectable slice of CDP SDK used by the production verifier. */
export type CdpEndUserClient = {
  endUser: {
    validateAccessToken: (input: { accessToken: string }) => Promise<CdpEndUserAccount>;
  };
};

export class CdpIdentityError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

/** Narrow structural contract matching CDP SDK 1.55 EndUser response fields. */
export type CdpEndUserAccount = Pick<
  EndUserAccount,
  'userId' | 'authenticationMethods' | 'evmSmartAccountObjects'
>;

export function normalizeCdpEndUser(endUser: CdpEndUserAccount): CdpIdentity {
  if (endUser.evmSmartAccountObjects.length !== 1) {
    throw new CdpIdentityError('CDP Smart Account is ambiguous', 'CDP_ACCOUNT');
  }
  const account = endUser.evmSmartAccountObjects[0]!;
  return {
    userId: endUser.userId,
    emailAuthenticated: endUser.authenticationMethods.some((method) => method.type === 'email'),
    smartAccountAddress: account.address as `0x${string}`,
    ownerAddresses: account.ownerAddresses as `0x${string}`[],
  };
}

type CdpUserOperationEvidence = {
  status?: string;
  transactionHash?: string;
  receipts?: Array<{ transactionHash?: string; revert?: unknown }>;
};

/**
 * CDP marks a successful UserOperation receipt by omitting `revert`.
 * Its transaction hash is provider evidence only; registry watcher evidence
 * still controls the enrollment binding and credential path.
 */
export function normalizeCdpUserOperation(operation: CdpUserOperationEvidence): {
  status: 'pending' | 'confirmed' | 'failed';
  transactionHash?: `0x${string}`;
  receiptSuccess?: boolean;
} {
  if (operation.status === 'failed' || operation.status === 'dropped') return { status: 'failed' };
  if (operation.status !== 'complete' || !operation.transactionHash) return { status: 'pending' };
  const receipt = operation.receipts?.find(
    (candidate) => candidate.transactionHash?.toLowerCase() === operation.transactionHash?.toLowerCase(),
  );
  if (!receipt || receipt.revert) return { status: 'pending' };
  return {
    status: 'confirmed',
    transactionHash: operation.transactionHash as `0x${string}`,
    receiptSuccess: true,
  };
}

function normalizedSmartAccount(identity: CdpIdentity): `0x${string}` {
  if (!identity.emailAuthenticated) throw new CdpIdentityError('CDP email authentication is required', 'CDP_EMAIL');
  if (!identity.userId || !identity.smartAccountAddress || !isAddress(identity.smartAccountAddress)) {
    throw new CdpIdentityError('CDP Smart Account is required', 'CDP_ACCOUNT');
  }
  if (identity.ownerAddresses.length !== 1 || !isAddress(identity.ownerAddresses[0]!)) {
    throw new CdpIdentityError('CDP Smart Account owner is ambiguous', 'CDP_ACCOUNT');
  }
  return getAddress(identity.smartAccountAddress);
}

/** Atomic principal mapping. The frontend never selects the bound wallet. */
export async function bindCdpIdentity(repo: Repository, identity: CdpIdentity): Promise<Principal> {
  const wallet = normalizedSmartAccount(identity);
  return repo.withLock(async (store) => {
    const byUser = store.principals.find((p) => p.cdpUserId === identity.userId);
    const byWallet = store.principals.find((p) => p.ownerAddress.toLowerCase() === wallet.toLowerCase());
    if (byUser && byUser.ownerAddress.toLowerCase() !== wallet.toLowerCase()) {
      throw new CdpIdentityError('CDP wallet binding conflict', 'CDP_BINDING');
    }
    if (byWallet && byWallet.cdpUserId && byWallet.cdpUserId !== identity.userId) {
      throw new CdpIdentityError('CDP wallet belongs to another principal', 'CDP_BINDING');
    }
    if (byUser) return byUser;
    if (byWallet) {
      throw new CdpIdentityError('Legacy wallet binding requires explicit reconciliation', 'CDP_RECONCILIATION_REQUIRED');
    }
    const principal: Principal = { id: newId('prin'), cdpUserId: identity.userId, ownerAddress: wallet, kycStatus: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    store.principals.push(principal);
    return principal;
  });
}

/** SDK adapter is lazy so tests and demo mode do not load provider code. */
export async function createCdpIdentityVerifier(clientOverride?: CdpEndUserClient): Promise<CdpIdentityVerifier> {
  const client: CdpEndUserClient = clientOverride ?? await (async () => {
    const { CdpClient } = await import('@coinbase/cdp-sdk');
    return new CdpClient();
  })();
  return {
    async validate(accessToken) {
      try {
        const endUser = await client.endUser.validateAccessToken({ accessToken });
        return normalizeCdpEndUser(endUser);
      } catch (error) {
        if (error instanceof CdpIdentityError) throw error;
        const status = typeof error === 'object' && error !== null
          ? (error as { status?: unknown; statusCode?: unknown }).status ??
            (error as { statusCode?: unknown }).statusCode
          : undefined;
        if (status === 401 || status === 403) {
          throw new CdpIdentityError('CDP access token is invalid', 'CDP_INVALID');
        }
        throw new CdpIdentityError('CDP identity validation unavailable', 'CDP_UNAVAILABLE');
      }
    },
  };
}

/** Converts authoritative CDP UserOperation state into the narrow ceremony contract. */
export async function createCdpUserOperationStatusProvider(): Promise<UserOperationStatusProvider> {
  const { CdpClient } = await import('@coinbase/cdp-sdk');
  const client = new CdpClient();
  return {
    async resolve(userOpHash, smartAccount) {
      try {
        const operation = await client.evm.getUserOperation({ smartAccount, userOpHash });
        return normalizeCdpUserOperation(operation);
      } catch {
        throw new CdpIdentityError('CDP UserOperation resolution unavailable', 'CDP_UNAVAILABLE');
      }
    },
  };
}
