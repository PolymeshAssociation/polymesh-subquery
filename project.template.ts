import {
  SubstrateDatasourceKind,
  SubstrateEventHandler,
  SubstrateHandlerKind,
  SubstrateProject,
} from '@subql/types';

const pallets: string[] = [
  'asset',
  'identity',
  'bridge',
  'complianceManager',
  'corporateaction',
  'capitalDistribution',
  'externalAgents',
  'corporateBallot',
  'checkpoint',
  'multisig',
  'nft',
  'portfolio',
  'pips',
  'settlement',
  'statistics',
  'sto',
  'transactionPayment',
  'staking',
  'treasury',
  'balances',
  'protocolFee',
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
