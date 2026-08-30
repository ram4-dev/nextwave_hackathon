// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CdpAuth } from '../web/src/CdpAuth.js';
import { advanceAfterVerifiedKyc, awaitRegistrationEvidence, completeRegistrationAndClaimCredential, ensureActiveCredential, selectBoundSmartAccount, submitSponsoredRegistration } from '../web/src/registration.js';
import { cdpProviderConfig } from '../web/src/cdpConfig.js';

describe('CDP email OTP UI', () => {
  it('submits an email and advances to the OTP stage', async () => {
    const user = userEvent.setup();
    const requestOtp = vi.fn().mockResolvedValue({ flowId: 'flow-123' });
    const verifyOtp = vi.fn();
    const exchangeSession = vi.fn();
    render(createElement(CdpAuth, { requestOtp, verifyOtp, getAccessToken: vi.fn(), exchangeSession, onSession: vi.fn() }));
    await user.type(screen.getByLabelText('Email address'), 'person@example.com');
    await user.click(screen.getByRole('button', { name: 'Send email code' }));
    expect(requestOtp).toHaveBeenCalledWith({ email: 'person@example.com' });
    expect(await screen.findByLabelText('One-time code')).toBeTruthy();
    expect(screen.getByText('Code sent to person@example.com')).toBeTruthy();
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('verifies the OTP, exchanges the CDP access token, and reports the KYA session', async () => {
    const user = userEvent.setup();
    const session = { token: 'kya-session-token', principalId: 'prin_123', wallet: '0x1111111111111111111111111111111111111111' as const };
    const requestOtp = vi.fn().mockResolvedValue({ flowId: 'flow-123' });
    const verifyOtp = vi.fn().mockResolvedValue({ user: { id: 'cdp-user' } });
    const getAccessToken = vi.fn().mockResolvedValue('cdp-access-token');
    const exchangeSession = vi.fn().mockResolvedValue(session);
    const onSession = vi.fn();
    render(createElement(CdpAuth, { requestOtp, verifyOtp, getAccessToken, exchangeSession, onSession }));
    await user.type(screen.getByLabelText('Email address'), 'person@example.com');
    await user.click(screen.getByRole('button', { name: 'Send email code' }));
    await user.type(await screen.findByLabelText('One-time code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify code' }));
    expect(verifyOtp).toHaveBeenCalledWith({ flowId: 'flow-123', otp: '123456' });
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(exchangeSession).toHaveBeenCalledWith('cdp-access-token');
    expect(onSession).toHaveBeenCalledWith(session);
    expect(await screen.findByText('Signed in with your CDP Smart Account.')).toBeTruthy();
  });

  it('normalizes OTP failures into a visible retryable error', async () => {
    const user = userEvent.setup();
    const requestOtp = vi.fn().mockRejectedValue({ message: 'provider detail that must not leak' });
    render(createElement(CdpAuth, { requestOtp, verifyOtp: vi.fn(), getAccessToken: vi.fn(), exchangeSession: vi.fn(), onSession: vi.fn() }));
    await user.type(screen.getByLabelText('Email address'), 'person@example.com');
    await user.click(screen.getByRole('button', { name: 'Send email code' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Unable to send the email code. Please try again.');
    expect((screen.getByRole('button', { name: 'Send email code' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('blocks an in-flight duplicate email request and normalizes rate-limit provider errors', async () => {
    let release: (() => void) | undefined;
    const requestOtp = vi.fn(() => new Promise<{ flowId: string }>((resolve) => { release = () => resolve({ flowId: 'flow-123' }); }));
    const user = userEvent.setup();
    const view = render(createElement(CdpAuth, { requestOtp, verifyOtp: vi.fn(), getAccessToken: vi.fn(), exchangeSession: vi.fn(), onSession: vi.fn() }));
    await user.type(screen.getByLabelText('Email address'), 'person@example.com');
    await user.dblClick(screen.getByRole('button', { name: 'Send email code' }));
    expect(requestOtp).toHaveBeenCalledTimes(1);
    release!();
    expect(await screen.findByLabelText('One-time code')).toBeTruthy();
    view.unmount();

    const rateLimited = vi.fn().mockRejectedValue({ code: 'rate_limited', detail: 'sensitive provider payload' });
    render(createElement(CdpAuth, { requestOtp: vi.fn().mockResolvedValue({ flowId: 'flow-123' }), verifyOtp: rateLimited, getAccessToken: vi.fn(), exchangeSession: vi.fn(), onSession: vi.fn() }));
    await user.type(screen.getByLabelText('Email address'), 'person@example.com');
    await user.click(screen.getByRole('button', { name: 'Send email code' }));
    await user.type(await screen.findByLabelText('One-time code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify code' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Unable to verify the email code. Please try again.');
  });

  it('never exchanges an access token or creates a session for invalid or replayed OTPs', async () => {
    for (const code of ['invalid_otp', 'replayed_otp']) {
      const user = userEvent.setup();
      const getAccessToken = vi.fn(); const exchangeSession = vi.fn(); const onSession = vi.fn();
      const view = render(createElement(CdpAuth, { requestOtp: vi.fn().mockResolvedValue({ flowId: 'flow-123' }), verifyOtp: vi.fn().mockRejectedValue({ code }), getAccessToken, exchangeSession, onSession }));
      await user.type(screen.getByLabelText('Email address'), 'person@example.com');
      await user.click(screen.getByRole('button', { name: 'Send email code' }));
      await user.type(await screen.findByLabelText('One-time code'), '123456');
      await user.click(screen.getByRole('button', { name: 'Verify code' }));
      expect(getAccessToken).not.toHaveBeenCalled();
      expect(exchangeSession).not.toHaveBeenCalled();
      expect(onSession).not.toHaveBeenCalled();
      view.unmount();
    }
  });
});

describe('registration evidence polling', () => {
  it('advances after server-confirmed KYC without invoking a legacy attach authority', async () => {
    const order: string[] = [];
    await advanceAfterVerifiedKyc({
      getMe: async () => {
        order.push('me');
        return { principal: { kycStatus: 'verified' } };
      },
      advanceToFingerprint: () => { order.push('fingerprint'); },
    });
    expect(order).toEqual(['me', 'fingerprint']);
  });

  it('does not advance when the authoritative Principal KYC is not verified', async () => {
    const advanceToFingerprint = vi.fn();
    await expect(advanceAfterVerifiedKyc({
      getMe: async () => ({ principal: { kycStatus: 'pending' } }),
      advanceToFingerprint,
    })).rejects.toThrow('KYC is not yet verified');
    expect(advanceToFingerprint).not.toHaveBeenCalled();
  });

  it('does not advance when an event is observed before transaction resolution, then completes after watcher binding', async () => {
    const resolveSubmission = vi.fn()
      .mockResolvedValueOnce({ status: 'pending' as const })
      .mockResolvedValueOnce({ status: 'confirmed' as const, transactionHash: `0x${'ab'.repeat(32)}` as `0x${string}` });
    const getEnrollment = vi.fn().mockResolvedValue({ status: 'bound' });
    await expect(awaitRegistrationEvidence({ resolveSubmission, getEnrollment, sleep: async () => undefined, attempts: 2 })).resolves.toBeUndefined();
    expect(resolveSubmission).toHaveBeenCalledTimes(2);
    expect(getEnrollment).toHaveBeenCalledTimes(1);
  });

  it('keeps polling after transaction resolution until the watcher binds the exact event', async () => {
    const resolveSubmission = vi.fn().mockResolvedValue({ status: 'confirmed' as const, transactionHash: `0x${'ab'.repeat(32)}` as `0x${string}` });
    const getEnrollment = vi.fn().mockResolvedValueOnce({ status: 'awaiting_onchain' }).mockResolvedValueOnce({ status: 'bound' });
    await expect(awaitRegistrationEvidence({ resolveSubmission, getEnrollment, sleep: async () => undefined, attempts: 2 })).resolves.toBeUndefined();
    expect(getEnrollment).toHaveBeenCalledTimes(2);
  });

  it('records only the returned UserOperation hash and records nothing after user or sponsor rejection', async () => {
    const recordSubmission = vi.fn();
    await submitSponsoredRegistration({ sendUserOperation: async () => ({ userOperationHash: `0x${'ab'.repeat(32)}` }), recordSubmission, awaitEvidence: async () => undefined });
    expect(recordSubmission).toHaveBeenCalledWith(`0x${'ab'.repeat(32)}`);
    for (const error of [new Error('user rejected'), new Error('sponsor unavailable')]) {
      const record = vi.fn();
      await expect(submitSponsoredRegistration({ sendUserOperation: async () => { throw error; }, recordSubmission: record, awaitEvidence: async () => undefined })).rejects.toThrow();
      expect(record).not.toHaveBeenCalled();
    }
  });

  it('does not report registration success when terminal resolution evidence fails', async () => {
    const recordSubmission = vi.fn();
    await expect(submitSponsoredRegistration({ sendUserOperation: async () => ({ userOperationHash: `0x${'ab'.repeat(32)}` }), recordSubmission, awaitEvidence: async () => { throw new Error('terminal resolution failure'); } })).rejects.toThrow('terminal resolution failure');
    expect(recordSubmission).toHaveBeenCalledTimes(1);
  });

  it('claims the server credential only after UserOperation evidence and then advances once', async () => {
    const order: string[] = [];
    await completeRegistrationAndClaimCredential({
      sendUserOperation: async () => {
        order.push('user-operation');
        return { userOperationHash: `0x${'ab'.repeat(32)}` };
      },
      recordSubmission: async () => { order.push('submission'); },
      awaitEvidence: async () => { order.push('evidence'); },
      claimCredential: async () => { order.push('claim'); },
      advanceToChallenge: () => { order.push('challenge'); },
    });
    expect(order).toEqual(['user-operation', 'submission', 'evidence', 'claim', 'challenge']);
  });

  it('fails closed without advancing when the authenticated credential claim fails', async () => {
    const advanceToChallenge = vi.fn();
    await expect(completeRegistrationAndClaimCredential({
      sendUserOperation: async () => ({ userOperationHash: `0x${'ab'.repeat(32)}` }),
      recordSubmission: async () => undefined,
      awaitEvidence: async () => undefined,
      claimCredential: async () => { throw new Error('credential claim unavailable'); },
      advanceToChallenge,
    })).rejects.toThrow('credential claim unavailable');
    expect(advanceToChallenge).not.toHaveBeenCalled();
  });

  it('recovers a bound ceremony after HMR by ensuring the active credential before retrying the challenge', async () => {
    const order: string[] = [];
    await ensureActiveCredential(
      async () => { order.push('claim'); },
      async () => { order.push('challenge'); },
    );
    expect(order).toEqual(['claim', 'challenge']);

    await expect(ensureActiveCredential(
      async () => { throw new Error('claim denied'); },
      async () => { order.push('unexpected challenge'); },
    )).rejects.toThrow('claim denied');
    expect(order).toEqual(['claim', 'challenge']);
  });

  it('requires the current CDP Smart Account to equal the session-bound Principal wallet', () => {
    expect(selectBoundSmartAccount({ address: '0x1111111111111111111111111111111111111111' }, '0x1111111111111111111111111111111111111111')).toBe('0x1111111111111111111111111111111111111111');
    expect(() => selectBoundSmartAccount({ address: '0x2222222222222222222222222222222222222222' }, '0x1111111111111111111111111111111111111111')).toThrow(/does not match/i);
    expect(() => selectBoundSmartAccount(undefined, '0x1111111111111111111111111111111111111111')).toThrow(/provisioning/i);
  });
});

describe('CDP provider configuration', () => {
  it('requires a public project ID and provisions email-only Smart Accounts', () => {
    expect(cdpProviderConfig('public-project')).toEqual({ projectId: 'public-project', ethereum: { createOnLogin: 'smart' }, authMethods: ['email'], appName: 'KYA' });
    expect(() => cdpProviderConfig('')).toThrow(/VITE_CDP_PROJECT_ID/);
  });
});
