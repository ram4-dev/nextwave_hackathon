import {
  createClient,
  custom,
  encodeFunctionData,
  getAddress,
  type Abi,
  type EIP1193Provider,
  type Hex,
} from 'viem';
import {
  signMessage,
  simulateContract,
  waitForTransactionReceipt,
  writeContract,
} from 'viem/actions';
import { baseSepolia } from 'viem/chains';
import { createSiweMessage } from 'viem/siwe';
import identityRegistryAbi from '../../abis/IdentityRegistry.json' with { type: 'json' };
import { formatUnknownError } from './errorMessage.js';

export const BASE_SEPOLIA_CHAIN_ID = 84532 as const;
export const BASE_SEPOLIA_CHAIN_HEX = '0x14a34' as const;

const IDENTITY_REGISTRY_ABI = identityRegistryAbi as Abi;
const LEGACY_WALLET_ID = 'legacy-window-ethereum';

export type BrowserWalletState =
  | { status: 'idle' }
  | { status: 'discovering' }
  | { status: 'selecting'; wallets: WalletOption[] }
  | {
      status: 'connected';
      walletId: string;
      address: `0x${string}`;
      chainId: number;
    }
  | { status: 'invalidated'; reason: 'account' | 'chain' | 'disconnect' };

export interface WalletOption {
  id: string;
  name: string;
  rdns?: string;
  legacy: boolean;
}

export interface RegisterIntent {
  mode: 'live';
  agentURI: string;
  chainId: number;
  register: {
    from: `0x${string}`;
    to: `0x${string}`;
    data: Hex;
    value: Hex;
  };
  callHash: Hex;
}

export interface SiweSignOptions {
  nonce: string;
  domain: string;
  uri: string;
  issuedAt?: string;
  expirationTime?: string;
}

export type WalletLifecycleEvent =
  | { type: 'accountsChanged'; accounts: `0x${string}`[] }
  | { type: 'chainChanged'; chainId: number }
  | { type: 'disconnect' };

type DiscoveryTarget = {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  dispatchEvent(event: Event): boolean;
};

type ProviderEntry = {
  option: WalletOption;
  provider: EIP1193Provider;
};

type ProviderError = Error & {
  code?: number | string;
  cause?: unknown;
  data?: unknown;
};

export class BrowserWalletError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly transactionHash?: Hex,
  ) {
    super(message);
    this.name = 'BrowserWalletError';
  }
}

function providerErrorCode(error: unknown, seen = new Set<object>()): number | undefined {
  if (!error || typeof error !== 'object' || seen.has(error)) return undefined;
  seen.add(error);
  const direct = (error as ProviderError).code;
  if (typeof direct === 'number') return direct;
  if (typeof direct === 'string' && /^-?\d+$/.test(direct)) return Number(direct);
  const fromCause = providerErrorCode((error as ProviderError).cause, seen);
  if (fromCause !== undefined) return fromCause;
  return providerErrorCode((error as ProviderError).data, seen);
}

export function formatBrowserWalletError(error: unknown): string {
  if (error instanceof BrowserWalletError) return error.message;
  const code = providerErrorCode(error);
  if (code === -32002) {
    return 'A wallet request is already pending. Open the wallet and approve or reject it before trying again.';
  }
  if (code === 4001) return 'Wallet request rejected. Approve it in the wallet to continue.';
  if (code === 4100) return 'Wallet account access is not authorized. Reconnect the wallet.';
  if (code === 4900) return 'The browser wallet is disconnected. Reconnect it to continue.';
  if (code === 4901) return 'The wallet is disconnected from Base Sepolia. Switch networks.';
  const message = formatUnknownError(
    error,
    'Unexpected browser wallet error. Check the wallet and try again.',
  );
  if (/request.*already pending|already pending.*request/i.test(message)) {
    return 'A wallet request is already pending. Open the wallet and approve or reject it before trying again.';
  }
  return message;
}

function parseChainId(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new BrowserWalletError('Wallet returned an invalid chain ID.', 'INVALID_CHAIN_ID');
  }
  const chainId = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new BrowserWalletError('Wallet returned an invalid chain ID.', 'INVALID_CHAIN_ID');
  }
  return chainId;
}

function asProvider(value: unknown): EIP1193Provider | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as {
    request?: unknown;
    on?: unknown;
    removeListener?: unknown;
  };
  return typeof candidate.request === 'function' &&
    typeof candidate.on === 'function' &&
    typeof candidate.removeListener === 'function'
    ? (value as EIP1193Provider)
    : undefined;
}

