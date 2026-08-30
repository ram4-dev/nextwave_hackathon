import { getAddress } from 'viem';
import type { AppConfig } from '../config/env.js';
import {
  applyKycStatus,
  canAuthorizeAgent,
  DomainError,
  needsKyc,
  transitionEnrollment,
} from '../domain/state-machine.js';
import type {
  AgentEnrollment,
  KeystoreProviderKind,
  Principal,
} from '../domain/types.js';
import {
  fingerprintDisplay,
  generateDeviceCode,
  intentHash,
  sanitizePublicJwk,
  thumbprintFromJwk,
  verifyChallengeSignature,
} from '../crypto/local-agent-key.js';
import { issueKyaCredential } from '../credentials/jws.js';
import { createKycAdapters, type KycAdapter, type NormalizedKycWebhook } from '../kyc/index.js';
import { assertNormalizedKycOnly } from '../kyc/types.js';
import { newId, type Repository } from '../persistence/repository.js';
import { buildAgentUriDocument } from '../agent-uri/document.js';
import {
  agentRegistryRef,
  assertRegistryReadyForChain,
  buildRegisterTransaction,
  demoRegisterResult,
  hashRegisterCall,
  readOwnerOf,
  resolveRegistryAddress,
} from '../registry/identity.js';
import { applyRegisteredEvent, applyTransferEvent } from '../registry/events.js';

export type OwnerOfReader = (args: {
  registry: `0x${string}`;
  agentId: bigint;
}) => Promise<`0x${string}`>;

export class CeremonyService {
  readonly kyc: { primary: KycAdapter; byName: Record<string, KycAdapter> };
  private ownerOfReader?: OwnerOfReader;
  private registryReadyClient?: Parameters<typeof assertRegistryReadyForChain>[2];

  constructor(
    private readonly repo: Repository,
    private readonly config: AppConfig,
    opts?: {
      ownerOfReader?: OwnerOfReader;
      registryReadyClient?: Parameters<typeof assertRegistryReadyForChain>[2];
    },
  ) {
    this.kyc = createKycAdapters(config);
    this.ownerOfReader = opts?.ownerOfReader;
    this.registryReadyClient = opts?.registryReadyClient;
  }

  /** Inject registry deps for deterministic tests. */
  setOwnerOfReader(reader: OwnerOfReader | undefined): void {
    this.ownerOfReader = reader;
  }

