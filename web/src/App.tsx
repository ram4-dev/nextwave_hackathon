import { useEffect, useState } from 'react';
import {
  AgentKeyProvider,
  generateBrowserAgentKey,
  signChallengeWithHandle,
  useAgentKey,
} from './AgentKeyProvider';
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
  issuer: string;
  audience: string;
  chainIdSepolia: number;
  identityRegistrySepolia: string;
  publicBaseUrl: string;
}

interface EnrollmentStart {
  agentUuid: string;
  deviceCode: string;
  thumbprint: string;
  fingerprintDisplay: string;
}

/** Mock owner address — this build has no real wallet connection. */
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
  const [challengeResult, setChallengeResult] = useState<string | null>(null);

  const push = (msg: string) => setLog((l) => [...l, msg]);

  useEffect(() => {
    api<PublicConfig>('/v1/config')
      .then(setConfig)
      .catch((e) => setError(formatUnknownError(e)));
  }, []);

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

  async function mockSignIn() {
    setBusy(true);
    setError(null);
    try {
      if (!enrollment) throw new Error('Create agent key first');
      const res = await api<{ token: string; address: string; principalId: string }>(
        '/v1/auth/login',
        { method: 'POST', body: JSON.stringify({ address: DEMO_ADDRESS }) },
      );
      setToken(res.token);
      push(`Mock session for ${res.address} (principal ${res.principalId})`);
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

  async function completeMockKyc() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ kycStatus: string }>('/v1/kyc/complete', {
        method: 'POST',
        token,
        body: '{}',
      });
      push(`Mock KYC verified; principal kycStatus=${result.kycStatus}`);
      setStep('fingerprint');
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

  async function mockBind() {
    if (!token || !enrollment) return;
    setBusy(true);
    setError(null);
    try {
      const bound = await api<{ token: string; agentId: string; agentRegistry: string }>(
        `/v1/enrollments/${enrollment.agentUuid}/bind`,
        { method: 'POST', token, body: '{}' },
      );
      setCredential(bound.token);
      setAgentId(bound.agentId);
      push(`Bound agentId=${bound.agentId} registry=${bound.agentRegistry}; JWS issued`);
      setStep('challenge');
    } catch (e) {
      setError(formatUnknownError(e));
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
      <div className="mode-pill">Demo mode — mocked ceremony, no chain writes</div>
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
            Mock path: local key → mock sign-in → mock KYC → fingerprint approval → mock
            register → challenge. Every server-side effect is labeled and none of it writes to a
            real chain, wallet, or KYC provider.
          </p>
          {config && (
            <div className="mono">
              Registry Sepolia (display-only): {config.identityRegistrySepolia}
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
            Generate a P-256 key with WebCrypto (prefer non-extractable). Private material never
            enters React state or the server.
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
          <h2>2. Human sign-in (mocked)</h2>
          <p>No real wallet in this build — a labeled mock session stands in for it.</p>
          <div className="mono">
            Device code: {enrollment.deviceCode}
            <br />
            Keystore: {keystore}
            <br />
            Fingerprint: {enrollment.fingerprintDisplay}
          </div>
          <div className="actions">
            <button type="button" disabled={busy} onClick={mockSignIn}>
              Mock sign in
            </button>
          </div>
        </section>
      )}

      {step === 'kyc' && (
        <section className="panel">
          <h2>3. KYC (mocked)</h2>
          <p>Instantly verifies the Principal. No external provider in this build.</p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={completeMockKyc}>
              Complete mock KYC
            </button>
          </div>
        </section>
      )}

      {step === 'fingerprint' && enrollment && (
        <section className="panel">
          <h2>4. Approve fingerprint</h2>
          <p>Confirm the local agent public key fingerprint before binding.</p>
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
          <h2>5. Register (mocked)</h2>
          <p>
            Assigns a display-plausible agentId/registry reference — no on-chain write — and
            issues the real ES256 JWS credential (cnf.jkt-bound).
          </p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={mockBind}>
              Confirm mock registration
            </button>
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
