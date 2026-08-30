import { calculateJwkThumbprint } from 'jose';
import { DomainError } from '../domain/state-machine.js';
import type { Repository } from '../persistence/repository.js';

export type AgentTrustDecision = {
  allowed: boolean;
  agentStatus: string;
  attestationStatus: 'valid' | 'expired' | 'revoked' | 'missing';
  keyBindingStatus: 'bound' | 'mismatch' | 'missing';
  riskLevel: 'low' | 'medium' | 'high' | 'unknown';
  revocationStatus: 'active' | 'revoked' | 'suspended';
  expiresAt?: string;
  policyVersion: string;
  reasons: string[];
};

export interface AgentTrustVerifier {
  verifyAgent(input: {
    agentId: string;
    tenantId: string;
    keyId: string;
    publicKeyJwk: JsonWebKey;
    action: 'autonomous_payment_mandate';
  }): Promise<AgentTrustDecision>;
}

/** Bridges AP2 policy enforcement to KYA's enrollment and credential evidence. */
export class KyaAgentTrustVerifier implements AgentTrustVerifier {
  constructor(
    private readonly repo: Repository,
    private readonly options: {
      policyVersion: string;
      isTenantAuthorized?: (input: { agentUuid: string; tenantId: string }) => Promise<boolean> | boolean;
      riskLevel?: (input: { agentUuid: string; tenantId: string }) => Promise<'low' | 'medium' | 'high'> | 'low' | 'medium' | 'high';
      now?: () => Date;
    },
  ) {}

  async verifyAgent(input: Parameters<AgentTrustVerifier['verifyAgent']>[0]): Promise<AgentTrustDecision> {
    const now = this.options.now?.() ?? new Date();
    const store = await this.repo.getStore();
    const agent = store.enrollments.find((item) => item.agentUuid === input.agentId || item.agentId === input.agentId);
    const reasons: string[] = [];
    if (!agent) {
      return {
        allowed: false, agentStatus: 'missing', attestationStatus: 'missing', keyBindingStatus: 'missing',
        riskLevel: 'unknown', revocationStatus: 'revoked', policyVersion: this.options.policyVersion, reasons: ['AGENT_NOT_FOUND'],
      };
    }
    // Credential must belong to the same principal and thumbprint as the enrollment — never any active agent credential.
    const credential = store.credentials.find(
      (item) => item.agentUuid === agent.agentUuid
        && item.principalId === agent.principalId
        && item.thumbprint === agent.thumbprint
        && item.status === 'active',
    );
    const attestationStatus = !credential
      ? 'missing'
      : new Date(credential.expiresAt).getTime() <= now.getTime() ? 'expired' : 'valid';
    if (agent.status !== 'bound') reasons.push(agent.status === 'revoked' ? 'AGENT_REVOKED' : 'AGENT_NOT_ACTIVE');
    if (attestationStatus !== 'valid') reasons.push(`ATTESTATION_${attestationStatus.toUpperCase()}`);
    const expectedThumbprint = agent.thumbprint;
    const providedThumbprint = await calculateJwkThumbprint(input.publicKeyJwk, 'sha256').catch(() => 'invalid');
    const keyBindingStatus = expectedThumbprint === providedThumbprint ? 'bound' : 'mismatch';
    if (keyBindingStatus !== 'bound') reasons.push('AGENT_KEY_MISMATCH');
    const tenantAllowed = this.options.isTenantAuthorized
      ? await this.options.isTenantAuthorized({ agentUuid: agent.agentUuid, tenantId: input.tenantId })
      : false;
    if (!tenantAllowed) reasons.push('TENANT_NOT_AUTHORIZED');
    const riskLevel = this.options.riskLevel
      ? await this.options.riskLevel({ agentUuid: agent.agentUuid, tenantId: input.tenantId })
      : 'high';
    if (riskLevel !== 'low') reasons.push('RISK_NOT_LOW');
    return {
      allowed: reasons.length === 0,
      agentStatus: agent.status,
      attestationStatus,
      keyBindingStatus,
      riskLevel,
      revocationStatus: agent.status === 'revoked' ? 'revoked' : agent.status === 'suspended' ? 'suspended' : 'active',
      expiresAt: credential?.expiresAt,
      policyVersion: this.options.policyVersion,
      reasons,
    };
  }
}

export function assertTrustedAgent(decision: AgentTrustDecision): void {
  if (!decision.allowed) throw new DomainError(`Agent autonomy denied: ${decision.reasons.join(',')}`, 'AGENT_TRUST_DENIED');
}
