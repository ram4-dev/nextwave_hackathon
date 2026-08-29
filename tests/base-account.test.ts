import { describe, expect, it } from 'vitest';
import { parseSiweMessage } from 'viem/siwe';
import { siwbConnectWithProvider } from '../web/src/baseAccount.js';

const address = '0x1111111111111111111111111111111111111111' as const;
const opts = {
  nonce: '0123456789abcdef0123456789abcdef',
  chainId: 84532,
  domain: 'example.ngrok-free.dev',
  uri: 'https://example.ngrok-free.dev/app/',
  issuedAt: '2026-08-29T19:00:00.000Z',
  expirationTime: '2026-08-29T19:05:00.000Z',
};

describe('Base Account SIWB', () => {
  it('keeps a valid wallet_connect SIWE capability without another signature', async () => {
    const message = `${opts.domain} wants you to sign in with your Ethereum account:
${address}

Sign in with Base to KYA.

URI: ${opts.uri}
Version: 1
Chain ID: ${opts.chainId}
Nonce: ${opts.nonce}
Issued At: ${opts.issuedAt}
Expiration Time: ${opts.expirationTime}`;
    const requests: Array<{ method: string; params?: unknown }> = [];
    const provider = {
      request: async (request: { method: string; params?: readonly unknown[] | Record<string, unknown> }) => {
        requests.push(request);
        return {
          accounts: [{
            address,
            capabilities: {
              signInWithEthereum: { message, signature: '0xwallet' },
            },
          }],
        };
      },
    };

    const result = await siwbConnectWithProvider(provider, opts);

    expect(result).toEqual({ address, message, signature: '0xwallet' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('wallet_connect');
    expect(requests[0]?.params).toMatchObject([{
      capabilities: {
        signInWithEthereum: {
          nonce: opts.nonce,
          chainId: '0x14a34',
        },
      },
    }]);
  });

  it('falls back to a canonical EIP-4361 message when the wallet omits the nonce', async () => {
    const requests: Array<{ method: string; params?: unknown }> = [];
    const provider = {
      request: async (request: { method: string; params?: readonly unknown[] | Record<string, unknown> }) => {
        requests.push(request);
        if (request.method === 'wallet_connect') {
          return {
            accounts: [{
              address,
              capabilities: {
                signInWithEthereum: {
                  message: `${opts.domain} wants you to sign in with your Ethereum account:\n${address}`,
                  signature: '0xmalformed',
                },
              },
            }],
          };
        }
        return '0xfallback';
      },
    };

    const result = await siwbConnectWithProvider(provider, opts);
    const parsed = parseSiweMessage(result.message);

    expect(result.signature).toBe('0xfallback');
    expect(parsed.nonce).toBe(opts.nonce);
    expect(parsed.chainId).toBe(opts.chainId);
    expect(parsed.domain).toBe(opts.domain);
    expect(parsed.uri).toBe(opts.uri);
    expect(requests.map((request) => request.method)).toEqual([
      'wallet_connect',
      'personal_sign',
    ]);
  });
});
