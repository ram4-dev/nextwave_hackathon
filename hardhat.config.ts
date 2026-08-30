import { defineConfig } from 'hardhat/config';
import hardhatToolboxViem from '@nomicfoundation/hardhat-toolbox-viem';

export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: { profiles: { default: { version: '0.8.28' } } },
  paths: { sources: './contracts', tests: './contract-tests' },
  networks: process.env.BSC_TESTNET_RPC_URL ? {
    bscTestnet: {
      type: 'http',
      chainType: 'l1',
      url: process.env.BSC_TESTNET_RPC_URL,
      accounts: process.env.MANDATE_ANCHOR_DEPLOYER_PRIVATE_KEY ? [process.env.MANDATE_ANCHOR_DEPLOYER_PRIVATE_KEY] : [],
    },
  } : {},
});
