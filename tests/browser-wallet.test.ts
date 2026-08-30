import { describe, expect, it } from 'vitest';
import { parseSiweMessage } from 'viem/siwe';
import type { EIP1193Provider, Hex } from 'viem';
import { encodeRegisterAgentUri, IDENTITY_REGISTRY_SEPOLIA } from '../src/registry/identity.js';
import {
  BASE_SEPOLIA_CHAIN_HEX,
  BrowserWalletConnector,
  formatBrowserWalletError,
  validateRegisterIntent,
  type RegisterIntent,
} from '../web/src/browserWalletConnector.js';

const address = '0x1111111111111111111111111111111111111111' as const;
const otherAddress = '0x2222222222222222222222222222222222222222' as const;
const transactionHash = (`0x${'ab'.repeat(32)}`) as Hex;

type RequestRecord = { method: string; params?: unknown };

function createFakeProvider(opts?: {
  chainId?: string;
  unknownChainOnce?: boolean;
  authorized?: boolean;
}) {
  let chainId = opts?.chainId ?? BASE_SEPOLIA_CHAIN_HEX;
  let unknownChainOnce = opts?.unknownChainOnce ?? false;
  let authorized = opts?.authorized ?? false;
  let accounts: string[] = [address];
  const calls: RequestRecord[] = [];
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  const request = async (args: RequestRecord): Promise<unknown> => {
    calls.push(args);
    switch (args.method) {
      case 'eth_requestAccounts':
        authorized = true;
        return accounts;
      case 'eth_accounts':
        return authorized ? accounts : [];
      case 'eth_chainId':
        return chainId;
      case 'wallet_switchEthereumChain': {
        if (unknownChainOnce) {
          unknownChainOnce = false;
          throw Object.assign(new Error('unknown chain'), { code: 4902 });
        }
        chainId = (args.params as Array<{ chainId: string }>)[0]!.chainId;
        return null;
      }
      case 'wallet_addEthereumChain':
        chainId = (args.params as Array<{ chainId: string }>)[0]!.chainId;
        return null;
      case 'personal_sign':
        return '0xsigned';
      case 'eth_call':
        return `0x${'0'.repeat(63)}1`;
      case 'eth_sendTransaction':
        return transactionHash;
      default:
        throw new Error(`Unexpected provider method ${args.method}`);
    }
  };

  const provider = {
    request,
    on(event: string, listener: (...args: unknown[]) => void) {
      const current = listeners.get(event) ?? new Set();
      current.add(listener);
      listeners.set(event, current);
      return this;
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(listener);
      return this;
    },
  } as unknown as EIP1193Provider;

  return {
    provider,
    calls,
    emit(event: string, value?: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(value);
    },
    setAccounts(next: string[]) {
      accounts = next;
    },
  };
}

function announce(
  target: EventTarget,
  detail: { info: { uuid: string; name: string; rdns: string }; provider: EIP1193Provider },
) {
  const event = new Event('eip6963:announceProvider');
  Object.defineProperty(event, 'detail', { value: detail });
  target.dispatchEvent(event);
}

function liveIntent(overrides?: Partial<RegisterIntent['register']>): RegisterIntent {
  const agentURI = 'https://kya.example/v1/agents/agent-1/agent-uri.json';
  return {
    mode: 'live',
    agentURI,
    chainId: 84532,
    register: {
      from: address,
      to: IDENTITY_REGISTRY_SEPOLIA,
      data: encodeRegisterAgentUri(agentURI),
      value: '0x0',
      ...overrides,
    },
    callHash: (`0x${'cd'.repeat(32)}`) as Hex,
  };
}

