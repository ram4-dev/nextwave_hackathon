/**
 * Browser IndexedDB storage for a non-extractable agent CryptoKey handle.
 * Never uses localStorage or exports private JWK.
 */
import { assertPublicEcP256Jwk } from './dpopClient.js';

const DB_NAME = 'kya-agent-keystore';
const STORE = 'keys';
const KEY_ID = 'local-agent';

export type StoredAgentKeyMeta = {
  publicJwk: JsonWebKey;
  thumbprint: string;
  keystoreProvider: 'os_hardware' | 'encrypted_os_keystore';
};

export type AgentKeyHandle = StoredAgentKeyMeta & {
  privateKey: CryptoKey;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

export async function isIndexedDbAvailable(): Promise<boolean> {
  try {
    if (typeof indexedDB === 'undefined') return false;
    const db = await openDb();
    db.close();
    return true;
  } catch {
    return false;
  }
}

export async function saveAgentKeyHandle(handle: AgentKeyHandle): Promise<void> {
  if (!handle.privateKey || handle.privateKey.type !== 'private') {
    throw new Error('Invalid private key handle');
  }
  const publicJwk = await assertPublicEcP256Jwk({ ...handle.publicJwk });
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(
      {
        privateKey: handle.privateKey,
        publicJwk,
        thumbprint: handle.thumbprint,
        keystoreProvider: handle.keystoreProvider,
      },
      KEY_ID,
    );
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('save failed'));
  });
  db.close();
}

export async function loadAgentKeyHandle(): Promise<AgentKeyHandle | null> {
  const db = await openDb();
  const row = await new Promise<AgentKeyHandle | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(KEY_ID);
    req.onsuccess = () => resolve((req.result as AgentKeyHandle | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error('load failed'));
  });
  db.close();
  if (!row) return null;
  if (!row.privateKey || row.privateKey.type !== 'private') {
    throw new Error('Invalid stored private key handle');
  }
  row.publicJwk = await assertPublicEcP256Jwk({ ...row.publicJwk });
  return row;
}

export async function clearAgentKeyHandle(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(KEY_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('clear failed'));
  });
  db.close();
}

export type PairingState = 'absent' | 'present' | 'lost_needs_repair';

export async function getPairingState(): Promise<PairingState> {
  try {
    const handle = await loadAgentKeyHandle();
    return handle?.privateKey ? 'present' : 'absent';
  } catch {
    return 'lost_needs_repair';
  }
}
