/**
 * Deterministic CLI demo ceremony (no HTTP server required).
 */
import { loadConfig } from '../src/config/env.js';
import { InMemoryRepository } from '../src/persistence/repository.js';
import { CeremonyService } from '../src/services/ceremony.js';
import { verifyKyaCredential } from '../src/credentials/jws.js';

async function main() {
  const config = loadConfig({ ...process.env, NODE_ENV: 'development' });
  const repo = new InMemoryRepository();
  const ceremony = new CeremonyService(repo, config);
  const owner = '0x1111111111111111111111111111111111111111' as const;

  const key = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', key.publicKey);
  const started = await ceremony.startEnrollment({
    publicJwk,
    keystoreProvider: 'encrypted_os_keystore',
  });
  console.log('enrollment', started.agentUuid, started.deviceCode);

  await ceremony.attachHuman(started.agentUuid, owner);
  await ceremony.completeKyc(owner);
  await ceremony.attachHuman(started.agentUuid, owner);
  await ceremony.approveFingerprint(started.agentUuid, owner, started.thumbprint);
  const bound = await ceremony.bindAgent(started.agentUuid, owner);
  const claims = await verifyKyaCredential(repo, config, bound.token);
  console.log(
    JSON.stringify(
      {
        ok: true,
        agentId: bound.agentId,
        agentRegistry: bound.agentRegistry,
        jkt: claims.cnf.jkt,
        principal_id: claims.principal_id,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
