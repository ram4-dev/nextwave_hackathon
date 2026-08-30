import { useEffect, useRef, useState } from 'react';
import {
  AgentKeyProvider,
  generateBrowserAgentKey,
  signChallengeWithHandle,
  useAgentKey,
} from './AgentKeyProvider';
import {
  BrowserWalletConnector,
  formatBrowserWalletError,
  type RegisterIntent,
  type WalletOption,
} from './browserWalletConnector';
import { formatUnknownError } from './errorMessage.js';

type Step =
  | 'intro'
  | 'agent'
  | 'human'
  | 'kyc'
  | 'fingerprint'
  | 'register'
  | 'challenge'
  | 'done';

interface PublicConfig {
  mode: string;
  issuer: string;
  chainIdSepolia: number;
  identityRegistrySepolia: string;
  siweDomain?: string;
  siweUri?: string;
}

interface EnrollmentStart {
  agentUuid: string;
  deviceCode: string;
  thumbprint: string;
  fingerprintDisplay: string;
  agentUriUrl: string;
}

const DEMO_ADDRESS = '0x1111111111111111111111111111111111111111' as const;

async function api<T>(
  path: string,
  init?: RequestInit & { token?: string },
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  if (init?.token) headers.set('Authorization', `Bearer ${init.token}`);
  const res = await fetch(path, { ...init, headers });
  const data = await res.json();
  if (!res.ok) {
    const responseError =
      data && typeof data === 'object' && 'error' in data
        ? (data as { error?: unknown }).error
        : data;
    throw new Error(
      formatUnknownError(responseError, res.statusText || `Request failed (${res.status})`),
    );
  }
  return data as T;
}

