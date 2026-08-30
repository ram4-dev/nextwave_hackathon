import { FormEvent, useState } from 'react';

export type CdpSession = {
  token: string;
  principalId: string;
  wallet: `0x${string}`;
};

type CdpAuthProps = {
  requestOtp: (input: { email: string }) => Promise<{ flowId: string }>;
  verifyOtp: (input: { flowId: string; otp: string }) => Promise<unknown>;
  getAccessToken: () => Promise<string | null | undefined>;
  exchangeSession: (accessToken: string) => Promise<CdpSession>;
  onSession: (session: CdpSession) => void | Promise<void>;
};

type Stage = 'email' | 'otp' | 'authenticated';

/**
 * Presentation-only email OTP flow. CDP hooks are injected by the runtime
 * wrapper, keeping the authentication state machine testable without CDP keys.
 */
export function CdpAuth({
  requestOtp,
  verifyOtp,
  getAccessToken,
  exchangeSession,
  onSession,
}: CdpAuthProps) {
  const [stage, setStage] = useState<Stage>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [flowId, setFlowId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = await requestOtp({ email: email.trim() });
      if (!result.flowId) throw new Error('Missing CDP email flow');
      setFlowId(result.flowId);
      setStage('otp');
    } catch {
      setError('Unable to send the email code. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function submitOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!flowId) return;
    setBusy(true);
    setError(undefined);
    try {
      await verifyOtp({ flowId, otp: otp.trim() });
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error('Missing CDP access token');
      const session = await exchangeSession(accessToken);
      await onSession(session);
      setStage('authenticated');
    } catch {
      setError('Unable to verify the email code. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (stage === 'authenticated') {
    return <p className="ok" role="status">Signed in with your CDP Smart Account.</p>;
  }

  return (
    <div className="actions">
      {stage === 'email' ? (
        <form onSubmit={submitEmail}>
          <label htmlFor="cdp-email">Email address</label>
          <input id="cdp-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" />
          <button type="submit" disabled={busy}>Send email code</button>
        </form>
      ) : (
        <form onSubmit={submitOtp}>
          <p>Code sent to {email}</p>
          <label htmlFor="cdp-otp">One-time code</label>
          <input id="cdp-otp" inputMode="numeric" value={otp} onChange={(event) => setOtp(event.target.value)} required autoComplete="one-time-code" />
          <button type="submit" disabled={busy || otp.trim().length === 0}>Verify code</button>
        </form>
      )}
      {error && <p className="err" role="alert">{error}</p>}
    </div>
  );
}