function normalizeAccounts(value: unknown): `0x${string}`[] {
  if (!Array.isArray(value)) {
    throw new BrowserWalletError('Wallet returned an invalid accounts response.', 'ACCOUNTS');
  }
  return value.map((account) => {
    if (typeof account !== 'string') {
      throw new BrowserWalletError('Wallet returned an invalid account.', 'ACCOUNTS');
    }
    try {
      return getAddress(account);
    } catch {
      throw new BrowserWalletError('Wallet returned an invalid account.', 'ACCOUNTS');
    }
  });
}

function getDefaultTarget(): DiscoveryTarget | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as DiscoveryTarget);
}

function getDefaultLegacyProvider(): EIP1193Provider | undefined {
  if (typeof window === 'undefined') return undefined;
  return asProvider((window as unknown as { ethereum?: unknown }).ethereum);
}

export function validateRegisterIntent(
  intent: RegisterIntent,
  connectedAddress: `0x${string}`,
  expectedRegistry: `0x${string}`,
): {
  from: `0x${string}`;
  to: `0x${string}`;
  data: Hex;
} {
  if (intent.mode !== 'live') {
    throw new BrowserWalletError('Expected a live registration intent.', 'REGISTER_MODE');
  }
  if (intent.chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new BrowserWalletError('Registration intent is not for Base Sepolia.', 'REGISTER_CHAIN');
  }

  let from: `0x${string}`;
  let to: `0x${string}`;
  let registry: `0x${string}`;
  try {
    from = getAddress(intent.register.from);
    to = getAddress(intent.register.to);
    registry = getAddress(expectedRegistry);
  } catch {
    throw new BrowserWalletError('Registration intent contains an invalid address.', 'REGISTER_ADDRESS');
  }

  if (from.toLowerCase() !== connectedAddress.toLowerCase()) {
    throw new BrowserWalletError(
      'Connected wallet does not match the KYC-authenticated registration owner.',
      'REGISTER_OWNER',
    );
  }
  if (to.toLowerCase() !== registry.toLowerCase()) {
    throw new BrowserWalletError('Registration target is not the curated registry.', 'REGISTER_TARGET');
  }
  if (intent.register.value !== '0x0') {
    throw new BrowserWalletError('Registration transaction must have zero ETH value.', 'REGISTER_VALUE');
  }

  const expectedData = encodeFunctionData({
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'register',
    args: [intent.agentURI],
  });
  if (expectedData.toLowerCase() !== intent.register.data.toLowerCase()) {
    throw new BrowserWalletError(
      'Registration calldata does not match register(agentURI).',
      'REGISTER_CALLDATA',
    );
  }
  return { from, to, data: expectedData };
}

export class BrowserWalletConnector {
  private readonly providers = new Map<string, ProviderEntry>();
  private readonly subscribers = new Set<(event: WalletLifecycleEvent) => void>();
  private readonly target?: DiscoveryTarget;
  private readonly legacyProvider?: EIP1193Provider;
  private selected?: ProviderEntry;
  private state: BrowserWalletState = { status: 'idle' };
  private pendingConnection?: {
    walletId: string;
    promise: Promise<{ address: `0x${string}`; chainId: number }>;
  };

  private readonly handleAccountsChanged = (accounts: unknown) => {
    let normalized: `0x${string}`[] = [];
    try {
      normalized = normalizeAccounts(accounts);
    } catch {
      this.invalidate('account');
      return;
    }
    const currentAddress = this.state.status === 'connected' ? this.state.address : undefined;
    const changed =
      normalized.length === 0 ||
      !currentAddress ||
      normalized[0]!.toLowerCase() !== currentAddress.toLowerCase();
    if (changed) {
      this.invalidate('account');
      this.emit({ type: 'accountsChanged', accounts: normalized });
    }
  };

  private readonly handleChainChanged = (chainIdValue: unknown) => {
    let chainId: number;
    try {
      chainId = parseChainId(chainIdValue);
    } catch {
      this.invalidate('chain');
      return;
    }
    if (chainId !== BASE_SEPOLIA_CHAIN_ID) this.invalidate('chain');
    this.emit({ type: 'chainChanged', chainId });
  };

  private readonly handleDisconnect = () => {
    this.invalidate('disconnect');
    this.emit({ type: 'disconnect' });
  };

  constructor(opts?: {
    target?: DiscoveryTarget;
    legacyProvider?: EIP1193Provider;
  }) {
    this.target = opts?.target ?? getDefaultTarget();
    this.legacyProvider = opts?.legacyProvider ?? getDefaultLegacyProvider();
  }

