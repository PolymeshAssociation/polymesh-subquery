import {
  SubstrateDatasourceKind,
  SubstrateEventHandler,
  SubstrateHandlerKind,
  SubstrateProject,
} from '@subql/types';
import { ModuleIdEnum } from './src/types/enums';

const pallets: string[] = [
  ModuleIdEnum.asset,
  ModuleIdEnum.identity,
  ModuleIdEnum.bridge,
  'complianceManager', //ModuleIdEnum.compliancemanager,
  ModuleIdEnum.corporateaction,
  'capitalDistribution', // ModuleIdEnum.capitaldistribution,
  'externalAgents', // ModuleIdEnum.externalagents,
  'corporateBallot', // ModuleIdEnum.corporateballot,
  ModuleIdEnum.checkpoint,
  ModuleIdEnum.multisig,
  ModuleIdEnum.nft,
  ModuleIdEnum.portfolio,
  ModuleIdEnum.pips,
  ModuleIdEnum.settlement,
  ModuleIdEnum.statistics,
  ModuleIdEnum.sto,
  'transactionPayment', // ModuleIdEnum.transactionpayment,
  ModuleIdEnum.staking,
  ModuleIdEnum.treasury,
  ModuleIdEnum.balances,
  'protocolFee', // ModuleIdEnum.protocolfee,
];

const handlers: SubstrateEventHandler[] = pallets.map(module => ({
  kind: SubstrateHandlerKind.Event,
  handler: 'handleEvent',
  filter: {
    module,
  },
}));

const project: SubstrateProject = {
  specVersion: '1.0.0',
  version: '0.0.1',
  name: 'polkadot-starter',
  description: 'This project can be used as a starting point for developing your SubQuery project',
  runner: {
    node: {
      name: '@subql/node',
      version: '>=3.0.1',
    },
    query: {
      name: '@subql/query',
      version: '*',
    },
  },
  schema: {
    file: './schema.graphql',
  },
  network: {
    /* The genesis hash of the network (hash of block 0) */
    chainId: '$NETWORK_CHAIN_ID',
    /**
     * This endpoint must be a public non-pruned archive node
     * Public nodes may be rate limited, which can affect indexing speed
     * When developing your project we suggest getting a private API key
     * You can get them from OnFinality for free https://app.onfinality.io
     * https://documentation.onfinality.io/support/the-enhanced-api-service
     */
    endpoint: ['$NETWORK_ENDPOINT'],
    chaintypes: {
      file: './dist/chainTypes.js',
    },
  },
  dataSources: [
    {
      kind: SubstrateDatasourceKind.Runtime,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      startBlock: 1,
      endBlock: 1,
      mapping: {
        file: './dist/index.js',
        handlers: [
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleEvent',
          },
        ],
      },
    },
    {
      kind: SubstrateDatasourceKind.Runtime,
      startBlock: Number('$START_BLOCK'),
      mapping: {
        file: './dist/index.js',
        handlers,
      },
    },
  ],
};

// Must set default to the project instance
export default project;