  async findOrCreatePrincipal(ownerAddress: `0x${string}`): Promise<Principal> {
    return this.repo.withLock(async (store) => {
      const existing = store.principals.find(
        (p) => p.ownerAddress.toLowerCase() === ownerAddress.toLowerCase(),
      );
      if (existing) return existing;
      const principal: Principal = {
        id: newId('prin'),
        ownerAddress: ownerAddress.toLowerCase() as `0x${string}`,
        kycStatus: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.principals.push(principal);
      return principal;
    });
  }

  async startEnrollment(input: {
    publicJwk: JsonWebKey;
    keystoreProvider: KeystoreProviderKind;
  }): Promise<{
    agentUuid: string;
    deviceCode: string;
    thumbprint: string;
    fingerprintDisplay: string;
    agentUriUrl: string;
  }> {
    if ((input.publicJwk as Record<string, unknown>).d) {
      throw new DomainError('Private key material rejected', 'PII_FORBIDDEN');
    }
    const publicJwk = sanitizePublicJwk({ ...input.publicJwk });
    const thumbprint = await thumbprintFromJwk(publicJwk);
    const agentUuid = newId('agent');
    const deviceCode = generateDeviceCode();
    const agentUriPath = `/v1/agents/${agentUuid}/agent-uri.json`;
    const enrollment: AgentEnrollment = {
      agentUuid,
      deviceCode,
      status: 'awaiting_human',
      publicJwk,
      thumbprint,
      keystoreProvider: input.keystoreProvider,
      agentUriPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.repo.withLock(async (store) => {
      store.enrollments.push(enrollment);
    });
    return {
      agentUuid,
      deviceCode,
      thumbprint,
      fingerprintDisplay: fingerprintDisplay(thumbprint),
      agentUriUrl: `${this.config.PUBLIC_BASE_URL}${agentUriPath}`,
    };
  }

  async getEnrollmentAuthorized(
    agentUuid: string,
    ownerAddress: `0x${string}`,
  ): Promise<AgentEnrollment> {
    const store = await this.repo.getStore();
    const enrollment = store.enrollments.find((e) => e.agentUuid === agentUuid);
    if (!enrollment) throw new DomainError('Enrollment not found', 'NOT_FOUND');
    const principal = enrollment.principalId
      ? store.principals.find((p) => p.id === enrollment.principalId)
      : undefined;
    const isOwner =
      (principal &&
        principal.ownerAddress.toLowerCase() === ownerAddress.toLowerCase()) ||
      (enrollment.owner &&
        enrollment.owner.toLowerCase() === ownerAddress.toLowerCase());
    if (!isOwner) {
      throw new DomainError('Forbidden', 'FORBIDDEN');
    }
    return enrollment;
  }

  /** Bind a distinct, public-only AP2 mandate-signing key to an active KYA agent. */
  async bindMandateSigningKey(
    agentUuid: string,
    ownerAddress: `0x${string}`,
    input: { publicJwk: JsonWebKey; keyId: string },
  ): Promise<AgentEnrollment> {
    if (!input.keyId.trim() || input.keyId.length > 300) throw new DomainError('Invalid mandate signing key ID', 'MANDATE_SIGNING_KEY');
    if ((input.publicJwk as Record<string, unknown>).d) throw new DomainError('Private mandate key material rejected', 'PRIVATE_KEY_PERSISTENCE');
    const publicJwk = sanitizePublicJwk({ ...input.publicJwk });
    const thumbprint = await thumbprintFromJwk(publicJwk);
    return this.repo.withLock(async (store) => {
      const enrollment = store.enrollments.find((item) => item.agentUuid === agentUuid);
      if (!enrollment) throw new DomainError('Enrollment not found', 'NOT_FOUND');
      if (enrollment.status !== 'bound') throw new DomainError('Agent must be bound before a mandate key can be delegated', 'NOT_BOUND');
      if (thumbprint === enrollment.thumbprint) throw new DomainError('Mandate signing key must be distinct from the agent identity key', 'MANDATE_SIGNING_KEY_SEPARATION');
      const principal = store.principals.find((item) => item.id === enrollment.principalId);
      if (!principal || principal.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase()) throw new DomainError('Principal mismatch', 'FORBIDDEN');
      if (!canAuthorizeAgent(principal)) throw new DomainError('Principal KYC not active', 'KYC_REQUIRED');
      enrollment.mandateSigningPublicJwk = publicJwk;
      enrollment.mandateSigningThumbprint = thumbprint;
      enrollment.mandateSigningKeyId = input.keyId;
      enrollment.mandateSigningBoundAt = new Date().toISOString();
      enrollment.updatedAt = new Date().toISOString();
      return structuredClone(enrollment);
    });
  }

  /** Public resolver — no PII, principalId, or deviceCode. */
  async resolvePublic(query: {
    agentUuid?: string;
    agentRegistry?: string;
    agentId?: string;
  }): Promise<{
    agentUuid?: string;
    status: string;
    agentRegistry?: string;
    agentId?: string;
    owner?: string;
    thumbprint?: string;
    active: boolean;
  }> {
    const store = await this.repo.getStore();
    let enrollment: AgentEnrollment | undefined;
    if (query.agentUuid) {
      enrollment = store.enrollments.find((e) => e.agentUuid === query.agentUuid);
    } else if (query.agentRegistry && query.agentId) {
      enrollment = store.enrollments.find(
        (e) =>
          e.agentRegistry?.toLowerCase() === query.agentRegistry!.toLowerCase() &&
          e.agentId === query.agentId,
      );
    }
    if (!enrollment) throw new DomainError('Not found', 'NOT_FOUND');
    return {
      agentUuid: enrollment.agentUuid,
      status: enrollment.status,
      agentRegistry: enrollment.agentRegistry,
      agentId: enrollment.agentId,
      owner: enrollment.owner,
      thumbprint: enrollment.thumbprint,
      active: enrollment.status === 'bound',
    };
  }

  async attachHuman(
    agentUuid: string,
    ownerAddress: `0x${string}`,
  ): Promise<{
    enrollment: AgentEnrollment;
    principal: Principal;
    needsKyc: boolean;
  }> {
    const principal = await this.findOrCreatePrincipal(ownerAddress);
    return this.repo.withLock(async (store) => {
      const idx = store.enrollments.findIndex((e) => e.agentUuid === agentUuid);
      if (idx < 0) throw new DomainError('Enrollment not found', 'NOT_FOUND');
      let enrollment = store.enrollments[idx]!;
      const attachable = new Set([
        'awaiting_human',
        'awaiting_kyc',
        'awaiting_fingerprint',
      ]);
      if (!attachable.has(enrollment.status)) {
        throw new DomainError('Enrollment not awaiting human', 'INVALID_TRANSITION');
      }
      enrollment = {
        ...enrollment,
        principalId: principal.id,
        updatedAt: new Date().toISOString(),
      };
      const kycNeeded = needsKyc(principal);
      if (enrollment.status === 'awaiting_human' || enrollment.status === 'awaiting_kyc') {
        const target = kycNeeded ? 'awaiting_kyc' : 'awaiting_fingerprint';
        if (enrollment.status !== target) {
          enrollment = transitionEnrollment(enrollment, target);
        } else {
          enrollment = { ...enrollment, updatedAt: new Date().toISOString() };
        }
      }
      store.enrollments[idx] = enrollment;
      return { enrollment, principal, needsKyc: kycNeeded };
    });
  }

  async startKyc(
    ownerAddress: `0x${string}`,
    providerName?: string,
  ): Promise<{ sessionId: string; verificationUrl: string; provider: string; demo: boolean }> {
    if (this.config.KYA_MODE === 'live') {
      if (!providerName || providerName === 'demo') {
        // Default live provider is Didit; explicit demo is forbidden.
        if (providerName === 'demo') {
          throw new DomainError('Demo KYC forbidden in live mode', 'KYC_DEMO_FORBIDDEN');
        }
      }
    }
    if (providerName === 'demo' && this.config.KYA_MODE !== 'demo') {
      throw new DomainError('Demo KYC forbidden in live mode', 'KYC_DEMO_FORBIDDEN');
    }

    const principal = await this.findOrCreatePrincipal(ownerAddress);
    if (!needsKyc(principal)) {
      throw new DomainError('Active KYC already present', 'KYC_NOT_NEEDED');
    }

    let adapter: KycAdapter;
    if (this.config.KYA_MODE === 'demo') {
      adapter = this.kyc.byName.demo!;
    } else {
      const name = providerName ?? 'didit';
      if (name === 'demo' || !this.kyc.byName[name]) {
        throw new DomainError(
          name === 'demo'
            ? 'Demo KYC forbidden in live mode'
            : `Unknown KYC provider ${name}`,
          name === 'demo' ? 'KYC_DEMO_FORBIDDEN' : 'NOT_FOUND',
        );
      }
      adapter = this.kyc.byName[name]!;
    }

    const created = await adapter.createSession({
      vendorData: principal.id,
      callbackUrl: `${this.config.PUBLIC_BASE_URL}/v1/kyc/callback`,
    });

    await this.repo.withLock(async (store) => {
      store.kycSessions.push({
        id: newId('kyc'),
        provider: adapter.name,
        providerSessionId: created.providerSessionId,
        principalId: principal.id,
        ownerAddress,
        status: 'pending',
        webhookEventIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    return {
      sessionId: created.providerSessionId,
      verificationUrl: created.verificationUrl,
      provider: adapter.name,
      demo: adapter.name === 'demo',
    };
  }

  async handleKycWebhook(
    provider: string,
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): Promise<{ normalized: NormalizedKycWebhook; idempotent: boolean }> {
    if (this.config.KYA_MODE === 'live' && provider === 'demo') {
      throw new DomainError('Demo KYC webhook forbidden in live mode', 'KYC_DEMO_FORBIDDEN');
    }
    const adapter = this.kyc.byName[provider];
    if (!adapter) throw new DomainError(`Unknown KYC provider ${provider}`, 'NOT_FOUND');
    const normalized = await adapter.verifyWebhook(headers, rawBody);
    assertNormalizedKycOnly(normalized);

    let idempotent = false;
    await this.repo.withLock(async (store) => {
      const session = store.kycSessions.find(
        (s) => s.providerSessionId === normalized.providerSessionId,
      );
      if (!session) {
        throw new DomainError('Unknown KYC session', 'NOT_FOUND');
      }
      if (session.webhookEventIds.includes(normalized.eventId)) {
        idempotent = true;
        return;
      }
      session.webhookEventIds.push(normalized.eventId);
      session.status = normalized.status;
      session.assuranceLevel = normalized.assuranceLevel;
      session.updatedAt = new Date().toISOString();

      if (session.principalId) {
        const pIdx = store.principals.findIndex((p) => p.id === session.principalId);
        if (pIdx >= 0) {
          store.principals[pIdx] = applyKycStatus(store.principals[pIdx]!, normalized.status, {
            provider: normalized.provider,
            sessionRef: normalized.providerSessionId,
            assuranceLevel: normalized.assuranceLevel,
            ttlDays: this.config.KYC_TTL_DAYS,
          });
        }
      }

      if (normalized.status === 'verified' && session.principalId) {
        for (let i = 0; i < store.enrollments.length; i++) {
          const e = store.enrollments[i]!;
          if (e.principalId === session.principalId && e.status === 'awaiting_kyc') {
            store.enrollments[i] = transitionEnrollment(e, 'awaiting_fingerprint');
          }
        }
      }
    });

    return { normalized, idempotent };
  }

  async approveFingerprint(
    agentUuid: string,
    ownerAddress: `0x${string}`,
    expectedThumbprint: string,
  ): Promise<AgentEnrollment> {
    return this.repo.withLock(async (store) => {
      const idx = store.enrollments.findIndex((e) => e.agentUuid === agentUuid);
      if (idx < 0) throw new DomainError('Enrollment not found', 'NOT_FOUND');
      let enrollment = store.enrollments[idx]!;
      if (enrollment.thumbprint !== expectedThumbprint) {
        throw new DomainError('Fingerprint mismatch', 'FINGERPRINT');
      }
      const principal = store.principals.find((p) => p.id === enrollment.principalId);
      if (!principal || principal.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase()) {
        throw new DomainError('Principal mismatch', 'FORBIDDEN');
      }
      if (!canAuthorizeAgent(principal)) {
        throw new DomainError('Principal KYC not active', 'KYC_REQUIRED');
      }
      if (enrollment.status === 'suspended') {
        enrollment = transitionEnrollment(enrollment, 'awaiting_fingerprint');
      }
      if (enrollment.status !== 'awaiting_fingerprint') {
        throw new DomainError('Not awaiting fingerprint', 'INVALID_TRANSITION');
      }

      // Key rotation / rebind: Agent ID already exists → return to bound (no new mint).
      const alreadyOnChain = Boolean(enrollment.agentId && enrollment.agentRegistry);
      if (alreadyOnChain) {
        enrollment = transitionEnrollment(enrollment, 'bound', {
          fingerprintApprovedAt: new Date().toISOString(),
          owner: getAddress(ownerAddress),
        });
      } else {
        enrollment = transitionEnrollment(enrollment, 'awaiting_register', {
          fingerprintApprovedAt: new Date().toISOString(),
        });
      }
      store.enrollments[idx] = enrollment;
      return enrollment;
    });
  }

  async prepareRegister(agentUuid: string, ownerAddress: `0x${string}`, chainId = 84532) {
    const store = await this.repo.getStore();
    const enrollment = store.enrollments.find((e) => e.agentUuid === agentUuid);
    if (!enrollment) throw new DomainError('Enrollment not found', 'NOT_FOUND');
    if (enrollment.status !== 'awaiting_register' && enrollment.status !== 'awaiting_onchain') {
      throw new DomainError('Enrollment not ready to register', 'INVALID_TRANSITION');
    }
    const principal = store.principals.find((p) => p.id === enrollment.principalId);
    if (!principal || principal.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase()) {
      throw new DomainError('Principal mismatch', 'FORBIDDEN');
    }

    let registry: `0x${string}`;
    if (this.config.KYA_MODE === 'live') {
      const ready = await assertRegistryReadyForChain(
        this.config,
        chainId,
        this.registryReadyClient,
      );
      registry = ready.registry;
    } else if (chainId === 8453) {
      // Demo never hardcodes getVersionOk/codePresent=true for mainnet.
      throw new DomainError('Mainnet register not available in demo mode', 'MAINNET_GATE');
    } else {
      registry = resolveRegistryAddress(this.config, chainId);
    }

    const agentURI = `${this.config.PUBLIC_BASE_URL}${enrollment.agentUriPath}`;
    const agentRegistry = agentRegistryRef(chainId, registry);

    await this.repo.withLock(async (s) => {
      const e = s.enrollments.find((x) => x.agentUuid === agentUuid)!;
      e.agentRegistry = agentRegistry;
      if (e.status === 'awaiting_register') {
        const next = transitionEnrollment(e, 'awaiting_onchain');
        Object.assign(e, next);
      }
    });

    if (this.config.KYA_MODE === 'demo') {
      const demo = demoRegisterResult({
        chainId,
        registry,
        owner: ownerAddress,
        agentURI,
      });
      return {
        mode: 'demo' as const,
        agentURI,
        registry,
        chainId,
        register: null,
        demo,
      };
    }

    const callHash = hashRegisterCall({ chainId, registry, agentURI });
    const register = buildRegisterTransaction({
      chainId,
      registry,
      agentURI,
      from: ownerAddress,
    });

    return {
      mode: 'live' as const,
      agentURI,
      registry,
      chainId,
      register,
      demo: null,
      callHash,
      note: 'Submit the exact register(agentURI) transaction with the authenticated browser wallet. KYA is never msg.sender.',
    };
  }

  async confirmDemoRegistration(
    agentUuid: string,
    ownerAddress: `0x${string}`,
  ): Promise<{ token: string; agentId: string; agentRegistry: string }> {
    if (this.config.KYA_MODE !== 'demo') {
      throw new DomainError('Demo confirm only in demo mode', 'MODE');
    }
    const prepared = await this.prepareRegister(agentUuid, ownerAddress, 84532);
    const demo = prepared.demo!;
    await applyRegisteredEvent(this.repo, 84532, {
      agentId: demo.agentId,
      agentURI: demo.agentURI,
      owner: demo.owner,
      txHash: '0xdemoregister0000000000000000000000000000000000000000000000000001',
      logIndex: 0,
      blockNumber: 1n,
    }, {
      registryAddress: prepared.registry,
      publicBaseUrl: this.config.PUBLIC_BASE_URL,
      currentBlock: 1n,
      confirmations: 1,
    });

    await this.repo.withLock(async (store) => {
      const e = store.enrollments.find((x) => x.agentUuid === agentUuid);
      if (e) {
        e.agentId = demo.agentId;
        e.agentRegistry = demo.agentRegistry;
        e.owner = demo.owner;
        e.status = 'bound';
        e.updatedAt = new Date().toISOString();
      }
    });

    const store = await this.repo.getStore();
    const enrollment = store.enrollments.find((e) => e.agentUuid === agentUuid)!;
    const { token } = await issueKyaCredential(this.repo, this.config, {
      agentUuid,
      principalId: enrollment.principalId!,
      thumbprint: enrollment.thumbprint,
      agentRegistry: enrollment.agentRegistry!,
      agentId: enrollment.agentId!,
      owner: enrollment.owner!,
    });

    return {
      token,
      agentId: enrollment.agentId!,
      agentRegistry: enrollment.agentRegistry!,
    };
  }

  /**
   * Authenticated credential claim for a bound live enrollment.
   * Requires active Principal KYC, session owner, and on-chain ownerOf match.
   */
  async claimCredential(
    agentUuid: string,
    ownerAddress: `0x${string}`,
  ): Promise<{ token: string; agentId: string; agentRegistry: string; jti: string }> {
    const store = await this.repo.getStore();
    const enrollment = store.enrollments.find((e) => e.agentUuid === agentUuid);
    if (!enrollment) throw new DomainError('Enrollment not found', 'NOT_FOUND');
    if (enrollment.status !== 'bound') {
      throw new DomainError('Enrollment not bound', 'NOT_BOUND');
    }
    if (!enrollment.agentId || !enrollment.agentRegistry) {
      throw new DomainError('Missing on-chain agent reference', 'NOT_BOUND');
    }
    const principal = store.principals.find((p) => p.id === enrollment.principalId);
    if (!principal || principal.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase()) {
      throw new DomainError('Principal mismatch', 'FORBIDDEN');
    }
    if (!canAuthorizeAgent(principal)) {
      throw new DomainError('Principal KYC not active', 'KYC_REQUIRED');
    }

    const onChainOwner = await this.readOwnerOfForEnrollment(enrollment);
    if (onChainOwner.toLowerCase() !== ownerAddress.toLowerCase()) {
      throw new DomainError('On-chain owner mismatch', 'OWNER_MISMATCH');
    }
    if (
      enrollment.owner &&
      enrollment.owner.toLowerCase() !== onChainOwner.toLowerCase()
    ) {
      throw new DomainError('Enrollment owner out of sync', 'OWNER_MISMATCH');
    }

    const { token, record } = await issueKyaCredential(this.repo, this.config, {
      agentUuid,
      principalId: principal.id,
      thumbprint: enrollment.thumbprint,
      agentRegistry: enrollment.agentRegistry,
      agentId: enrollment.agentId,
      owner: getAddress(ownerAddress),
    });

    return {
      token,
      agentId: enrollment.agentId,
      agentRegistry: enrollment.agentRegistry,
      jti: record.jti,
    };
  }

  private async readOwnerOfForEnrollment(
    enrollment: AgentEnrollment,
  ): Promise<`0x${string}`> {
    if (!enrollment.agentId || !enrollment.agentRegistry) {
      throw new DomainError('Missing agent registry reference', 'NOT_BOUND');
    }
    const parts = enrollment.agentRegistry.split(':');
    const registry = parts[2] as `0x${string}` | undefined;
    if (!registry) throw new DomainError('Invalid agentRegistry', 'AGENT_REGISTRY');
    const agentId = BigInt(enrollment.agentId);

    if (this.ownerOfReader) {
      return this.ownerOfReader({ registry: getAddress(registry), agentId });
    }
    if (this.config.KYA_MODE === 'demo') {
      return getAddress(enrollment.owner ?? ('0x0000000000000000000000000000000000000001' as const));
    }
    const { createRegistryPublicClient } = await import('../registry/identity.js');
    const chainId = Number(parts[1]);
    if (chainId !== 84532 && chainId !== 8453) {
      throw new DomainError('Unsupported chain in agentRegistry', 'CHAIN_ID');
    }
    const client = createRegistryPublicClient(this.config, chainId);
    return readOwnerOf(client, getAddress(registry), agentId);
  }

  async getAgentUriDocument(agentUuid: string) {
    const store = await this.repo.getStore();
    const enrollment = store.enrollments.find((e) => e.agentUuid === agentUuid);
    if (!enrollment) throw new DomainError('Not found', 'NOT_FOUND');
    return buildAgentUriDocument({
      name: `KYA Local Agent ${agentUuid.slice(-8)}`,
      description: 'Local buyer agent identity registration (no PII).',
      resolverEndpoint: `${this.config.PUBLIC_BASE_URL}/v1/resolve`,
      agentRegistry: enrollment.agentRegistry,
      agentId: enrollment.agentId,
      active: enrollment.status === 'bound',
    });
  }

  async createChallenge(agentUuid: string, intent: unknown) {
    const store = await this.repo.getStore();
    const enrollment = store.enrollments.find((e) => e.agentUuid === agentUuid);
    if (!enrollment || enrollment.status !== 'bound') {
      throw new DomainError('Agent not bound', 'NOT_BOUND');
    }
    const nonce = newId('chal').replace('chal_', '');
    const timestamp = new Date().toISOString();
    const intent_hash = intentHash(intent);
    const expiresAt = new Date(
      Date.now() + this.config.CHALLENGE_TTL_SECONDS * 1000,
    ).toISOString();
    await this.repo.withLock(async (s) => {
      s.nonces.push({
        nonce,
        purpose: 'challenge',
        createdAt: new Date().toISOString(),
        expiresAt,
        audience: this.config.KYA_AUDIENCE,
        agentUuid,
        intentHash: intent_hash,
        challengeTimestamp: timestamp,
      });
    });
    return {
      nonce,
      audience: this.config.KYA_AUDIENCE,
      timestamp,
      intent_hash,
      expiresAt,
    };
  }

  async verifyChallenge(
    agentUuid: string,
    response: {
      nonce: string;
      audience: string;
      timestamp: string;
      intent_hash: string;
      signature: string;
    },
  ) {
    const store = await this.repo.getStore();
    const enrollment = store.enrollments.find((e) => e.agentUuid === agentUuid);
    if (!enrollment || enrollment.status !== 'bound') {
      throw new DomainError('Agent not bound', 'NOT_BOUND');
    }

    const activeCred = store.credentials.find(
      (c) => c.agentUuid === agentUuid && c.status === 'active',
    );
    if (!activeCred) throw new DomainError('No active credential', 'JWT_STATUS');

    // Fail closed: on-chain owner must match enrollment/principal.
    if (enrollment.agentId && enrollment.agentRegistry) {
      const onChainOwner = await this.readOwnerOfForEnrollment(enrollment);
      const principal = store.principals.find((p) => p.id === enrollment.principalId);
      const expected =
        enrollment.owner?.toLowerCase() ?? principal?.ownerAddress.toLowerCase();
      if (!expected || onChainOwner.toLowerCase() !== expected) {
        throw new DomainError('On-chain owner mismatch', 'OWNER_MISMATCH');
      }
    }

    const nonceRecord = store.nonces.find(
      (x) => x.nonce === response.nonce && x.purpose === 'challenge',
    );
    if (!nonceRecord) throw new DomainError('Unknown challenge nonce', 'CHALLENGE');
    if (nonceRecord.consumedAt) {
      throw new DomainError('Challenge replay', 'CHALLENGE_REPLAY');
    }
    if (new Date(nonceRecord.expiresAt).getTime() <= Date.now()) {
      throw new DomainError('Challenge expired', 'CHALLENGE_EXPIRED');
    }
    if (nonceRecord.agentUuid !== agentUuid) {
      throw new DomainError('Challenge agent mismatch', 'CHALLENGE');
    }

    const storedAudience = nonceRecord.audience;
    const storedIntent = nonceRecord.intentHash;
    const storedTimestamp = nonceRecord.challengeTimestamp;
    if (!storedAudience || !storedIntent || !storedTimestamp) {
      throw new DomainError('Challenge missing bound fields', 'CHALLENGE');
    }
    if (storedAudience !== this.config.KYA_AUDIENCE) {
      throw new DomainError('Challenge audience config mismatch', 'CHALLENGE_AUDIENCE');
    }
    if (response.audience !== storedAudience) {
      throw new DomainError('Challenge audience mismatch', 'CHALLENGE_AUDIENCE');
    }
    if (response.intent_hash !== storedIntent) {
      throw new DomainError('Challenge intent_hash mismatch', 'CHALLENGE_INTENT');
    }
    if (response.timestamp !== storedTimestamp) {
      throw new DomainError('Challenge timestamp mismatch', 'CHALLENGE_TIMESTAMP');
    }

    const bound = {
      nonce: response.nonce,
      audience: storedAudience,
      timestamp: storedTimestamp,
      intent_hash: storedIntent,
    };
    const ok = await verifyChallengeSignature(
      enrollment.publicJwk,
      response.signature,
      bound,
    );
    if (!ok) throw new DomainError('Invalid challenge signature', 'CHALLENGE_SIG');

    await this.repo.withLock(async (s) => {
      const n = s.nonces.find(
        (x) => x.nonce === response.nonce && x.purpose === 'challenge',
      );
      if (!n) throw new DomainError('Unknown challenge nonce', 'CHALLENGE');
      if (n.consumedAt) throw new DomainError('Challenge replay', 'CHALLENGE_REPLAY');
      if (new Date(n.expiresAt).getTime() <= Date.now()) {
        throw new DomainError('Challenge expired', 'CHALLENGE_EXPIRED');
      }
      if (n.agentUuid !== agentUuid) {
        throw new DomainError('Challenge agent mismatch', 'CHALLENGE');
      }
      if (
        n.audience !== storedAudience ||
        n.intentHash !== storedIntent ||
        n.challengeTimestamp !== storedTimestamp ||
        n.audience !== this.config.KYA_AUDIENCE
      ) {
        throw new DomainError('Challenge binding changed', 'CHALLENGE');
      }
      const stillActive = s.credentials.find(
        (c) => c.agentUuid === agentUuid && c.status === 'active',
      );
      if (!stillActive) throw new DomainError('No active credential', 'JWT_STATUS');
      n.consumedAt = new Date().toISOString();
    });

    return {
      ok: true as const,
      thumbprint: enrollment.thumbprint,
      credentialId: activeCred.jti,
    };
  }

  /**
   * Key rotation / device-loss: retain agentRegistry+agentId, revoke credentials,
   * require new fingerprint approval, return to bound without minting a new Agent ID.
   */
  async rotateKey(
    agentUuid: string,
    ownerAddress: `0x${string}`,
    newPublicJwk: JsonWebKey,
    keystoreProvider: KeystoreProviderKind,
  ) {
    const publicJwk = sanitizePublicJwk({ ...newPublicJwk });
    const thumbprint = await thumbprintFromJwk(publicJwk);
    return this.repo.withLock(async (store) => {
      const idx = store.enrollments.findIndex((e) => e.agentUuid === agentUuid);
      if (idx < 0) throw new DomainError('Not found', 'NOT_FOUND');
      const e = store.enrollments[idx]!;
      const principal = store.principals.find((p) => p.id === e.principalId);
      if (!principal || principal.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase()) {
        throw new DomainError('Forbidden', 'FORBIDDEN');
      }
      if (!e.agentId || !e.agentRegistry) {
        throw new DomainError('Rotation requires existing Agent ID', 'NOT_BOUND');
      }
      for (const c of store.credentials) {
        if (c.agentUuid === agentUuid && (c.status === 'active' || c.status === 'suspended')) {
          c.status = 'revoked';
        }
      }
      // Retain canonical registry+agentId; require explicit fingerprint approval.
      store.enrollments[idx] = {
        ...e,
        publicJwk,
        thumbprint,
        keystoreProvider,
        status: 'awaiting_fingerprint',
        fingerprintApprovedAt: undefined,
        // agentId + agentRegistry preserved
        updatedAt: new Date().toISOString(),
      };
      return store.enrollments[idx]!;
    });
  }

  async revokeAgent(agentUuid: string, ownerAddress: `0x${string}`) {
    return this.repo.withLock(async (store) => {
      const idx = store.enrollments.findIndex((e) => e.agentUuid === agentUuid);
      if (idx < 0) throw new DomainError('Not found', 'NOT_FOUND');
      const e = store.enrollments[idx]!;
      const principal = store.principals.find((p) => p.id === e.principalId);
      if (!principal || principal.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase()) {
        throw new DomainError('Forbidden', 'FORBIDDEN');
      }
      store.enrollments[idx] = {
        ...e,
        status: 'revoked',
        updatedAt: new Date().toISOString(),
      };
      for (const c of store.credentials) {
        if (c.agentUuid === agentUuid && c.status !== 'revoked') c.status = 'revoked';
      }
      return store.enrollments[idx]!;
    });
  }

  /**
   * Transfer rebind: require suspended, current on-chain owner/session match,
   * active KYC for new Principal (no re-KYC if already active), explicit fingerprint
   * approval, update principalId, keep same registry+agentId, revoke old credentials.
   */
  async rebindAfterTransfer(
    agentUuid: string,
    ownerAddress: `0x${string}`,
    thumbprint: string,
  ): Promise<AgentEnrollment> {
    const store = await this.repo.getStore();
    const enrollment = store.enrollments.find((e) => e.agentUuid === agentUuid);
    if (!enrollment) throw new DomainError('Enrollment not found', 'NOT_FOUND');
    if (enrollment.status !== 'suspended') {
      throw new DomainError('Enrollment must be suspended for transfer rebind', 'INVALID_TRANSITION');
    }
    if (!enrollment.agentId || !enrollment.agentRegistry) {
      throw new DomainError('Missing on-chain agent reference', 'NOT_BOUND');
    }
    if (
      !enrollment.owner ||
      enrollment.owner.toLowerCase() !== ownerAddress.toLowerCase()
    ) {
      throw new DomainError('Session must match current on-chain owner', 'FORBIDDEN');
    }

    const onChainOwner = await this.readOwnerOfForEnrollment(enrollment);
    if (onChainOwner.toLowerCase() !== ownerAddress.toLowerCase()) {
      throw new DomainError('On-chain owner mismatch', 'OWNER_MISMATCH');
    }

    const principal = await this.findOrCreatePrincipal(ownerAddress);
    if (needsKyc(principal)) {
      throw new DomainError('New owner requires KYC before rebind', 'KYC_REQUIRED');
    }

    await this.repo.withLock(async (s) => {
      const idx = s.enrollments.findIndex((e) => e.agentUuid === agentUuid);
      if (idx < 0) throw new DomainError('Enrollment not found', 'NOT_FOUND');
      const e = s.enrollments[idx]!;
      if (e.status !== 'suspended') {
        throw new DomainError('Enrollment must be suspended', 'INVALID_TRANSITION');
      }
      for (const c of s.credentials) {
        if (c.agentUuid === agentUuid && c.status !== 'revoked') {
          c.status = 'revoked';
        }
      }
      s.enrollments[idx] = {
        ...e,
        principalId: principal.id,
        owner: getAddress(ownerAddress),
        status: 'awaiting_fingerprint',
        fingerprintApprovedAt: undefined,
        updatedAt: new Date().toISOString(),
      };
    });

    return this.approveFingerprint(agentUuid, ownerAddress, thumbprint);
  }

  /** Test helper: simulate Transfer suspension */
  async simulateTransfer(agentUuid: string, to: `0x${string}`) {
    const store = await this.repo.getStore();
    const e = store.enrollments.find((x) => x.agentUuid === agentUuid);
    if (!e?.agentId || !e.agentRegistry) throw new DomainError('Not bound', 'NOT_BOUND');
    const parts = e.agentRegistry.split(':');
    const registry = parts[2] as `0x${string}`;
    return applyTransferEvent(this.repo, 84532, {
      from: e.owner ?? ('0x0000000000000000000000000000000000000001' as `0x${string}`),
      to,
      tokenId: e.agentId,
      txHash: `0x${'ab'.repeat(32)}` as `0x${string}`,
      logIndex: 1,
      blockNumber: 2n,
    }, {
      registryAddress: getAddress(registry),
      currentBlock: 2n,
      confirmations: 1,
    });
  }
}
