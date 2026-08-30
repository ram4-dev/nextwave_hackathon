export type RegistrationResolution = { status: 'pending' | 'confirmed'; transactionHash?: `0x${string}` };

/** Reject a stale CDP hook account before it can submit an intent for another Principal. */
export function selectBoundSmartAccount(
  account: { address?: string } | undefined,
  sessionWallet: `0x${string}`,
): `0x${string}` {
  if (!account?.address || !/^0x[a-fA-F0-9]{40}$/.test(account.address)) {
    throw new Error('CDP Smart Account is still provisioning; wait and retry.');
  }
  if (account.address.toLowerCase() !== sessionWallet.toLowerCase()) {
    throw new Error('Current CDP Smart Account does not match this KYA session. Sign in again.');
  }
  return account.address as `0x${string}`;
}

/**
 * Continue a claimed enrollment after the server confirms Principal KYC.
 * Pairing authority was already consumed by device-enrollments/claim; this
 * deliberately performs no second attach or binding mutation.
 */
export async function advanceAfterVerifiedKyc(input: {
  getMe: () => Promise<{ principal: { kycStatus: string } | null }>;
  advanceToFingerprint: () => void;
}): Promise<void> {
  const me = await input.getMe();
  if (me.principal?.kycStatus !== 'verified') {
    throw new Error('KYC is not yet verified.');
  }
  input.advanceToFingerprint();
}

/** Wait for provider transaction evidence and then independent watcher binding. */
export async function awaitRegistrationEvidence(input: {
  resolveSubmission: () => Promise<RegistrationResolution>;
  getEnrollment: () => Promise<{ status: string }>;
  sleep?: () => Promise<void>;
  attempts?: number;
}): Promise<void> {
  const attempts = input.attempts ?? 30;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const resolved = await input.resolveSubmission();
    if (resolved.status === 'confirmed') {
      const enrollment = await input.getEnrollment();
      if (enrollment.status === 'bound') return;
    }
    await (input.sleep ?? (() => new Promise((resolve) => setTimeout(resolve, 1000))))();
  }
  throw new Error('Registration evidence is still pending. Keep this page open and retry.');
}

export async function submitSponsoredRegistration(input: {
  sendUserOperation: () => Promise<{ userOperationHash: `0x${string}` }>;
  recordSubmission: (userOpHash: `0x${string}`) => Promise<void>;
  awaitEvidence: () => Promise<void>;
}): Promise<void> {
  const result = await input.sendUserOperation();
  await input.recordSubmission(result.userOperationHash);
  await input.awaitEvidence();
}

/**
 * Complete the registration boundary before the UI can expose agent challenge
 * controls. Credential issuance remains authenticated and server-side.
 */
export async function completeRegistrationAndClaimCredential(input: {
  sendUserOperation: () => Promise<{ userOperationHash: `0x${string}` }>;
  recordSubmission: (userOpHash: `0x${string}`) => Promise<void>;
  awaitEvidence: () => Promise<void>;
  claimCredential: () => Promise<unknown>;
  advanceToChallenge: () => void;
}): Promise<void> {
  await submitSponsoredRegistration(input);
  await input.claimCredential();
  input.advanceToChallenge();
}

/** Ensure an active server credential before starting a locally signed challenge. */
export async function ensureActiveCredential<T>(
  claimCredential: () => Promise<unknown>,
  continueWithCredential: () => Promise<T>,
): Promise<T> {
  await claimCredential();
  return continueWithCredential();
}
