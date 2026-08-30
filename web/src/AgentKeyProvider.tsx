/**
 * AgentKeyProvider — holds the local agent CryptoKey handle in a ref so the UI
 * can sign challenges after binding without putting private material in React
 * state, server payloads, logs, or persistence.
 *
 * Browser WebCrypto limitations (honest):
 * - Prefer non-extractable keys (`extractable: false`). That models an
 *   OS-backed / hardware-ish boundary in the browser, but standard WebCrypto
 *   does NOT prove a hardware secure element or platform keystore.
 * - Production agents should integrate a native OS keystore behind this same
 *   interface (AgentKeyHandle) rather than relying on browser WebCrypto alone.
 */
import {
  createContext,
  useContext,
  useRef,
  type ReactNode,
  type MutableRefObject,
} from 'react';
import { assertPublicEcP256Jwk } from './agent/dpopClient.js';

export type KeystoreProviderKind = 'os_hardware' | 'encrypted_os_keystore';

export interface AgentKeyHandle {
  /** Non-extractable preferred; never serialize or put in React state. */
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: JsonWebKey;
  keystoreProvider: KeystoreProviderKind;
  /** True when private key was generated non-extractable. Not HW proof. */
  nonExtractable: boolean;
}

interface AgentKeyContextValue {
  handleRef: MutableRefObject<AgentKeyHandle | null>;
  setHandle: (handle: AgentKeyHandle | null) => void;
  getHandle: () => AgentKeyHandle | null;
}

const AgentKeyContext = createContext<AgentKeyContextValue | null>(null);

export function AgentKeyProvider({ children }: { children: ReactNode }) {
  const handleRef = useRef<AgentKeyHandle | null>(null);
  const value: AgentKeyContextValue = {
    handleRef,
    setHandle: (handle) => {
      handleRef.current = handle;
    },
    getHandle: () => handleRef.current,
  };
  return (
    <AgentKeyContext.Provider value={value}>{children}</AgentKeyContext.Provider>
  );
}

export function useAgentKey(): AgentKeyContextValue {
  const ctx = useContext(AgentKeyContext);
  if (!ctx) {
    throw new Error('useAgentKey requires AgentKeyProvider');
  }
  return ctx;
}

/**
 * Generate a local P-256 agent key. Prefers non-extractable; falls back to
 * extractable encrypted-keystore model when the runtime rejects non-extractable.
 * Never returns private JWK material.
 */
export async function generateBrowserAgentKey(): Promise<AgentKeyHandle> {
  try {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    );
    // Probe extractability — if export succeeds, treat as soft keystore.
    let keystoreProvider: KeystoreProviderKind = 'os_hardware';
    let nonExtractable = true;
    let pair = keyPair;
    try {
      await crypto.subtle.exportKey('jwk', keyPair.privateKey);
      // Unexpectedly extractable — regenerate as explicit soft keystore.
      keystoreProvider = 'encrypted_os_keystore';
      nonExtractable = false;
      pair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
      );
    } catch {
      keystoreProvider = 'os_hardware';
      nonExtractable = true;
    }
    const publicJwk = await assertPublicEcP256Jwk(
      await crypto.subtle.exportKey('jwk', pair.publicKey),
    );
    return {
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      publicJwk,
      keystoreProvider,
      nonExtractable,
    };
  } catch {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const publicJwk = await assertPublicEcP256Jwk(
      await crypto.subtle.exportKey('jwk', pair.publicKey),
    );
    return {
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      publicJwk,
      keystoreProvider: 'encrypted_os_keystore',
      nonExtractable: false,
    };
  }
}

/** Sign a challenge payload with the in-memory private CryptoKey (never leaves device). */
export async function signChallengeWithHandle(
  handle: AgentKeyHandle,
  payload: {
    nonce: string;
    audience: string;
    timestamp: string;
    intent_hash: string;
  },
): Promise<string> {
  const canonical = [
    `nonce=${payload.nonce}`,
    `audience=${payload.audience}`,
    `timestamp=${payload.timestamp}`,
    `intent_hash=${payload.intent_hash}`,
  ].join('\n');
  const bytes = new TextEncoder().encode(canonical);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    handle.privateKey,
    bytes,
  );
  const toB64Url = (buf: ArrayBuffer | Uint8Array | string) => {
    const u8 =
      typeof buf === 'string'
        ? new TextEncoder().encode(buf)
        : buf instanceof Uint8Array
          ? buf
          : new Uint8Array(buf);
    let s = '';
    for (const b of u8) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const header = toB64Url(JSON.stringify({ alg: 'ES256', typ: 'KYA-CHALLENGE-RAW' }));
  const body = toB64Url(bytes);
  const signature = toB64Url(sig);
  return `${header}.${body}.${signature}`;
}
