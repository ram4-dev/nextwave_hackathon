import { expect } from 'chai';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { network } from 'hardhat';

describe('MandateAnchor', () => {
  async function deploy() {
    const { viem } = await network.connect();
    const [admin, pauser, anchorer, outsider] = await viem.getWalletClients();
    const contract = await viem.deployContract('MandateAnchor', [
      admin.account.address,
      pauser.account.address,
      anchorer.account.address,
    ]);
    return { contract, admin, pauser, anchorer, outsider, publicClient: await viem.getPublicClient() };
  }

  const evidence = [
    '0x'.padEnd(66, '1'),
    '0x'.padEnd(66, '2'),
    '0x'.padEnd(66, '3'),
    '0x'.padEnd(66, '4'),
    '0x'.padEnd(66, '5'),
    '0x'.padEnd(66, '6'),
    1,
  ] as const;

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

  it('enforces distinct admin, pauser, and anchorer roles', async () => {
    const { contract, admin, pauser, anchorer, outsider } = await deploy();
    const adminRole = await contract.read.DEFAULT_ADMIN_ROLE();
    const pauserRole = await contract.read.PAUSER_ROLE();
    const anchorerRole = await contract.read.ANCHORER_ROLE();

    expect(await contract.read.hasRole([adminRole, admin.account.address])).to.equal(true);
    expect(await contract.read.hasRole([pauserRole, pauser.account.address])).to.equal(true);
    expect(await contract.read.hasRole([anchorerRole, anchorer.account.address])).to.equal(true);

    expect(await contract.read.hasRole([pauserRole, admin.account.address])).to.equal(false);
    expect(await contract.read.hasRole([anchorerRole, admin.account.address])).to.equal(false);
    expect(await contract.read.hasRole([adminRole, pauser.account.address])).to.equal(false);
    expect(await contract.read.hasRole([anchorerRole, pauser.account.address])).to.equal(false);
    expect(await contract.read.hasRole([adminRole, anchorer.account.address])).to.equal(false);
    expect(await contract.read.hasRole([pauserRole, anchorer.account.address])).to.equal(false);

    await assert.rejects(contract.write.pause({ account: admin.account }));
    await assert.rejects(contract.write.pause({ account: anchorer.account }));
    await assert.rejects(contract.write.anchor(evidence, { account: admin.account }));
    await assert.rejects(contract.write.anchor(evidence, { account: pauser.account }));
    await assert.rejects(contract.write.anchor(evidence, { account: outsider.account }));
  });

  it('rejects constructor when admin equals anchorer', async () => {
    const { viem } = await network.connect();
    const [admin, pauser] = await viem.getWalletClients();
    await assert.rejects(
      viem.deployContract('MandateAnchor', [admin.account.address, pauser.account.address, admin.account.address]),
    );
  });
});
