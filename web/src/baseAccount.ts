/**
 * Browser-side Base Account helpers for live SIWB + wallet_sendCalls.
 * Demo mode does not call these; live mode requires wallet popups + COOP.
 *
 * RPC shapes follow installed @base-org/account declarations:
 * - wallet_connect SignInWithEthereumCapabilityRequest
 * - wallet_sendCalls WalletSendCallsParams (requires `from`)
 */
import { createBaseAccountSDK } from '@base-org/account';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';

type BaseAccountProvider = {
  request: (args: {
    method: string;
    params?: readonly unknown[] | Record<string, unknown>;
  }) => Promise<unknown>;
};

export function createKyaBaseAccount(opts?: {
  appName?: string;
  appLogoUrl?: string;
  chainIds?: number[];
}): { getProvider: () => BaseAccountProvider } {
  return createBaseAccountSDK({
    appName: opts?.appName ?? 'KYA',
    appLogoUrl: opts?.appLogoUrl,
    appChainIds: opts?.chainIds ?? [84532],
  });
}

function isSiweCapabilityResponse(
  value: unknown,
): value is { message: string; signature: `0x${string}` } {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  // Reject SerializedEthereumRpcError shapes (code + message, no signature).
  if ('code' in v && !('signature' in v)) return false;
  return typeof v.message === 'string' && typeof v.signature === 'string' && v.signature.startsWith('0x');
}

export type SiwbConnectOptions = {
  nonce: string;
  chainId: number;
  domain: string;
  uri: string;
  issuedAt?: string;
  expirationTime?: string;
};

function matchesSiweRequest(
  message: string,
  address: `0x${string}`,
  opts: SiwbConnectOptions,
): boolean {
  const parsed = parseSiweMessage(message);
  return (
    parsed.nonce === opts.nonce &&
    parsed.chainId === opts.chainId &&
    parsed.domain?.toLowerCase() === opts.domain.toLowerCase() &&
    parsed.uri === opts.uri &&
    parsed.address?.toLowerCase() === address.toLowerCase()
  );
}

function canonicalSiweMessage(
  address: `0x${string}`,
  opts: SiwbConnectOptions,
  issuedAt: string,
  expirationTime: string,
): string {
  return createSiweMessage({
    address,
    chainId: opts.chainId,
    domain: opts.domain,
    uri: opts.uri,
    version: '1',
    nonce: opts.nonce,
    statement: 'Sign in with Base to KYA.',
    issuedAt: new Date(issuedAt),
    expirationTime: new Date(expirationTime),
  });
}

export async function siwbConnectWithProvider(
  provider: BaseAccountProvider,
  opts: SiwbConnectOptions,
): Promise<{ address: `0x${string}`; message: string; signature: `0x${string}` }> {
  const chainHex = `0x${opts.chainId.toString(16)}`;
  const issuedAt = opts.issuedAt ?? new Date().toISOString();
  const expirationTime =
    opts.expirationTime ??
    new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const response = (await provider.request({
    method: 'wallet_connect',
    params: [
      {
        version: '1',
        capabilities: {
          signInWithEthereum: {
            nonce: opts.nonce,
            chainId: chainHex,
            domain: opts.domain,
            uri: opts.uri,
            issuedAt,
            expirationTime,
          },
        },
      },
    ],
  })) as {
    accounts?: Array<{
      address: `0x${string}`;
      capabilities?: {
        signInWithEthereum?: unknown;
      };
    }>;
  };

  const account = response.accounts?.[0];
  if (!account) throw new Error('No account from wallet_connect');
  const siwe = account.capabilities?.signInWithEthereum;
  if (!isSiweCapabilityResponse(siwe)) {
    throw new Error('Missing or invalid signInWithEthereum capability in wallet_connect response');
  }
  if (!matchesSiweRequest(siwe.message, account.address, opts)) {
    const message = canonicalSiweMessage(account.address, opts, issuedAt, expirationTime);
    const signature = await provider.request({
      method: 'personal_sign',
      params: [message, account.address],
    });
    if (typeof signature !== 'string' || !signature.startsWith('0x')) {
      throw new Error('Missing or invalid personal_sign fallback signature');
    }
    return {
      address: account.address,
      message,
      signature: signature as `0x${string}`,
    };
  }
  return {
    address: account.address,
    message: siwe.message,
    signature: siwe.signature,
  };
}

export async function siwbConnect(
  opts: SiwbConnectOptions,
): Promise<{ address: `0x${string}`; message: string; signature: `0x${string}` }> {
  const sdk = createKyaBaseAccount({ chainIds: [opts.chainId] });
  return siwbConnectWithProvider(sdk.getProvider(), opts);
}

export async function sendRegisterCalls(
  sendCallsParams: Record<string, unknown>,
): Promise<unknown> {
  if (typeof sendCallsParams.from !== 'string' || !sendCallsParams.from.startsWith('0x')) {
    throw new Error('wallet_sendCalls params require checksummed from (owner)');
  }
  const chainIdHex = String(sendCallsParams.chainId ?? '0x14a34');
  const chainId = Number.parseInt(chainIdHex, 16);
  const sdk = createKyaBaseAccount({ chainIds: [chainId || 84532] });
  const provider = sdk.getProvider();
  return provider.request({
    method: 'wallet_sendCalls',
    params: [sendCallsParams],
  });
}
