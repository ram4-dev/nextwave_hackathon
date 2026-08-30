/**
 * AuthorizationVerifier port — PaymentService verifies opaque authorization_id
 * before provider calls. MANDATE_MAX_AMOUNT must never substitute for this.
 */

export type AuthorizationContext = {
  authorizationId: string;
  actorId: string;
  amount: { currency: string; value_minor: number };
  merchantId?: string;
  paymentMethodId?: string;
};

export type AuthorizationResult =
  | { ok: true; principalId: string; agentUuid?: string }
  | { ok: false; reason: string };

export interface AuthorizationVerifier {
  verify(ctx: AuthorizationContext): Promise<AuthorizationResult>;
}

/** Production default — fail closed until a real issuer is wired (F7+). */
export class FailClosedAuthorizationVerifier implements AuthorizationVerifier {
  async verify(_ctx: AuthorizationContext): Promise<AuthorizationResult> {
    return { ok: false, reason: 'authorization verifier not configured' };
  }
}

/**
 * Dev/test-only deterministic verifier.
 * Accepts ids that start with `authz_` and binds the principal to the actor.
 */
export class DeterministicDevAuthorizationVerifier implements AuthorizationVerifier {
  async verify(ctx: AuthorizationContext): Promise<AuthorizationResult> {
    if (!ctx.authorizationId || typeof ctx.authorizationId !== 'string') {
      return { ok: false, reason: 'missing authorization_id' };
    }
    if (!ctx.authorizationId.startsWith('authz_')) {
      return { ok: false, reason: 'invalid authorization_id prefix' };
    }
    if (ctx.amount.value_minor <= 0) {
      return { ok: false, reason: 'invalid amount' };
    }
    return { ok: true, principalId: ctx.actorId };
  }
}
