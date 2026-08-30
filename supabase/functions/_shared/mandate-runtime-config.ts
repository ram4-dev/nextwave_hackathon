/**
 * Supabase Edge Functions run on Deno, not the Node.js server runtime.
 * Keep this separate from src/mandates/*, which correctly uses process.env.
 */

type MandateEdgeRuntimeConfig = {
  mandateSigningPrivateJwk: JsonWebKey;
  anchorAddress: `0x${string}`;
  bscTestnetRpcUrl: string;
  anchorerPrivateKey: `0x${string}`;
  internalWorkerKey: string;
};

function requiredSecret(name: string): string {
  const value = Deno.env.get(name);
  if (!value || value.includes('<')) throw new Error(`${name} must be configured as a Supabase Edge Function secret`);
  return value;
}

export function loadMandateEdgeRuntimeConfig(): MandateEdgeRuntimeConfig {
  const jwk = requiredSecret('MANDATE_SIGNING_PRIVATE_JWK');
  const anchorAddress = requiredSecret('MANDATE_ANCHOR_ADDRESS');
  const bscTestnetRpcUrl = requiredSecret('BSC_TESTNET_RPC_URL');
  const anchorerPrivateKey = requiredSecret('MANDATE_ANCHORER_PRIVATE_KEY');
  const internalWorkerKey = requiredSecret('MANDATE_WORKER_INTERNAL_KEY');
  let mandateSigningPrivateJwk: JsonWebKey;
  try { mandateSigningPrivateJwk = JSON.parse(jwk) as JsonWebKey; } catch { throw new Error('MANDATE_SIGNING_PRIVATE_JWK must contain JSON'); }
  if (mandateSigningPrivateJwk.kty !== 'EC' || mandateSigningPrivateJwk.crv !== 'P-256' || typeof mandateSigningPrivateJwk.d !== 'string') {
    throw new Error('MANDATE_SIGNING_PRIVATE_JWK must be an ES256 private JWK');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(anchorAddress)) throw new Error('MANDATE_ANCHOR_ADDRESS must be an EVM address');
  try { new URL(bscTestnetRpcUrl); } catch { throw new Error('BSC_TESTNET_RPC_URL must be a URL'); }
  if (!/^0x[0-9a-fA-F]{64}$/.test(anchorerPrivateKey)) throw new Error('MANDATE_ANCHORER_PRIVATE_KEY must be a 32-byte hex key');
  return { mandateSigningPrivateJwk, anchorAddress: anchorAddress as `0x${string}`, bscTestnetRpcUrl, anchorerPrivateKey: anchorerPrivateKey as `0x${string}`, internalWorkerKey };
}
