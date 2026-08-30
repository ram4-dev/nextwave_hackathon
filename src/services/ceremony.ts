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
  assertPublicEcP256Jwk,
  fingerprintDisplay,
  intentHash,
  isPrivateJwkMemberPresent,
  thumbprintFromJwk,
  verifyChallengeSignature,
} from '../crypto/local-agent-key.js';
import {
  codesEqualHash,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  generateHighEntropyDeviceCode,
  generateUserCode,
  hashOpaqueCode,
} from '../crypto/codes.js';
import { issueKyaCredential, reissueActiveKyaCredential } from '../credentials/jws.js';
import { buildAgentAccessToken, DEFAULT_AGENT_SCOPES } from '../auth/agent-access.js';
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

/** Provider transport evidence only; the registry watcher remains confirmation authority. */
export type UserOperationStatusProvider = {
  resolve: (userOpHash: `0x${string}`, smartAccount: `0x${string}`) => Promise<{
    status: 'pending' | 'confirmed' | 'failed';
    transactionHash?: `0x${string}`;
    receiptSuccess?: boolean;
  }>;
};

function validatedEnrollmentPublicJwk(jwk: JsonWebKey): JsonWebKey {
  try {
    return assertPublicEcP256Jwk(jwk);
  } catch {
    if (isPrivateJwkMemberPresent(jwk)) {
      throw new DomainError('Private key material rejected', 'PII_FORBIDDEN');
    }
    throw new DomainError('Invalid public JWK', 'INVALID_KEY');
  }
}

export class CeremonyService {
  readonly kyc: { primary: KycAdapter; byName: Record<string, KycAdapter> };
  private ownerOfReader?: OwnerOfReader;
  private userOperationStatusProvider?: UserOperationStatusProvider;
  private registryReadyClient?: Parameters<typeof assertRegistryReadyForChain>[2];

  constructor(
    private readonly repo: Repository,
    private readonly config: AppConfig,
    opts?: {
      ownerOfReader?: OwnerOfReader;
      registryReadyClient?: Parameters<typeof assertRegistryReadyForChain>[2];
      userOperationStatusProvider?: UserOperationStatusProvider;
    },
  ) {
    this.kyc = createKycAdapters(config);
    this.ownerOfReader = opts?.ownerOfReader;
    this.registryReadyClient = opts?.registryReadyClient;
    this.userOperationStatusProvider = opts?.userOperationStatusProvider;
  }

  /** Inject registry deps for deterministic tests. */
  setOwnerOfReader(reader: OwnerOfReader | undefined): void {
    this.ownerOfReader = reader;
  }

  setUserOperationStatusProvider(provider: UserOperationStatusProvider | undefined): void {
    this.userOperationStatusProvider = provider;
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
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
    /** @deprecated alias for device_code during migration */
    deviceCode: string;
    thumbprint: string;
    fingerprintDisplay: string;
    agentUriUrl: string;
  }> {
    return this.startDeviceEnrollment(input);
  }