describe('BrowserWalletConnector', () => {
  it('renders structured provider failures instead of [object Object]', () => {
    expect(
      formatBrowserWalletError({
        error: { message: 'The wallet could not switch networks.' },
      }),
    ).toBe('The wallet could not switch networks.');
    expect(
      formatBrowserWalletError({ message: { data: { message: 'Nested wallet error' } } }),
    ).toBe('Nested wallet error');
    expect(
      formatBrowserWalletError({ code: -32002, message: 'Request already pending' }),
    ).toMatch(/open the wallet/i);
    expect(
      formatBrowserWalletError({
        message: "Request of type 'wallet_requestPermissions' already pending for origin",
      }),
    ).toMatch(/open the wallet/i);
  });

  it('discovers and deduplicates EIP-6963 providers without requesting accounts', async () => {
    const target = new EventTarget();
    const fake = createFakeProvider();
    const detail = {
      info: { uuid: 'wallet-1', name: 'Test Wallet', rdns: 'test.wallet' },
      provider: fake.provider,
    };
    target.addEventListener('eip6963:requestProvider', () => {
      announce(target, detail);
      announce(target, detail);
    });

    const connector = new BrowserWalletConnector({ target });
    const wallets = await connector.discover(0);

    expect(wallets).toEqual([
      { id: 'wallet-1', name: 'Test Wallet', rdns: 'test.wallet', legacy: false },
    ]);
    expect(fake.calls).toHaveLength(0);
  });

  it('uses a single legacy provider only when EIP-6963 announces none', async () => {
    const fake = createFakeProvider();
    const connector = new BrowserWalletConnector({
      target: new EventTarget(),
      legacyProvider: fake.provider,
    });

    await expect(connector.discover(0)).resolves.toEqual([
      { id: 'legacy-window-ethereum', name: 'Browser wallet', legacy: true },
    ]);
  });

  it('requests accounts, adds Base Sepolia on 4902, and re-reads account and chain', async () => {
    const fake = createFakeProvider({ chainId: '0x1', unknownChainOnce: true });
    const connector = new BrowserWalletConnector({ legacyProvider: fake.provider });
    const [wallet] = await connector.discover(0);

    await connector.connect(wallet!.id);
    await connector.ensureBaseSepolia();

    expect(connector.getState()).toEqual({
      status: 'connected',
      walletId: wallet!.id,
      address,
      chainId: 84532,
    });
    expect(fake.calls.map((call) => call.method)).toEqual([
      'eth_accounts',
      'eth_requestAccounts',
      'eth_chainId',
      'eth_chainId',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'eth_chainId',
      'eth_accounts',
    ]);
  });

  it('reuses an already authorized account without opening another permission request', async () => {
    const fake = createFakeProvider({ authorized: true });
    const connector = new BrowserWalletConnector({ legacyProvider: fake.provider });
    const [wallet] = await connector.discover(0);

    await connector.connect(wallet!.id);

    expect(fake.calls.map((call) => call.method)).toEqual(['eth_accounts', 'eth_chainId']);
  });

  it('creates the canonical Base Sepolia SIWE message and signs through the selected provider', async () => {
    const fake = createFakeProvider();
    const connector = new BrowserWalletConnector({ legacyProvider: fake.provider });
    const [wallet] = await connector.discover(0);
    await connector.connect(wallet!.id);
    await connector.ensureBaseSepolia();

    const signed = await connector.signSiwe({
      nonce: '0123456789abcdef0123456789abcdef',
      domain: 'kya.example',
      uri: 'https://kya.example/app/',
      issuedAt: '2026-08-29T19:00:00.000Z',
      expirationTime: '2026-08-29T19:05:00.000Z',
    });
    const parsed = parseSiweMessage(signed.message);

    expect(signed.address).toBe(address);
    expect(signed.signature).toBe('0xsigned');
    expect(parsed.address).toBe(address);
    expect(parsed.chainId).toBe(84532);
    expect(parsed.nonce).toBe('0123456789abcdef0123456789abcdef');
    expect(parsed.statement).toBe('Sign in to KYA with your browser wallet.');
    expect(fake.calls.at(-1)?.method).toBe('personal_sign');
  });

  it('invalidates the connector when the selected account changes', async () => {
    const fake = createFakeProvider();
    const connector = new BrowserWalletConnector({ legacyProvider: fake.provider });
    const [wallet] = await connector.discover(0);
    await connector.connect(wallet!.id);
    const events: string[] = [];
    connector.subscribe((event) => events.push(event.type));

    fake.emit('accountsChanged', [address]);
    expect(connector.getState()).toMatchObject({ status: 'connected', address });

    fake.setAccounts([otherAddress]);
    fake.emit('accountsChanged', [otherAddress]);

    expect(connector.getState()).toEqual({ status: 'invalidated', reason: 'account' });
    expect(events).toEqual(['accountsChanged']);
  });

  it('simulates the exact register call immediately before the wallet write', async () => {
    const fake = createFakeProvider();
    const connector = new BrowserWalletConnector({ legacyProvider: fake.provider });
    const [wallet] = await connector.discover(0);
    await connector.connect(wallet!.id);
    await connector.ensureBaseSepolia();

    await expect(
      connector.sendRegister(liveIntent(), IDENTITY_REGISTRY_SEPOLIA),
    ).resolves.toBe(transactionHash);

    const chainMethods = fake.calls
      .map((call) => call.method)
      .filter((method) => method === 'eth_call' || method === 'eth_sendTransaction');
    expect(chainMethods).toEqual(['eth_call', 'eth_sendTransaction']);
  });
});

describe('registration intent validation', () => {
  it('rejects sender, target, value, chain, and calldata tampering before wallet submission', () => {
    expect(() => validateRegisterIntent(liveIntent(), address, IDENTITY_REGISTRY_SEPOLIA)).not.toThrow();
    expect(() =>
      validateRegisterIntent(liveIntent({ from: otherAddress }), address, IDENTITY_REGISTRY_SEPOLIA),
    ).toThrow(/owner/i);
    expect(() =>
      validateRegisterIntent(liveIntent({ to: otherAddress }), address, IDENTITY_REGISTRY_SEPOLIA),
    ).toThrow(/registry/i);
    expect(() =>
      validateRegisterIntent(liveIntent({ value: '0x1' }), address, IDENTITY_REGISTRY_SEPOLIA),
    ).toThrow(/zero ETH/i);
    expect(() =>
      validateRegisterIntent(liveIntent({ data: '0xdeadbeef' }), address, IDENTITY_REGISTRY_SEPOLIA),
    ).toThrow(/calldata/i);
    expect(() =>
      validateRegisterIntent({ ...liveIntent(), chainId: 8453 }, address, IDENTITY_REGISTRY_SEPOLIA),
    ).toThrow(/Base Sepolia/i);
  });
});
