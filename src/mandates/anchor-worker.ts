import { createHash } from 'node:crypto';
import { createPublicClient, createWalletClient, http, isAddress, type Address, type Hex } from 'viem';
import { bscTestnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { DomainError } from '../domain/state-machine.js';

const mandateAnchorAbi = [
  { type: 'function', name: 'anchor', stateMutability: 'nonpayable', inputs: [
    { name: 'closedCheckoutHash', type: 'bytes32' }, { name: 'closedPaymentHash', type: 'bytes32' },
    { name: 'checkoutHash', type: 'bytes32' }, { name: 'transactionIdHash', type: 'bytes32' },
    { name: 'agentIdHash', type: 'bytes32' }, { name: 'policyVersionHash', type: 'bytes32' },
    { name: 'mandateType', type: 'uint8' },
  ], outputs: [] },
  { type: 'function', name: 'isAnchored', stateMutability: 'view', inputs: [{ name: 'evidenceHash', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
] as const;

export type VerifiedMandateEvidence = {
  closedCheckoutJws: string;
  closedPaymentJws: string;
  checkoutJwt: string;
  transactionId: string;
  agentId: string;
  policyVersion: string;
};

export type MandateAnchorEvidence = {
  closedCheckoutHash: Hex;
  closedPaymentHash: Hex;
  checkoutHash: Hex;
  transactionIdHash: Hex;
  agentIdHash: Hex;
  policyVersionHash: Hex;
};

function sha256Bytes32(value: string): Hex {
  return `0x${createHash('sha256').update(value).digest('hex')}` as Hex;
}

/** Recalculate every evidence hash from the actual off-chain material. */
export function createMandateAnchorEvidence(input: VerifiedMandateEvidence): MandateAnchorEvidence {
  for (const [name, value] of Object.entries(input)) {
    if (!value || !value.trim()) throw new DomainError(`Missing anchor evidence field ${name}`, 'ANCHOR_EVIDENCE');
  }
  return {
    closedCheckoutHash: sha256Bytes32(input.closedCheckoutJws),
    closedPaymentHash: sha256Bytes32(input.closedPaymentJws),
    checkoutHash: sha256Bytes32(input.checkoutJwt),
    transactionIdHash: sha256Bytes32(input.transactionId),
    agentIdHash: sha256Bytes32(input.agentId),
    policyVersionHash: sha256Bytes32(input.policyVersion),
  };
}

export interface MandateAnchorReader {
  isAnchored(evidenceHash: Hex): Promise<boolean>;
}

export async function verifyMandateAnchorEvidence(reader: MandateAnchorReader, input: VerifiedMandateEvidence): Promise<{ anchored: boolean; evidence: MandateAnchorEvidence }> {
  const evidence = createMandateAnchorEvidence(input);
  const [checkoutAnchored, paymentAnchored] = await Promise.all([
    reader.isAnchored(evidence.closedCheckoutHash), reader.isAnchored(evidence.closedPaymentHash),
  ]);
  return { anchored: checkoutAnchored && paymentAnchored, evidence };
}

export type MandateAnchorWorker = {
  anchor(input: VerifiedMandateEvidence): Promise<{ transactionHash: Hex; evidence: MandateAnchorEvidence; alreadyAnchored: boolean }>;
  isAnchored(input: VerifiedMandateEvidence): Promise<{ anchored: boolean; evidence: MandateAnchorEvidence }>;
};

/**
 * BSC Testnet worker. Call it only after durable policy reservation and mandate
 * persistence; it never decides whether a payment is allowed.
 */
export function createBscTestnetMandateAnchorWorker(env: NodeJS.ProcessEnv = process.env): MandateAnchorWorker {
  const rpcUrl = env.BSC_TESTNET_RPC_URL;
  const contractAddress = env.MANDATE_ANCHOR_ADDRESS;
  const privateKey = env.MANDATE_ANCHORER_PRIVATE_KEY;
  if (!rpcUrl || !contractAddress || !privateKey || rpcUrl.includes('<') || contractAddress.includes('<') || privateKey.includes('<')) {
    throw new DomainError('BSC_TESTNET_RPC_URL, MANDATE_ANCHOR_ADDRESS, and MANDATE_ANCHORER_PRIVATE_KEY are required', 'ANCHOR_CONFIG');
  }
  if (!isAddress(contractAddress)) throw new DomainError('MANDATE_ANCHOR_ADDRESS is invalid', 'ANCHOR_CONFIG');
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new DomainError('MANDATE_ANCHORER_PRIVATE_KEY must be a 32-byte hex key', 'ANCHOR_CONFIG');
  const account = privateKeyToAccount(privateKey as Hex);
  const publicClient = createPublicClient({ chain: bscTestnet, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: bscTestnet, transport: http(rpcUrl) });
  const address = contractAddress as Address;
  const reader: MandateAnchorReader = {
    isAnchored: (evidenceHash) => publicClient.readContract({ address, abi: mandateAnchorAbi, functionName: 'isAnchored', args: [evidenceHash] }),
  };
  return {
    async isAnchored(input) { return verifyMandateAnchorEvidence(reader, input); },
    async anchor(input) {
      const checked = await verifyMandateAnchorEvidence(reader, input);
      if (checked.anchored) return { transactionHash: '0x' as Hex, evidence: checked.evidence, alreadyAnchored: true };
      const tx = await walletClient.writeContract({
        address, abi: mandateAnchorAbi, functionName: 'anchor',
        args: [checked.evidence.closedCheckoutHash, checked.evidence.closedPaymentHash, checked.evidence.checkoutHash, checked.evidence.transactionIdHash, checked.evidence.agentIdHash, checked.evidence.policyVersionHash, 1],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
      if (receipt.status !== 'success') throw new DomainError(`Anchor transaction reverted: ${tx}`, 'ANCHOR_TRANSACTION');
      return { transactionHash: tx, evidence: checked.evidence, alreadyAnchored: false };
    },
  };
}