  async startDeviceEnrollment(input: {
    publicJwk: JsonWebKey;
    keystoreProvider?: KeystoreProviderKind;
  }): Promise<{
    agentUuid: string;
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
    deviceCode: string;
    thumbprint: string;
    fingerprintDisplay: string;
    agentUriUrl: string;
  }> {
    const publicJwk = validatedEnrollmentPublicJwk(input.publicJwk);
    const thumbprint = await thumbprintFromJwk(publicJwk);
    const agentUuid = newId('agent');
    const deviceCode = generateHighEntropyDeviceCode();
    const userCode = generateUserCode();
    const agentUriPath = `/v1/agents/${agentUuid}/agent-uri.json`;
    const verification_uri = `${this.config.FRONTEND_ORIGIN}/device`;
    const verification_uri_complete = `${verification_uri}?user_code=${encodeURIComponent(userCode)}`;
    const pairingExpiresAt = new Date(
      Date.now() + DEVICE_CODE_TTL_SECONDS * 1000,
    ).toISOString();
    const enrollment: AgentEnrollment = {
      agentUuid,
      deviceCodeHash: hashOpaqueCode(deviceCode),
      userCodeHash: hashOpaqueCode(userCode),
      pairingExpiresAt,
      pollIntervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
      status: 'awaiting_human',
      publicJwk,
      thumbprint,
      keystoreProvider: input.keystoreProvider ?? 'os_hardware',
      agentUriPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.repo.withLock(async (store) => {
      store.enrollments.push(enrollment);
    });
    return {
      agentUuid,
      device_code: deviceCode,
      user_code: userCode,
      verification_uri,
      verification_uri_complete,
      expires_in: DEVICE_CODE_TTL_SECONDS,
      interval: DEVICE_POLL_INTERVAL_SECONDS,
      deviceCode,
      thumbprint,
      fingerprintDisplay: fingerprintDisplay(thumbprint),
      agentUriUrl: `${this.config.PUBLIC_BASE_URL}${agentUriPath}`,
    };
  }

  async claimDeviceEnrollment(
    userCode: string,
    principalId: string,
    expectedThumbprint: string,
  ): Promise<{
    enrollment: AgentEnrollment;
    principal: Principal;
    needsKyc: boolean;
  }> {
    const code = userCode.trim().toUpperCase();
    const store = await this.repo.getStore();
    const principal = store.principals.find((p) => p.id === principalId);
    if (!principal) throw new DomainError('Principal not found', 'FORBIDDEN');

    return this.repo.withLock(async (s) => {
      const idx = s.enrollments.findIndex(
        (e) =>
          !e.claimedAt &&
          !e.pairingDeniedAt &&
          codesEqualHash(code, e.userCodeHash),
      );
      // Uniform rejection — do not disclose claim state of other principals.
      if (idx < 0) throw new DomainError('Invalid or expired user code', 'UNAUTHORIZED');
      let enrollment = s.enrollments[idx]!;
      if (new Date(enrollment.pairingExpiresAt).getTime() <= Date.now()) {
        throw new DomainError('Invalid or expired user code', 'UNAUTHORIZED');
      }
      if (enrollment.thumbprint !== expectedThumbprint) {
        throw new DomainError('Fingerprint mismatch', 'FINGERPRINT');
      }
      if (enrollment.principalId && enrollment.principalId !== principalId) {
        throw new DomainError('Invalid or expired user code', 'UNAUTHORIZED');
      }
      enrollment = {
        ...enrollment,
        principalId,
        claimedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const kycNeeded = needsKyc(principal);
      if (enrollment.status === 'awaiting_human' || enrollment.status === 'awaiting_kyc') {
        const target = kycNeeded ? 'awaiting_kyc' : 'awaiting_fingerprint';
        if (enrollment.status !== target) {
          enrollment = transitionEnrollment(enrollment, target);
        }
      }
      s.enrollments[idx] = enrollment;
      return { enrollment, principal, needsKyc: kycNeeded };
    });
  }

  async pollDeviceEnrollmentToken(deviceCode: string): Promise<{
    status: 'pending' | 'slow_down' | 'denied' | 'expired' | 'complete';
    interval?: number;
    credential?: string;
    agentUuid?: string;
  }> {
    const hash = hashOpaqueCode(deviceCode);
    return this.repo.withLock(async (store) => {
      const idx = store.enrollments.findIndex((e) => e.deviceCodeHash === hash);
      if (idx < 0) {
        return { status: 'expired' as const };
      }
      const enrollment = store.enrollments[idx]!;
      if (enrollment.pairingDeniedAt) {
        return { status: 'denied' as const };
      }
      if (new Date(enrollment.pairingExpiresAt).getTime() <= Date.now() && enrollment.status !== 'bound') {
        return { status: 'expired' as const };
      }
      if (enrollment.credentialDeliveredAt) {
        return { status: 'complete' as const, agentUuid: enrollment.agentUuid };
      }
      const interval = enrollment.pollIntervalSeconds || DEVICE_POLL_INTERVAL_SECONDS;
      if (enrollment.lastPollAt) {
        const elapsed = Date.now() - Date.parse(enrollment.lastPollAt);
        if (elapsed < interval * 1000) {
          return { status: 'slow_down' as const, interval };
        }
      }
      enrollment.lastPollAt = new Date().toISOString();
      store.enrollments[idx] = enrollment;

      if (enrollment.status !== 'bound') {
        return { status: 'pending' as const, interval, agentUuid: enrollment.agentUuid };
      }
      const active = store.credentials.find(
        (c) =>
          c.agentUuid === enrollment.agentUuid &&
          c.status === 'active' &&
          Date.parse(c.expiresAt) > Date.now(),
      );
      if (!active) {
        return { status: 'pending' as const, interval, agentUuid: enrollment.agentUuid };
      }
      const credential = await reissueActiveKyaCredential(this.repo, this.config, active);
      enrollment.credentialDeliveredAt = new Date().toISOString();
      store.enrollments[idx] = enrollment;
      return {
        status: 'complete' as const,
        credential,
        agentUuid: enrollment.agentUuid,
      };
    });
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

  async getKycSessionStatus(
    sessionId: string,
    principalId: string,
  ): Promise<{
    sessionId: string;
    status: string;
    updatedAt: string;
    createdAt: string;
  }> {
    const store = await this.repo.getStore();
    const session = store.kycSessions.find(
      (s) => s.id === sessionId || s.providerSessionId === sessionId,
    );
    if (!session) throw new DomainError('KYC session not found', 'NOT_FOUND');
    if (session.principalId !== principalId) {
      throw new DomainError('Forbidden', 'FORBIDDEN');
    }
    return {
      sessionId: session.providerSessionId,
      status: session.status,
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
    };
  }

  /**
   * Navigation-only Didit return. Correlates verificationSessionId to a known
   * local session and returns the configured frontend URL. Query status and
   * caller-supplied redirects are never decision evidence or redirect targets.
   */
  async resolveKycNavigationCallback(
    verificationSessionId: string | undefined,
  ): Promise<string> {
    const sessionId = verificationSessionId?.trim();
    if (!sessionId) {
      throw new DomainError('Missing KYC session', 'NOT_FOUND');
    }
    const store = await this.repo.getStore();
    const session = store.kycSessions.find((s) => s.providerSessionId === sessionId);
    if (!session) {
      throw new DomainError('Unknown KYC session', 'NOT_FOUND');
    }
    return this.config.FRONTEND_ORIGIN;
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

    const callHash = hashRegisterCall({ chainId, registry, agentURI });
    await this.repo.withLock(async (s) => {
      const e = s.enrollments.find((x) => x.agentUuid === agentUuid)!;
      e.agentRegistry = agentRegistry;
      e.registrationIntentHash = callHash;
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
      note: 'Submit the exact register(agentURI) UserOperation with the authenticated CDP Smart Account. KYA is never msg.sender.',
    };
  }

  /** Build one exact Base Sepolia call for the session-bound Smart Account. */
  async prepareRegistrationIntent(agentUuid: string, principalId: string) {
    const store = await this.repo.getStore();
    const principal = store.principals.find((item) => item.id === principalId);
    if (!principal) throw new DomainError('Principal not found', 'FORBIDDEN');
    const enrollment = store.enrollments.find((item) => item.agentUuid === agentUuid);
    if (!enrollment || enrollment.principalId !== principalId) throw new DomainError('Forbidden', 'FORBIDDEN');
    if (!canAuthorizeAgent(principal) || !enrollment.fingerprintApprovedAt) {
      throw new DomainError('Registration prerequisites not met', 'REGISTRATION_PREREQUISITE');
    }
    const prepared = await this.prepareRegister(agentUuid, principal.ownerAddress, 84532);
    const registry = prepared.registry;
    const agentURI = prepared.agentURI;
    const register = prepared.register ?? buildRegisterTransaction({ chainId: 84532, registry, agentURI, from: principal.ownerAddress });
    const intentHashValue = prepared.callHash ?? hashRegisterCall({ chainId: 84532, registry, agentURI });
    return {
      chainId: 84532 as const,
      registry,
      agentURI,
      register,
      intentHash: intentHashValue,
      // Portal policy is an external capability: local configuration alone
      // cannot prove the registry call is sponsorable.
      sponsorship: {
        provider: 'cdp',
        configured: Boolean(this.config.VITE_CDP_PROJECT_ID),
        ready: false,
        status: 'unknown' as const,
      },
    };
  }

  /** Persist an opaque UserOperation hash only when it belongs to the current intent. */
  async recordRegistrationSubmission(agentUuid: string, principalId: string, intentHashValue: string, userOpHash: `0x${string}`) {
    if (!/^0x[a-fA-F0-9]{64}$/.test(userOpHash)) throw new DomainError('Invalid UserOperation hash', 'USER_OPERATION');
    return this.repo.withLock(async (store) => {
      const enrollment = store.enrollments.find((item) => item.agentUuid === agentUuid);
      if (!enrollment || enrollment.principalId !== principalId) throw new DomainError('Forbidden', 'FORBIDDEN');
      if (!enrollment.registrationIntentHash || enrollment.registrationIntentHash !== intentHashValue) {
        throw new DomainError('Registration intent mismatch', 'REGISTRATION_INTENT');
      }
      if (enrollment.registrationUserOpHash) {
        if (enrollment.registrationUserOpHash.toLowerCase() === userOpHash.toLowerCase()) return { idempotent: true as const };
        throw new DomainError('Registration already submitted', 'REGISTRATION_REPLAY');
      }
      enrollment.registrationUserOpHash = userOpHash;
      enrollment.updatedAt = new Date().toISOString();
      return { idempotent: false as const };
    });
  }

  /** Resolve CDP provider evidence; never treats it alone as a credential confirmation. */
  async resolveRegistrationSubmission(agentUuid: string, principalId: string) {
    if (!this.userOperationStatusProvider) throw new DomainError('UserOperation provider unavailable', 'CDP_UNAVAILABLE');
    const store = await this.repo.getStore();
    const enrollment = store.enrollments.find((item) => item.agentUuid === agentUuid);
    const principal = store.principals.find((item) => item.id === principalId);
    if (!enrollment || !principal || enrollment.principalId !== principalId || !enrollment.registrationUserOpHash) {
      throw new DomainError('Registration submission not found', 'NOT_FOUND');
    }
    const resolved = await this.userOperationStatusProvider.resolve(enrollment.registrationUserOpHash, principal.ownerAddress);
    if (resolved.status === 'failed') throw new DomainError('UserOperation failed', 'USER_OPERATION');
    if (resolved.status !== 'confirmed' || !resolved.transactionHash || !resolved.receiptSuccess) return { status: 'pending' as const };
    await this.repo.withLock((next) => {
      const current = next.enrollments.find((item) => item.agentUuid === agentUuid)!;
      if (current.registrationUserOpHash !== enrollment.registrationUserOpHash) throw new DomainError('Registration submission changed', 'REGISTRATION_REPLAY');
      current.registrationTransactionHash = resolved.transactionHash;
      current.registrationReceiptConfirmedAt = new Date().toISOString();
      current.updatedAt = new Date().toISOString();
    });
    return { status: 'confirmed' as const, transactionHash: resolved.transactionHash };
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
    const transactionHash = `0x${'de'.repeat(32)}` as `0x${string}`;
    await this.repo.withLock((store) => {
      const enrollment = store.enrollments.find((item) => item.agentUuid === agentUuid);
      if (!enrollment?.registrationIntentHash) throw new DomainError('Demo registration intent missing', 'REGISTRATION_INTENT');
      enrollment.registrationUserOpHash = `0x${'ab'.repeat(32)}`;
      enrollment.registrationTransactionHash = transactionHash;
      enrollment.registrationReceiptConfirmedAt = new Date().toISOString();
      enrollment.updatedAt = new Date().toISOString();
    });
    const applied = await applyRegisteredEvent(this.repo, 84532, {
      agentId: demo.agentId,
      agentURI: demo.agentURI,
      owner: demo.owner,
      txHash: transactionHash,
      logIndex: 0,
      blockNumber: 1n,
    }, {
      registryAddress: prepared.registry,
      publicBaseUrl: this.config.PUBLIC_BASE_URL,
      currentBlock: 1n,
      confirmations: 1,
      verifiedOwner: demo.owner,
    });
    if (!applied.bound) throw new DomainError('Demo registration evidence rejected', 'USER_OPERATION');

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

    const activeCredential = store.credentials.find(
      (credential) =>
        credential.agentUuid === agentUuid &&
        credential.status === 'active' &&
        Date.parse(credential.expiresAt) > Date.now(),
    );
    if (activeCredential) {
      return {
        token: await reissueActiveKyaCredential(this.repo, this.config, activeCredential),
        agentId: activeCredential.agentId,
        agentRegistry: activeCredential.agentRegistry,
        jti: activeCredential.jti,
      };
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

  async readCurrentOwnerOf(agentUuid: string): Promise<`0x${string}`> {
    const store = await this.repo.getStore();
    const enrollment = store.enrollments.find((e) => e.agentUuid === agentUuid);
    if (!enrollment) throw new DomainError('Enrollment not found', 'NOT_FOUND');
    return this.readOwnerOfForEnrollment(enrollment);
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
    const principal = store.principals.find((p) => p.id === enrollment.principalId);
    if (!principal || !canAuthorizeAgent(principal)) {
      throw new DomainError('Principal KYC not active', 'KYC_REQUIRED');
    }
    const expectedOwner = enrollment.owner?.toLowerCase() ?? principal.ownerAddress.toLowerCase();
    if (
      !enrollment.principalId ||
      Date.parse(activeCred.expiresAt) <= Date.now() ||
      activeCred.principalId !== enrollment.principalId ||
      activeCred.thumbprint !== enrollment.thumbprint ||
      activeCred.agentRegistry !== enrollment.agentRegistry ||
      activeCred.agentId !== enrollment.agentId ||
      activeCred.owner.toLowerCase() !== expectedOwner ||
      principal.ownerAddress.toLowerCase() !== expectedOwner
    ) {
      throw new DomainError('Credential binding mismatch', 'JWT_STATUS');
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

    // Only locally valid proof material may trigger the external ownerOf read.
    if (enrollment.agentId && enrollment.agentRegistry) {
      const onChainOwner = await this.readOwnerOfForEnrollment(enrollment);
      if (onChainOwner.toLowerCase() !== expectedOwner) {
        throw new DomainError('On-chain owner mismatch', 'OWNER_MISMATCH');
      }
    }

    // Signing is deliberately separated from persistence. The signed token is
    // not usable unless its metadata is appended in the same CAS that consumes
    // the challenge nonce below.
    const { token, record } = await buildAgentAccessToken(this.repo, this.config, {
      agentUuid,
      principalId: enrollment.principalId,
      thumbprint: enrollment.thumbprint,
      credentialJti: activeCred.jti,
      scopes: [...DEFAULT_AGENT_SCOPES],
      agentRegistry: enrollment.agentRegistry,
      agentId: enrollment.agentId,
    });

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
      const currentEnrollment = s.enrollments.find((e) => e.agentUuid === agentUuid);
      if (
        !currentEnrollment ||
        currentEnrollment.status !== 'bound' ||
        currentEnrollment.principalId !== enrollment.principalId ||
        currentEnrollment.thumbprint !== enrollment.thumbprint ||
        currentEnrollment.agentRegistry !== enrollment.agentRegistry ||
        currentEnrollment.agentId !== enrollment.agentId ||
        currentEnrollment.owner?.toLowerCase() !== enrollment.owner?.toLowerCase()
      ) {
        throw new DomainError('Enrollment binding changed', 'CHALLENGE');
      }
      let currentThumbprint: string;
      try {
        const currentPublicJwk = assertPublicEcP256Jwk(currentEnrollment.publicJwk);
        currentThumbprint = await thumbprintFromJwk(currentPublicJwk);
      } catch {
        throw new DomainError('Enrollment key binding invalid', 'CHALLENGE');
      }
      if (currentThumbprint !== currentEnrollment.thumbprint) {
        throw new DomainError('Enrollment key binding changed', 'CHALLENGE');
      }
      const currentPrincipal = s.principals.find(
        (p) => p.id === currentEnrollment.principalId,
      );
      const currentExpectedOwner =
        currentEnrollment.owner?.toLowerCase() ?? currentPrincipal?.ownerAddress.toLowerCase();
      if (
        !currentPrincipal ||
        !canAuthorizeAgent(currentPrincipal) ||
        !currentExpectedOwner ||
        currentExpectedOwner !== expectedOwner ||
        currentPrincipal.ownerAddress.toLowerCase() !== currentExpectedOwner
      ) {
        throw new DomainError('Principal binding changed', 'KYC_REQUIRED');
      }
      const stillActive = s.credentials.find((c) => c.jti === activeCred.jti);
      if (
        !stillActive ||
        stillActive.status !== 'active' ||
        Date.parse(stillActive.expiresAt) <= Date.now() ||
        stillActive.agentUuid !== currentEnrollment.agentUuid ||
        stillActive.principalId !== currentPrincipal.id ||
        stillActive.thumbprint !== currentEnrollment.thumbprint ||
        stillActive.agentRegistry !== currentEnrollment.agentRegistry ||
        stillActive.agentId !== currentEnrollment.agentId ||
        stillActive.owner.toLowerCase() !== currentExpectedOwner
      ) {
        throw new DomainError('Credential binding changed', 'JWT_STATUS');
      }
      if (
        record.agentUuid !== currentEnrollment.agentUuid ||
        record.principalId !== currentPrincipal.id ||
        record.credentialJti !== stillActive.jti ||
        record.jkt !== currentEnrollment.thumbprint
      ) {
        throw new DomainError('Access token binding changed', 'JWT_STATUS');
      }
      n.consumedAt = new Date().toISOString();
      s.accessTokens = s.accessTokens ?? [];
      s.accessTokens.push(record);
    });

    return {
      ok: true as const,
      thumbprint: enrollment.thumbprint,
      credentialId: activeCred.jti,
      access_token: token,
      token_type: 'DPoP' as const,
      expires_in: Math.min(600, Math.floor((Date.parse(record.expiresAt) - Date.now()) / 1000)),
      scopes: record.scopes,
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
    const publicJwk = validatedEnrollmentPublicJwk(newPublicJwk);
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