  getState(): BrowserWalletState {
    return structuredClone(this.state);
  }

  async discover(timeoutMs = 100): Promise<WalletOption[]> {
    this.detachProviderListeners();
    this.selected = undefined;
    this.providers.clear();
    this.state = { status: 'discovering' };

    const announce = ((event: Event) => {
      const detail = (event as Event & { detail?: unknown }).detail;
      if (!detail || typeof detail !== 'object') return;
      const info = (detail as { info?: unknown }).info;
      const provider = asProvider((detail as { provider?: unknown }).provider);
      if (!info || typeof info !== 'object' || !provider) return;
      const uuid = (info as { uuid?: unknown }).uuid;
      const name = (info as { name?: unknown }).name;
      const rdns = (info as { rdns?: unknown }).rdns;
      if (typeof uuid !== 'string' || !uuid || typeof name !== 'string' || !name) return;
      if (this.providers.has(uuid)) return;
      this.providers.set(uuid, {
        option: {
          id: uuid,
          name,
          rdns: typeof rdns === 'string' ? rdns : undefined,
          legacy: false,
        },
        provider,
      });
    }) as EventListener;

    if (this.target) {
      this.target.addEventListener('eip6963:announceProvider', announce);
      this.target.dispatchEvent(new Event('eip6963:requestProvider'));
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, timeoutMs)));
      this.target.removeEventListener('eip6963:announceProvider', announce);
    }

    if (this.providers.size === 0 && this.legacyProvider) {
      this.providers.set(LEGACY_WALLET_ID, {
        option: {
          id: LEGACY_WALLET_ID,
          name: 'Browser wallet',
          legacy: true,
        },
        provider: this.legacyProvider,
      });
    }

    const wallets = [...this.providers.values()].map(({ option }) => option);
    this.state = wallets.length > 0 ? { status: 'selecting', wallets } : { status: 'idle' };
    return wallets;
  }

  async connect(walletId: string): Promise<{ address: `0x${string}`; chainId: number }> {
    if (this.pendingConnection) {
      if (this.pendingConnection.walletId === walletId) return this.pendingConnection.promise;
      throw new BrowserWalletError(
        'Finish the pending wallet connection before selecting another wallet.',
        'WALLET_REQUEST_PENDING',
      );
    }
    const selected = this.providers.get(walletId);
    if (!selected) {
      throw new BrowserWalletError('Select an available browser wallet first.', 'WALLET_SELECTION');
    }
    const promise = this.connectSelected(walletId, selected);
    this.pendingConnection = { walletId, promise };
    try {
      return await promise;
    } finally {
      if (this.pendingConnection?.promise === promise) this.pendingConnection = undefined;
    }
  }

  private async connectSelected(
    walletId: string,
    selected: ProviderEntry,
  ): Promise<{ address: `0x${string}`; chainId: number }> {
    this.detachProviderListeners();
    this.selected = selected;

    let accounts = normalizeAccounts(await selected.provider.request({ method: 'eth_accounts' }));
    if (accounts.length === 0) {
      accounts = normalizeAccounts(
        await selected.provider.request({ method: 'eth_requestAccounts' }),
      );
    }
    if (!accounts[0]) {
      throw new BrowserWalletError('The wallet did not expose an account.', 'ACCOUNTS');
    }
    const chainId = parseChainId(await selected.provider.request({ method: 'eth_chainId' }));
    this.state = { status: 'connected', walletId, address: accounts[0], chainId };
    this.attachProviderListeners();
    return { address: accounts[0], chainId };
  }

  async ensureBaseSepolia(): Promise<void> {
    const provider = this.requireProvider();
    const before = parseChainId(await provider.request({ method: 'eth_chainId' }));
    if (before !== BASE_SEPOLIA_CHAIN_ID) {
      try {
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: BASE_SEPOLIA_CHAIN_HEX }],
        });
      } catch (error) {
        if (providerErrorCode(error) !== 4902) throw error;
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: BASE_SEPOLIA_CHAIN_HEX,
              chainName: 'Base Sepolia',
              nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
              rpcUrls: ['https://sepolia.base.org'],
              blockExplorerUrls: ['https://sepolia.basescan.org'],
            },
          ],
        });
      }
    }

    let chainId = parseChainId(await provider.request({ method: 'eth_chainId' }));
    if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: BASE_SEPOLIA_CHAIN_HEX }],
      });
      chainId = parseChainId(await provider.request({ method: 'eth_chainId' }));
    }
    if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
      this.invalidate('chain');
      throw new BrowserWalletError('Wallet did not switch to Base Sepolia.', 'WRONG_CHAIN');
    }

    const accounts = normalizeAccounts(await provider.request({ method: 'eth_accounts' }));
    const previousAddress = this.state.status === 'connected' ? this.state.address : undefined;
    if (!previousAddress || !accounts[0] || accounts[0].toLowerCase() !== previousAddress.toLowerCase()) {
      this.invalidate('account');
      throw new BrowserWalletError('Wallet account changed while switching networks.', 'ACCOUNT_CHANGED');
    }
    this.state = {
      status: 'connected',
      walletId: this.selected!.option.id,
      address: previousAddress,
      chainId,
    };
  }

  async signSiwe(opts: SiweSignOptions): Promise<{
    address: `0x${string}`;
    message: string;
    signature: Hex;
  }> {
    const connected = this.requireConnected();
    if (connected.chainId !== BASE_SEPOLIA_CHAIN_ID) {
      throw new BrowserWalletError('Switch the wallet to Base Sepolia before signing.', 'WRONG_CHAIN');
    }
    const message = createSiweMessage({
      address: connected.address,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      domain: opts.domain,
      uri: opts.uri,
      version: '1',
      nonce: opts.nonce,
      statement: 'Sign in to KYA with your browser wallet.',
      issuedAt: new Date(opts.issuedAt ?? Date.now()),
      expirationTime: new Date(opts.expirationTime ?? Date.now() + 5 * 60 * 1000),
    });
    const client = createClient({
      chain: baseSepolia,
      transport: custom(this.requireProvider()),
    });
    const signature = await signMessage(client, {
      account: connected.address,
      message,
    });
    return { address: connected.address, message, signature };
  }

  async sendRegister(
    intent: RegisterIntent,
    expectedRegistry: `0x${string}`,
  ): Promise<Hex> {
    const connected = this.requireConnected();
    if (connected.chainId !== BASE_SEPOLIA_CHAIN_ID) {
      throw new BrowserWalletError('Switch the wallet to Base Sepolia before registering.', 'WRONG_CHAIN');
    }
    const register = validateRegisterIntent(intent, connected.address, expectedRegistry);
    const provider = this.requireProvider();
    const client = createClient({
      chain: baseSepolia,
      transport: custom(provider),
    });
    const { request } = await simulateContract(client, {
      account: register.from,
      address: register.to,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'register',
      args: [intent.agentURI],
      value: 0n,
    });
    return writeContract(client, request);
  }

  async waitForReceipt(hash: Hex): Promise<{ blockNumber: bigint }> {
    const client = createClient({
      chain: baseSepolia,
      transport: custom(this.requireProvider()),
    });
    const receipt = await waitForTransactionReceipt(client, {
      hash,
      confirmations: 1,
      timeout: 120_000,
    });
    if (receipt.status !== 'success') {
      throw new BrowserWalletError(
        `Registration transaction reverted: ${hash}`,
        'TRANSACTION_REVERTED',
        hash,
      );
    }
    return { blockNumber: receipt.blockNumber };
  }

  subscribe(listener: (event: WalletLifecycleEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  disconnect(): void {
    this.detachProviderListeners();
    this.selected = undefined;
    this.state = { status: 'idle' };
  }

  private requireProvider(): EIP1193Provider {
    if (!this.selected) {
      throw new BrowserWalletError('Connect a browser wallet first.', 'NOT_CONNECTED');
    }
    return this.selected.provider;
  }

  private requireConnected(): Extract<BrowserWalletState, { status: 'connected' }> {
    if (this.state.status !== 'connected') {
      throw new BrowserWalletError('Reconnect the browser wallet to continue.', 'NOT_CONNECTED');
    }
    return this.state;
  }

  private emit(event: WalletLifecycleEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }

  private invalidate(reason: 'account' | 'chain' | 'disconnect'): void {
    this.state = { status: 'invalidated', reason };
  }

  private attachProviderListeners(): void {
    const provider = this.selected?.provider;
    if (!provider) return;
    provider.on('accountsChanged', this.handleAccountsChanged);
    provider.on('chainChanged', this.handleChainChanged);
    provider.on('disconnect', this.handleDisconnect);
  }

  private detachProviderListeners(): void {
    const provider = this.selected?.provider;
    if (!provider) return;
    provider.removeListener('accountsChanged', this.handleAccountsChanged);
    provider.removeListener('chainChanged', this.handleChainChanged);
    provider.removeListener('disconnect', this.handleDisconnect);
  }
}
