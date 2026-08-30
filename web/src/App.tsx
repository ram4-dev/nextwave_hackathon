import { useState } from 'react';
import { useCurrentUser, useGetAccessToken, useSendUserOperation, useSignInWithEmail, useVerifyEmailOTP } from '@coinbase/cdp-hooks';
import { AgentKeyProvider, generateBrowserAgentKey, signChallengeWithHandle, useAgentKey } from './AgentKeyProvider';
import { formatUnknownError } from './errorMessage.js';
import { CdpAuth, type CdpSession } from './CdpAuth.js';
import { advanceAfterVerifiedKyc, awaitRegistrationEvidence, completeRegistrationAndClaimCredential, ensureActiveCredential, selectBoundSmartAccount } from './registration.js';

type Step = 'intro' | 'agent' | 'human' | 'kyc' | 'fingerprint' | 'register' | 'challenge' | 'done';
type Enrollment = {
  agentUuid: string;
  deviceCode: string;
  user_code?: string;
  thumbprint: string;
  fingerprintDisplay: string;
};
type Session = CdpSession;

async function api<T>(path: string, init?: RequestInit & { token?: string }): Promise<T> {
  const headers = new Headers(init?.headers); headers.set('Content-Type', 'application/json');
  if (init?.token) headers.set('Authorization', `Bearer ${init.token}`);
  const response = await fetch(path, { ...init, headers }); const data = await response.json();
  if (!response.ok) throw new Error(formatUnknownError((data as { error?: unknown })?.error, `Request failed (${response.status})`));
  return data as T;
}

