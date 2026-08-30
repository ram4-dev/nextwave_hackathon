import { network } from 'hardhat';

const required = [
  'MANDATE_ANCHOR_ADMIN',
  'MANDATE_ANCHOR_PAUSER',
  'MANDATE_ANCHORER',
] as const;

for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

const { viem } = await network.connect();
const contract = await viem.deployContract('MandateAnchor', [
  process.env.MANDATE_ANCHOR_ADMIN!,
  process.env.MANDATE_ANCHOR_PAUSER!,
  process.env.MANDATE_ANCHORER!,
]);

console.log(JSON.stringify({ contractAddress: contract.address }, null, 2));
