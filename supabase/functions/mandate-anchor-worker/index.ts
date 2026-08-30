import { loadMandateEdgeRuntimeConfig } from '../_shared/mandate-runtime-config.ts';

/**
 * Private readiness endpoint for the future Supabase-hosted signer/anchor worker.
 * It deliberately does not expose a generic signing or anchoring API: the Node
 * mandate service must first persist and validate an authorized outbox record.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const config = loadMandateEdgeRuntimeConfig();
    if (request.headers.get('x-mandate-worker-key') !== config.internalWorkerKey) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    return Response.json({
      ready: true,
      anchorAddress: config.anchorAddress,
      hasMandateSigningKey: true,
      // Do not return the JWK, private key, RPC URL, or internal key.
    });
  },
};
