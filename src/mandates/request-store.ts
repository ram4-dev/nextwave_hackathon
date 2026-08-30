import { createHash, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { DomainError } from '../domain/state-machine.js';

const opaqueId = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/, 'Opaque identifier required');
const requestSchema = z.object({
  requestId: opaqueId.optional(),
  transactionId: opaqueId,
  agentId: opaqueId,
  tenantId: opaqueId,
  prompt: z.string().min(1).max(20_000),
  /** Optional opaque reference to ciphertext stored outside the mandate DB (never the raw prompt). */
  encryptedPromptRef: opaqueId.max(512).optional(),
  receivedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export type ReceiveMandateRequestInput = z.input<typeof requestSchema>;
export type MandateRequestRecord = {
  id: string;
  transactionId: string;
  agentId: string;
  tenantId: string;
  promptHash: string;
  encryptedPromptRef?: string;
  receivedAt: string;
  status: 'received';
};

export type MandateRequestStoreInput = MandateRequestRecord;

export interface MandateRequestStore {
  /** Persist only hash (+ optional opaque encrypted ref). Never accepts plaintext prompt. */
  create(input: MandateRequestStoreInput): Promise<MandateRequestRecord>;
}

function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('base64url');
}

/** Application function called by the MCP-facing layer; it deliberately exposes no HTTP route. */
export async function receiveMandateRequest(
  store: MandateRequestStore,
  input: ReceiveMandateRequestInput,
): Promise<MandateRequestRecord> {
  let value: z.infer<typeof requestSchema>;
  try {
    value = requestSchema.parse(input);
  } catch (error) {
    throw new DomainError(`Invalid mandate request: ${(error as z.ZodError).message}`, 'MANDATE_REQUEST_INPUT');
  }
  const promptHash = hashPrompt(value.prompt);
  // Raw prompt exists only transiently above this line for hashing; it must not reach the store.
  const record: MandateRequestRecord = {
    id: value.requestId ?? `mreq_${randomUUID().replace(/-/g, '')}`,
    transactionId: value.transactionId,
    agentId: value.agentId,
    tenantId: value.tenantId,
    promptHash,
    encryptedPromptRef: value.encryptedPromptRef,
    receivedAt: value.receivedAt ?? new Date().toISOString(),
    status: 'received',
  };
  return store.create(record);
}

export class SupabaseMandateRequestStore implements MandateRequestStore {
  constructor(private readonly client: SupabaseClient) {}

  async create(input: MandateRequestStoreInput): Promise<MandateRequestRecord> {
    if ('prompt' in (input as Record<string, unknown>)) {
      throw new DomainError('Plaintext prompt must never reach the mandate request store', 'MANDATE_REQUEST_PROMPT');
    }
    const { data, error } = await this.client.rpc('create_mandate_request', {
      p_id: input.id,
      p_transaction_id: input.transactionId,
      p_agent_id: input.agentId,
      p_tenant_id: input.tenantId,
      p_prompt_hash: input.promptHash,
      p_encrypted_prompt_ref: input.encryptedPromptRef ?? null,
      p_received_at: input.receivedAt,
    }).single();
    if (error || !data) {
      throw new DomainError(`Supabase mandate request write failed: ${error?.message ?? 'empty result'}`, 'MANDATE_REQUEST_STORE');
    }
    const row = data as {
      id: string;
      transaction_id: string;
      agent_id: string;
      tenant_id: string;
      prompt_hash: string;
      encrypted_prompt_ref: string | null;
      received_at: string;
    };
    return {
      id: row.id,
      transactionId: row.transaction_id,
      agentId: row.agent_id,
      tenantId: row.tenant_id,
      promptHash: row.prompt_hash,
      encryptedPromptRef: row.encrypted_prompt_ref ?? undefined,
      receivedAt: row.received_at,
      status: 'received',
    };
  }
}

export function createSupabaseMandateRequestStore(env: NodeJS.ProcessEnv = process.env): SupabaseMandateRequestStore {
  const url = env.SUPABASE_URL;
  const secretKey = env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey || url.includes('<') || secretKey.includes('<')) {
    throw new DomainError('SUPABASE_URL and SUPABASE_SECRET_KEY must be configured', 'SUPABASE_CONFIG');
  }
  return new SupabaseMandateRequestStore(createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } }));
}

export class InMemoryMandateRequestStore implements MandateRequestStore {
  private readonly records = new Map<string, MandateRequestRecord>();

  async create(input: MandateRequestStoreInput): Promise<MandateRequestRecord> {
    if ('prompt' in (input as Record<string, unknown>)) {
      throw new DomainError('Plaintext prompt must never reach the mandate request store', 'MANDATE_REQUEST_PROMPT');
    }
    if (this.records.has(input.id) || [...this.records.values()].some((item) => item.transactionId === input.transactionId)) {
      throw new DomainError('Mandate request already exists', 'MANDATE_REQUEST_DUPLICATE');
    }
    const record = structuredClone(input);
    this.records.set(record.id, record);
    return structuredClone(record);
  }

  /** Test helper: inspect stored records without exposing a prompt field. */
  debugDump(): MandateRequestRecord[] {
    return [...this.records.values()].map((item) => structuredClone(item));
  }
}
