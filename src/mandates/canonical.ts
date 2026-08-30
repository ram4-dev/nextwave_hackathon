import { createHash } from 'node:crypto';
import type { OpenMandateConstraints, OpenMandateRecord } from './policy.js';

/** Deterministic JSON used for mandate payload hashing (sorted object keys). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

export function checkoutHash(jwt: string): string {
  return sha256Base64Url(jwt);
}

export type DraftWindowKind = 'checkout' | 'payment';

type ExactDraftWindow = {
  issuedAt: string;
  expiresAt: string;
};

/**
 * Bind the exact ISO window to the externally retained draft id. The bound id
 * is also the payload jti, so persisted millisecond metadata cannot be changed
 * while preserving both the emitted payload and its lookup key.
 */
export function bindDraftIdToExactWindow(
  kind: DraftWindowKind,
  opaqueId: string,
  window: ExactDraftWindow,
): string {
  const binding = sha256Base64Url(canonicalJson({
    vct: `mandate.${kind}.exact-window.1`,
    draft_id: opaqueId,
    issued_at: window.issuedAt,
    expires_at: window.expiresAt,
  }));
  return `${opaqueId}.${binding}`;
}

export function isDraftIdBoundToExactWindow(
  kind: DraftWindowKind,
  id: string,
  window: ExactDraftWindow,
): boolean {
  if (typeof id !== 'string' || id.length > 200) return false;
  const separator = id.lastIndexOf('.');
  if (separator <= 0) return false;
  const opaqueId = id.slice(0, separator);
  const binding = id.slice(separator + 1);
  if (
    !new RegExp(`^${kind}_draft_[A-Za-z0-9_:-]+$`).test(opaqueId)
    || !/^[A-Za-z0-9_-]{43}$/.test(binding)
  ) {
    return false;
  }
  return bindDraftIdToExactWindow(kind, opaqueId, window) === id;
}

export function sha256Hex32(value: string): `0x${string}` {
  return `0x${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function openMandatePayload(record: Pick<
  OpenMandateRecord,
  'id' | 'type' | 'userReference' | 'tenantId' | 'agentId' | 'agentPublicKeyJwk' | 'constraints' | 'issuedAt' | 'expiresAt' | 'audience' | 'nonce'
>): Record<string, unknown> {
  return {
    vct: record.type === 'checkout' ? 'mandate.checkout.open.1' : 'mandate.payment.open.1',
    jti: record.id,
    sub: record.userReference,
    tenant_id: record.tenantId,
    agent_id: record.agentId,
    cnf: { jwk: record.agentPublicKeyJwk },
    constraints: record.constraints,
    iat: Math.floor(Date.parse(record.issuedAt) / 1000),
    exp: Math.floor(Date.parse(record.expiresAt) / 1000),
    aud: record.audience,
    nonce: record.nonce,
  };
}

export function openMandatePayloadHash(record: Parameters<typeof openMandatePayload>[0]): string {
  return sha256Base64Url(canonicalJson(openMandatePayload(record)));
}

export function freezeConstraints(constraints: OpenMandateConstraints): OpenMandateConstraints {
  return Object.freeze(structuredClone(constraints));
}
