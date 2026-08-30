import { expect } from 'chai';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { network } from 'hardhat';

describe('MandateAnchor', () => {
  async function deploy() {
    const { viem } = await network.connect();
    const [admin, pauser, anchorer, outsider] = await viem.getWalletClients();
    const contract = await viem.deployContract('MandateAnchor', [admin.account.address, pauser.account.address, anchorer.account.address]);
    return { contract, admin, pauser, anchorer, outsider };
  }

  const evidence = ['0x'.padEnd(66, '1'), '0x'.padEnd(66, '2'), '0x'.padEnd(66, '3'), '0x'.padEnd(66, '4'), '0x'.padEnd(66, '5'), '0x'.padEnd(66, '6'), 1] as const;

  it('anchors evidence and makes it retrievable', async () => {
    const { contract, anchorer } = await deploy();
    await contract.write.anchor(evidence, { account: anchorer.account });
    expect(await contract.read.isAnchored([evidence[1]])).to.equal(true);
  });

  it('rejects duplicate evidence and an unprivileged caller', async () => {
    const { contract, anchorer, outsider } = await deploy();
    await assert.rejects(contract.write.anchor(evidence, { account: outsider.account }));
    await contract.write.anchor(evidence, { account: anchorer.account });
    await assert.rejects(contract.write.anchor(evidence, { account: anchorer.account }));
  });

  it('blocks anchoring while paused and allows it after unpause', async () => {
    const { contract, pauser, anchorer } = await deploy();
    await contract.write.pause({ account: pauser.account });
    await assert.rejects(contract.write.anchor(evidence, { account: anchorer.account }));
    await contract.write.unpause({ account: pauser.account });
    await contract.write.anchor(evidence, { account: anchorer.account });
  });
});