function Wizard() {
  const agentKey = useAgentKey(); const { currentUser } = useCurrentUser(); const { getAccessToken } = useGetAccessToken(); const { sendUserOperation } = useSendUserOperation(); const { signInWithEmail } = useSignInWithEmail(); const { verifyEmailOTP } = useVerifyEmailOTP();
  const [step, setStep] = useState<Step>('intro'); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [log, setLog] = useState<string[]>([]);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null); const [session, setSession] = useState<Session | null>(null); const [kycUrl, setKycUrl] = useState<string | null>(null);
  const push = (message: string) => setLog((items) => [...items, message]);
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(null); try { await work(); } catch (cause) { setError(formatUnknownError(cause)); } finally { setBusy(false); } };
  const createAgent = () => run(async () => {
    const key = await generateBrowserAgentKey();
    agentKey.setHandle(key);
    const started = await api<{
      agentUuid: string;
      device_code: string;
      user_code: string;
      thumbprint: string;
      fingerprintDisplay: string;
    }>('/v1/device-enrollments', {
      method: 'POST',
      body: JSON.stringify({ publicJwk: key.publicJwk, keystoreProvider: key.keystoreProvider }),
    });
    const { saveAgentKeyHandle, isIndexedDbAvailable } = await import('./agent/keyStore.js');
    if (await isIndexedDbAvailable()) {
      await saveAgentKeyHandle({
        privateKey: key.privateKey,
        publicJwk: key.publicJwk,
        thumbprint: started.thumbprint,
        keystoreProvider: key.keystoreProvider,
      });
    }
    setEnrollment({
      agentUuid: started.agentUuid,
      deviceCode: started.device_code,
      user_code: started.user_code,
      thumbprint: started.thumbprint,
      fingerprintDisplay: started.fingerprintDisplay,
    });
    push(`Local P-256 key created; user code ${started.user_code}. Private material stays in IndexedDB when supported.`);
    setStep('human');
  });
  const exchangeCdp = async (accessToken: string) => api<Session>('/v1/auth/cdp/exchange', { method: 'POST', body: JSON.stringify({ accessToken }) });
  const completeCdp = async (next: Session) => {
    if (!enrollment?.user_code) throw new Error('Enrollment is unavailable. Restart the ceremony.');
    setSession(next);
    const claimed = await api<{ status: string; needsKyc: boolean }>('/v1/device-enrollments/claim', {
      method: 'POST',
      token: next.token,
      body: JSON.stringify({ user_code: enrollment.user_code, thumbprint: enrollment.thumbprint }),
    });
    push(`CDP Smart Account ${next.wallet} bound to Principal ${next.principalId}.`);
    setStep(claimed.needsKyc ? 'kyc' : 'fingerprint');
  };
  const startKyc = () => run(async () => { if (!session) throw new Error('Sign in first.'); const result = await api<{ verificationUrl: string; provider: string }>('/v1/kyc/sessions', { method: 'POST', token: session.token, body: '{}' }); setKycUrl(result.verificationUrl); push(`Hosted KYC created through ${result.provider}; only its webhook decides verification.`); });
  const refreshKyc = () => run(async () => { if (!session || !enrollment) throw new Error('Sign in first.'); await advanceAfterVerifiedKyc({ getMe: () => api<{ principal: { kycStatus: string } | null }>('/v1/me', { token: session.token }), advanceToFingerprint: () => setStep('fingerprint') }); });
  const approve = () => run(async () => { if (!session || !enrollment) throw new Error('Sign in first.'); await api(`/v1/enrollments/${enrollment.agentUuid}/approve-fingerprint`, { method: 'POST', token: session.token, body: JSON.stringify({ thumbprint: enrollment.thumbprint }) }); setStep('register'); });
  const claimCredential = () => { if (!session || !enrollment) throw new Error('Sign in first.'); return api(`/v1/enrollments/${enrollment.agentUuid}/claim-credential`, { method: 'POST', token: session.token, body: '{}' }); };
  const register = () => run(async () => { if (!session || !enrollment) throw new Error('Sign in first.'); const smart = selectBoundSmartAccount(currentUser?.evmSmartAccountObjects?.[0], session.wallet); const intent = await api<{ intentHash: string; register: { to: `0x${string}`; data: `0x${string}`; value: '0x0' } }>(`/v1/enrollments/${enrollment.agentUuid}/registration-intent`, { method: 'POST', token: session.token, body: '{}' }); await completeRegistrationAndClaimCredential({ sendUserOperation: () => sendUserOperation({ evmSmartAccount: smart, network: 'base-sepolia', useCdpPaymaster: true, calls: [{ to: intent.register.to, data: intent.register.data, value: 0n }] }), recordSubmission: (userOpHash) => api(`/v1/enrollments/${enrollment.agentUuid}/registration-submissions`, { method: 'POST', token: session.token, body: JSON.stringify({ intentHash: intent.intentHash, userOpHash }) }), awaitEvidence: () => awaitRegistrationEvidence({ resolveSubmission: () => api(`/v1/enrollments/${enrollment.agentUuid}/registration-submissions/resolve`, { method: 'POST', token: session.token, body: '{}' }), getEnrollment: () => api(`/v1/enrollments/${enrollment.agentUuid}`, { token: session.token }) }), claimCredential, advanceToChallenge: () => { push('ERC-8004 event, ownerOf, and active credential confirmed.'); setStep('challenge'); } }); });
  const challenge = () => run(async () => { if (!enrollment) throw new Error('Enrollment missing.'); const handle = agentKey.getHandle(); if (!handle) throw new Error('Local agent key is unavailable.'); await ensureActiveCredential(claimCredential, async () => { const payload = await api<{ nonce: string; audience: string; timestamp: string; intent_hash: string }>(`/v1/agents/${enrollment.agentUuid}/challenges`, { method: 'POST', body: JSON.stringify({ intent: { action: 'wizard-ping' } }) }); const signature = await signChallengeWithHandle(handle, payload); await api(`/v1/agents/${enrollment.agentUuid}/challenges/verify`, { method: 'POST', body: JSON.stringify({ ...payload, signature }) }); setStep('done'); }); });
  return <div className="app"><div className="mode-pill">CDP email OTP · embedded Smart Account · Base Sepolia</div><h1 className="brand">KYA</h1><p className="tagline">A verified human authorizes an independent local P-256 agent key. CDP owns the human wallet; KYA never receives wallet keys.</p>
    {step === 'intro' && <section className="panel"><h2>Ceremony</h2><p>Email OTP provisions a CDP Smart Account. Its address becomes the KYA Principal wallet.</p><button disabled={busy} onClick={() => setStep('agent')}>Start enrollment</button></section>}
    {step === 'agent' && <section className="panel"><h2>1. Local agent key</h2><p>Generate the non-extractable P-256 key before attaching a person.</p><button disabled={busy} onClick={createAgent}>Generate agent key</button></section>}
    {step === 'human' && enrollment && <section className="panel"><h2>2. Email sign-in</h2><p>Use email OTP. No wallet extension or manual chain switch is involved.</p><div className="mono">User code: {enrollment.user_code}<br/>Fingerprint: {enrollment.fingerprintDisplay}</div><CdpAuth requestOtp={signInWithEmail} verifyOtp={verifyEmailOTP} getAccessToken={getAccessToken} exchangeSession={exchangeCdp} onSession={completeCdp} /></section>}
    {step === 'kyc' && <section className="panel"><h2>3. KYC</h2><div className="actions"><button disabled={busy} onClick={startKyc}>Start hosted KYC</button><button disabled={busy} onClick={refreshKyc}>Refresh status</button></div>{kycUrl && <a href={kycUrl} target="_blank" rel="noreferrer">Open hosted KYC</a>}</section>}
    {step === 'fingerprint' && enrollment && <section className="panel"><h2>4. Approve fingerprint</h2><div className="mono">{enrollment.fingerprintDisplay}</div><button disabled={busy} onClick={approve}>Approve local agent key</button></section>}
    {step === 'register' && <section className="panel"><h2>5. Register ERC-8004</h2><p>CDP requests approval for exactly one sponsored Base Sepolia UserOperation.</p><button disabled={busy} onClick={register}>Approve &amp; submit Smart Account operation</button></section>}
    {step === 'challenge' && <section className="panel"><h2>6. Agent challenge</h2><p>The registry watcher must confirm registration before a credential can be claimed.</p><button disabled={busy} onClick={challenge}>Sign &amp; verify agent challenge</button></section>}
    {step === 'done' && <section className="panel"><h2 className="ok">Complete</h2><p>Agent challenge verified with the locally held agent key.</p></section>}{error && <div className="err">{error}</div>}<div className="log"><h3>Ceremony log</h3><ul>{log.map((entry, index) => <li key={`${index}-${entry}`}>{entry}</li>)}</ul></div></div>;
}
export function App() { return <AgentKeyProvider><Wizard /></AgentKeyProvider>; }