function Wizard() {
  const agentKey = useAgentKey();
  const walletConnector = useRef<BrowserWalletConnector | null>(null);
  if (!walletConnector.current) walletConnector.current = new BrowserWalletConnector();
  const [step, setStep] = useState<Step>('intro');
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [token, setToken] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<EnrollmentStart | null>(null);
  const [credential, setCredential] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [keystore, setKeystore] = useState<string>('');
  const [kycUrl, setKycUrl] = useState<string | null>(null);
  const [challengeResult, setChallengeResult] = useState<string | null>(null);
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [selectedWalletId, setSelectedWalletId] = useState('');
  const [walletAddress, setWalletAddress] = useState<`0x${string}` | null>(null);
  const [discoveringWallets, setDiscoveringWallets] = useState(false);

  const isLive = config?.mode === 'live';
  const push = (msg: string) => setLog((l) => [...l, msg]);

  useEffect(() => {
    api<PublicConfig>('/v1/config')
      .then(setConfig)
      .catch((e) => setError(formatUnknownError(e)));
  }, []);

  useEffect(() => {
    const connector = walletConnector.current!;
    const unsubscribe = connector.subscribe((event) => {
      if (event.type === 'accountsChanged') {
        setToken(null);
        setWalletAddress(null);
        setError('Wallet account changed. KYC is address-bound; sign in again.');
        setStep('human');
      } else if (event.type === 'chainChanged' && event.chainId !== 84532) {
        setToken(null);
        setError('Wallet left Base Sepolia. Switch back and sign in again.');
        setStep('human');
      } else if (event.type === 'disconnect') {
        setToken(null);
        setWalletAddress(null);
        setError('Browser wallet disconnected. Reconnect and sign in again.');
        setStep('human');
      }
    });
    return () => {
      unsubscribe();
      connector.disconnect();
    };
  }, []);

  useEffect(() => {
    if (isLive && step === 'human' && wallets.length === 0 && !discoveringWallets) {
      void discoverBrowserWallets();
    }
  }, [isLive, step]);

  async function discoverBrowserWallets(): Promise<WalletOption[]> {
    setDiscoveringWallets(true);
    setError(null);
    try {
      const discovered = await walletConnector.current!.discover();
      setWallets(discovered);
      setSelectedWalletId((current) => {
        if (discovered.some((wallet) => wallet.id === current)) return current;
        return discovered.length === 1 ? discovered[0]!.id : '';
      });
      if (discovered.length === 0) {
        setError('No EIP-1193 browser wallet found. Install or enable one to continue.');
      }
      return discovered;
    } catch (e) {
      setError(formatBrowserWalletError(e));
      return [];
    } finally {
      setDiscoveringWallets(false);
    }
  }

  async function generateAgentKey() {
    setBusy(true);
    setError(null);
    try {
      const handle = await generateBrowserAgentKey();
      agentKey.setHandle(handle);
      setKeystore(
        `${handle.keystoreProvider}${handle.nonExtractable ? ' (non-extractable)' : ' (extractable fallback)'}`,
      );
      const started = await api<EnrollmentStart>('/v1/enrollments', {
        method: 'POST',
        body: JSON.stringify({
          publicJwk: handle.publicJwk,
          keystoreProvider: handle.keystoreProvider,
        }),
      });
      setEnrollment(started);
      push(
        `Agent key created (${handle.keystoreProvider}); device code ${started.deviceCode}. Private key stays in CryptoKey ref — not React state.`,
      );
      setStep('human');
    } catch (e) {
      setError(formatUnknownError(e));
    } finally {
      setBusy(false);
    }
  }

  async function demoSignIn() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ token: string; principalId: string }>(
        '/v1/auth/verify',
        {
          method: 'POST',
          body: JSON.stringify({
            address: DEMO_ADDRESS,
            message: `KYA demo browser-wallet sign in:\nURI: http://localhost:5173\nVersion: 1\nChain ID: 84532\nNonce: DEMO_BYPASS\nIssued At: ${new Date().toISOString()}`,
            signature: '0xdemo',
          }),
        },
      );
      setToken(res.token);
      push(`Demo SIWE session for ${DEMO_ADDRESS} (principal ${res.principalId})`);
      if (!enrollment) throw new Error('Create agent key first');
      const attached = await api<{ needsKyc: boolean; status: string }>(
        `/v1/enrollments/${enrollment.agentUuid}/attach`,
        { method: 'POST', token: res.token, body: '{}' },
      );
      push(`Attached human; status=${attached.status}; needsKyc=${attached.needsKyc}`);
      setStep(attached.needsKyc ? 'kyc' : 'fingerprint');
    } catch (e) {
      setError(formatUnknownError(e));
    } finally {
      setBusy(false);
    }
  }

  async function liveSignIn() {
    setBusy(true);
    setError(null);
    try {
      if (!enrollment) throw new Error('Create agent key first');
      let walletId = selectedWalletId;
      if (!walletId) {
        const discovered = await discoverBrowserWallets();
        if (discovered.length !== 1) {
          throw new Error('Select the browser wallet to use for the whole ceremony.');
        }
        walletId = discovered[0]!.id;
        setSelectedWalletId(walletId);
      }

      const connector = walletConnector.current!;
      const connected = await connector.connect(walletId);
      await connector.ensureBaseSepolia();
      setWalletAddress(connected.address);
      push(`Browser wallet connected: ${connected.address}`);

      const domain = config?.siweDomain ?? 'localhost';
      const uri = config?.siweUri ?? 'http://localhost:5173';
      const { nonce } = await api<{ nonce: string }>('/v1/auth/nonce');
      const issuedAt = new Date().toISOString();
      const expirationTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      push('SIWE nonce issued; requesting a browser-wallet signature…');
      const signed = await connector.signSiwe({
        nonce,
        domain,
        uri,
        issuedAt,
        expirationTime,
      });
      const res = await api<{
        token: string;
        principalId: string;
        demo: boolean;
        address: `0x${string}`;
      }>(
        '/v1/auth/verify',
        {
          method: 'POST',
          body: JSON.stringify({
            address: signed.address,
            message: signed.message,
            signature: signed.signature,
          }),
        },
      );
      if (res.demo) throw new Error('Unexpected demo session in live mode');
      if (res.address.toLowerCase() !== signed.address.toLowerCase()) {
        throw new Error('Verified SIWE address does not match the selected wallet');
      }
      setToken(res.token);
      push(`Live SIWE session for ${signed.address}`);
      const attached = await api<{ needsKyc: boolean; status: string }>(
        `/v1/enrollments/${enrollment.agentUuid}/attach`,
        { method: 'POST', token: res.token, body: '{}' },
      );
      push(`Attached human; status=${attached.status}; needsKyc=${attached.needsKyc}`);
      setStep(attached.needsKyc ? 'kyc' : 'fingerprint');
    } catch (e) {
      setError(formatBrowserWalletError(e));
    } finally {
      setBusy(false);
    }
  }

  async function completeDemoKyc() {
    if (!token) return;
    if (isLive) {
      setError('confirm-demo / demo KYC is forbidden in live mode');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/v1/kyc/demo/complete', { method: 'POST', token, body: '{}' });
      push('Demo KYC verified (labeled demo adapter; no PII retained)');
      if (enrollment) {
        await api(`/v1/enrollments/${enrollment.agentUuid}/attach`, {
          method: 'POST',
          token,
          body: '{}',
        });
      }
      setStep('fingerprint');
    } catch (e) {
      setError(formatUnknownError(e));
    } finally {
      setBusy(false);
    }
  }

  async function startLiveKyc() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const session = await api<{
        verificationUrl: string;
        provider: string;
        demo: boolean;
      }>('/v1/kyc/sessions', { method: 'POST', token, body: '{}' });
      if (session.demo) throw new Error('Demo KYC returned in live mode');
      setKycUrl(session.verificationUrl);
      push(`Hosted KYC started via ${session.provider}; complete in provider UI then refresh status`);
    } catch (e) {
      setError(formatUnknownError(e));
    } finally {
      setBusy(false);
    }
  }

  async function refreshKycStatus() {
    if (!token || !enrollment) return;
    setBusy(true);
    setError(null);
    try {
      const me = await api<{
        principal: { kycStatus: string } | null;
      }>('/v1/me', { token });
      push(`Principal KYC status=${me.principal?.kycStatus ?? 'none'}`);
      if (me.principal?.kycStatus === 'verified') {
        await api(`/v1/enrollments/${enrollment.agentUuid}/attach`, {
          method: 'POST',
          token,
          body: '{}',
        });
        setStep('fingerprint');
      }
    } catch (e) {
      setError(formatUnknownError(e));
    } finally {
      setBusy(false);
    }
  }

  async function approveFingerprint() {
    if (!token || !enrollment) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/enrollments/${enrollment.agentUuid}/approve-fingerprint`, {
        method: 'POST',
        token,
        body: JSON.stringify({ thumbprint: enrollment.thumbprint }),
      });
      push(`Fingerprint approved: ${enrollment.fingerprintDisplay}`);
      setStep('register');
    } catch (e) {
      setError(formatUnknownError(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDemoRegister() {
    if (!token || !enrollment) return;
    if (isLive) {
      setError('Never call confirm-demo in live mode');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const prepared = await api<{ mode: string; agentURI: string }>(
        `/v1/enrollments/${enrollment.agentUuid}/prepare-register`,
        { method: 'POST', token, body: '{}' },
      );
      push(`Prepared register (${prepared.mode}) URI=${prepared.agentURI}`);
      const confirmed = await api<{
        token: string;
        agentId: string;
        agentRegistry: string;
      }>(`/v1/enrollments/${enrollment.agentUuid}/confirm-demo`, {
        method: 'POST',
        token,
        body: '{}',
      });
      setCredential(confirmed.token);
      setAgentId(confirmed.agentId);
      push(
        `Bound agentId=${confirmed.agentId} registry=${confirmed.agentRegistry}; JWS issued`,
      );
      setStep('challenge');
    } catch (e) {
      setError(formatUnknownError(e));
    } finally {
      setBusy(false);
    }
  }

  async function liveRegister() {
    if (!token || !enrollment) return;
    setBusy(true);
    setError(null);
    try {
      if (!config) throw new Error('Public configuration is not loaded');
      const prepared = await api<RegisterIntent>(
        `/v1/enrollments/${enrollment.agentUuid}/prepare-register?chainId=84532`, {
        method: 'POST',
        token,
        body: '{}',
        },
      );
      if (prepared.mode !== 'live' || !prepared.register) {
        throw new Error('Expected a live direct transaction from prepare-register');
      }
      const connector = walletConnector.current!;
      await connector.ensureBaseSepolia();
      push(`Prepared register URI=${prepared.agentURI}; simulating exact registry call…`);
      const transactionHash = await connector.sendRegister(
        prepared,
        config.identityRegistrySepolia as `0x${string}`,
      );
      push(`Transaction submitted: ${transactionHash}`);
      const receipt = await connector.waitForReceipt(transactionHash);
      push(`Transaction confirmed in block ${receipt.blockNumber}; waiting for finalized binding…`);

      let bound = false;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const detail = await api<{
          status: string;
          agentId?: string;
        }>(`/v1/enrollments/${enrollment.agentUuid}`, { token });
        push(`Poll ${i + 1}: status=${detail.status} agentId=${detail.agentId ?? '—'}`);
        if (detail.status === 'bound' && detail.agentId) {
          bound = true;
          setAgentId(detail.agentId);
          break;
        }
      }
      if (!bound) throw new Error('Timed out waiting for on-chain Registered binding');

      const claimed = await api<{
        token: string;
        agentId: string;
        agentRegistry: string;
      }>(`/v1/enrollments/${enrollment.agentUuid}/claim-credential`, {
        method: 'POST',
        token,
        body: '{}',
      });
      setCredential(claimed.token);
      push(`Credential claimed for agentId=${claimed.agentId}`);
      setStep('challenge');
    } catch (e) {
      setError(formatBrowserWalletError(e));
    } finally {
      setBusy(false);
    }
  }

  async function runChallenge() {
    if (!enrollment) return;
    const handle = agentKey.getHandle();
    if (!handle) {
      setError('Local agent CryptoKey handle missing — regenerate key in this session');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const challenge = await api<{
        nonce: string;
        audience: string;
        timestamp: string;
        intent_hash: string;
      }>(`/v1/agents/${enrollment.agentUuid}/challenges`, {
        method: 'POST',
        body: JSON.stringify({ intent: { action: 'wizard-ping' } }),
      });
      const signature = await signChallengeWithHandle(handle, {
        nonce: challenge.nonce,
        audience: challenge.audience,
        timestamp: challenge.timestamp,
        intent_hash: challenge.intent_hash,
      });
      const verified = await api<{ ok: boolean; thumbprint: string }>(
        `/v1/agents/${enrollment.agentUuid}/challenges/verify`,
        {
          method: 'POST',
          body: JSON.stringify({
            nonce: challenge.nonce,
            audience: challenge.audience,
            timestamp: challenge.timestamp,
            intent_hash: challenge.intent_hash,
            signature,
          }),
        },
      );
      setChallengeResult(`ok thumbprint=${verified.thumbprint.slice(0, 16)}…`);
      push('Challenge verified with in-memory CryptoKey (not HW-proven by browser WebCrypto)');
      setStep('done');
    } catch (e) {
      setError(formatUnknownError(e));
    } finally {
      setBusy(false);
    }
  }

  const steps: Step[] = [
    'intro',
    'agent',
    'human',
    'kyc',
    'fingerprint',
    'register',
    'challenge',
    'done',
  ];

  return (
    <div className="app">
      <div className="mode-pill">
        {config?.mode === 'demo'
          ? 'Demo mode — labeled mocks / no chain writes'
          : 'Live mode — Base Sepolia + browser wallet / SIWE / hosted KYC'}
      </div>
      <h1 className="brand">KYA</h1>
      <p className="tagline">
        Know Your Agent — bind a verified human Principal to a local P-256 agent key and an
        ERC-8004 Agent ID on Base. Merchant and payments are out of scope.
      </p>

      <div className="steps">
        {steps.map((s) => (
          <span key={s} className={`step-dot ${step === s ? 'active' : ''}`}>
            {s}
          </span>
        ))}
      </div>

      {step === 'intro' && (
        <section className="panel">
          <h2>Ceremony</h2>
          <p>
            {isLive
              ? 'Live path: browser wallet + SIWE → hosted KYC if needed → fingerprint → direct register transaction → claim credential → challenge.'
              : 'Demo path: labeled SIWE bypass → demo KYC → fingerprint → simulated Registered → JWS. Demo steps are explicitly labeled.'}
          </p>
          {config && (
            <div className="mono">
              Registry Sepolia: {config.identityRegistrySepolia}
              <br />
              Issuer: {config.issuer}
            </div>
          )}
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => setStep('agent')}>
              Start enrollment
            </button>
          </div>
        </section>
      )}

      {step === 'agent' && (
        <section className="panel">
          <h2>1. Local agent key</h2>
          <p>
            Generate a P-256 key with WebCrypto (prefer non-extractable). Browser WebCrypto does
            not prove hardware backing — production should use a native OS-keystore behind
            AgentKeyProvider. Private material never enters React state or the server.
          </p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={generateAgentKey}>
              Generate agent key
            </button>
          </div>
        </section>
      )}

      {step === 'human' && enrollment && (
        <section className="panel">
          <h2>2. Browser wallet (SIWE)</h2>
          <p>
            {isLive
              ? 'Select one injected wallet. The same address signs in, owns the KYC Principal, and submits register(agentURI).'
              : 'Demo: labeled DEMO_BYPASS session (not a real signature).'}
          </p>
          <div className="mono">
            Device code: {enrollment.deviceCode}
            <br />
            Keystore: {keystore}
            <br />
            Fingerprint: {enrollment.fingerprintDisplay}
          </div>
          <div className="actions">
            {isLive ? (
              <>
                <label className="wallet-select">
                  Browser wallet
                  <select
                    value={selectedWalletId}
                    disabled={busy || discoveringWallets || wallets.length === 0}
                    onChange={(event) => setSelectedWalletId(event.target.value)}
                  >
                    <option value="">Select wallet</option>
                    {wallets.map((wallet) => (
                      <option key={wallet.id} value={wallet.id}>
                        {wallet.name}{wallet.rdns ? ` (${wallet.rdns})` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="secondary"
                  type="button"
                  disabled={busy || discoveringWallets}
                  onClick={() => void discoverBrowserWallets()}
                >
                  {discoveringWallets ? 'Discovering…' : 'Refresh wallets'}
                </button>
                <button
                  type="button"
                  disabled={busy || discoveringWallets || !selectedWalletId}
                  onClick={liveSignIn}
                >
                  Connect wallet &amp; sign in
                </button>
              </>
            ) : (
              <button type="button" disabled={busy} onClick={demoSignIn}>
                Demo browser-wallet sign in
              </button>
            )}
          </div>
          {isLive && walletAddress && <div className="mono">Connected: {walletAddress}</div>}
        </section>
      )}

      {step === 'kyc' && (
        <section className="panel">
          <h2>3. KYC (person only)</h2>
          <p>
            KYC runs only when the Principal has no active verification. Provider never sees the
            agent.
          </p>
          {isLive ? (
            <>
              <div className="actions">
                <button type="button" disabled={busy} onClick={startLiveKyc}>
                  Start hosted KYC
                </button>
                <button type="button" disabled={busy} onClick={refreshKycStatus}>
                  Refresh KYC status
                </button>
              </div>
              {kycUrl && (
                <p className="mono">
                  Open:{' '}
                  <a href={kycUrl} target="_blank" rel="noreferrer">
                    {kycUrl}
                  </a>
                </p>
              )}
            </>
          ) : (
            <div className="actions">
              <button type="button" disabled={busy} onClick={completeDemoKyc}>
                Complete demo KYC
              </button>
            </div>
          )}
        </section>
      )}

      {step === 'fingerprint' && enrollment && (
        <section className="panel">
          <h2>4. Approve fingerprint</h2>
          <p>Confirm the local agent public key fingerprint before on-chain binding.</p>
          <div className="mono">{enrollment.fingerprintDisplay}</div>
          <div className="actions">
            <button type="button" disabled={busy} onClick={approveFingerprint}>
              Approve fingerprint
            </button>
          </div>
        </section>
      )}

      {step === 'register' && (
        <section className="panel">
          <h2>5. Register on Identity Registry</h2>
          <p>
            {isLive
              ? 'Live: simulate and submit register(agentURI) directly from the authenticated browser wallet. The wallet pays Base Sepolia gas.'
              : 'Demo: confirm simulated Registered event and issue JWS (labeled demo).'}
          </p>
          <div className="actions">
            {isLive ? (
              <button type="button" disabled={busy} onClick={liveRegister}>
                Submit register transaction + claim
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={confirmDemoRegister}>
                Confirm demo registration
              </button>
            )}
          </div>
        </section>
      )}

      {step === 'challenge' && (
        <section className="panel">
          <h2>6. Challenge / verify</h2>
          <p>
            Sign a platform challenge with the in-session CryptoKey handle preserved by
            AgentKeyProvider.
          </p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={runChallenge}>
              Sign &amp; verify challenge
            </button>
          </div>
          {challengeResult && <div className="mono ok">{challengeResult}</div>}
        </section>
      )}

      {step === 'done' && (
        <section className="panel">
          <h2 className="ok">Bound</h2>
          <p>
            Agent ID <strong>{agentId}</strong> is linked to the Principal with a short-lived KYA
            credential (<code>cnf.jkt</code>). Copied JWT is useless without the local private
            key.
          </p>
          {credential && <div className="mono">{credential.slice(0, 120)}…</div>}
        </section>
      )}

      {error && <div className="err">{error}</div>}

      <div className="log">
        <h3>Ceremony log</h3>
        <ul>
          {log.map((l, i) => (
            <li key={`${i}-${l}`}>{l}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function App() {
  return (
    <AgentKeyProvider>
      <Wizard />
    </AgentKeyProvider>
  );
}
