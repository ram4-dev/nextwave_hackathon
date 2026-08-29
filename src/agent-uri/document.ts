import {
  FORBIDDEN_AGENT_URI_KEYS,
  type AgentUriDocument,
} from '../domain/types.js';
import { DomainError } from '../domain/state-machine.js';

export function buildAgentUriDocument(input: {
  name: string;
  description: string;
  resolverEndpoint: string;
  agentRegistry?: string;
  agentId?: string;
  active: boolean;
}): AgentUriDocument {
  const doc: AgentUriDocument = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: input.name,
    description: input.description,
    services: [
      {
        name: 'kya-resolver',
        endpoint: input.resolverEndpoint,
      },
    ],
    active: input.active,
  };
  if (input.agentRegistry && input.agentId) {
    doc.registrations = [
      {
        agentId: Number(input.agentId),
        agentRegistry: input.agentRegistry,
      },
    ];
  }
  assertNoPiiInAgentUri(doc);
  return doc;
}

export function assertNoPiiInAgentUri(doc: unknown): void {
  const walk = (value: unknown, path: string): void => {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (
          (FORBIDDEN_AGENT_URI_KEYS as readonly string[]).includes(k) ||
          k.toLowerCase().includes('principal') ||
          k.toLowerCase().includes('kyc') ||
          k.toLowerCase().includes('biometric')
        ) {
          throw new DomainError(`Forbidden agentURI field: ${k}`, 'PII_FORBIDDEN');
        }
        walk(v, `${path}.${k}`);
      }
    }
  };
  walk(doc, '$');
}
