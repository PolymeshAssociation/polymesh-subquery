import {
  SubstrateDatasourceKind,
  SubstrateEventHandler,
  SubstrateHandlerKind,
  SubstrateProject,
} from '@subql/types';

const startBlock = Number(process.env.START_BLOCK) || 1;
const chainId = process.env.NETWORK_CHAIN_ID || '';
const endpoint = process.env.NETWORK_ENDPOINT || '';
const dictionary = process.env.NETWORK_DICTIONARY || '';

const filters = {
  asset: [
    'AssetBalanceUpdated',
    'AssetCreated',
    'AssetFrozen',
    'AssetOwnershipTransferred',
    'AssetRenamed',
    'AssetTypeChanged',
    'AssetUnfrozen',
    'ControllerTransfer',
    'CustomAssetTypeExists',
    'CustomAssetTypeRegistered',
    'DivisibilityChanged',
    'DocumentAdded',
    'DocumentRemoved',
    'ExtensionRemoved',
    'FundingRoundSet',
    'IdentifiersUpdated',
    'IsIssuable',
    'Issued',
    'LocalMetadataKeyDeleted',
    'MetadataValueDeleted',
    'Redeemed',
    'RegisterAssetMetadataGlobalType',
    'RegisterAssetMetadataLocalType',
    'SetAssetMetadataValue',
    'SetAssetMetadataValueDetails',
    'TickerRegistered',
    'TickerTransferred',
    'Transfer',
    'TransferWithData',
    'PreApprovedAsset',
    'RemovePreApprovedAsset',
  ],
  identity: [
    'AssetDidRegistered',
    'AuthorizationAdded',
    'AuthorizationConsumed',
    'AuthorizationRejected',
    'AuthorizationRetryLimitReached',
    'AuthorizationRevoked',
    'CddClaimsInvalidated',
    'CddRequirementForPrimaryKeyUpdated',
    'ChildDidCreated',
    'ChildDidUnlinked',
    'ClaimAdded',
    'ClaimRevoked',
    'CustomClaimTypeAdded',
    'DidCreated',
    'PrimaryKeyUpdated',
    'SecondaryKeyLeftIdentity',
    'SecondaryKeyPermissionsUpdated',
    'SecondaryKeysAdded',
    'SecondaryKeysFrozen',
    'SecondaryKeysRemoved',
    'SecondaryKeysUnfrozen',
  ],
  bridge: [
    'AdminChanged',
    'BridgeLimitUpdated',
    'BridgeTxFailed',
    'BridgeTxScheduleFailed',
    'BridgeTxScheduled',
    'Bridged',
    'ControllerChanged',
    'ExemptedUpdated',
    'FreezeAdminAdded',
    'FreezeAdminRemoved',
    'Frozen',
    'FrozenTx',
    'TimelockChanged',
    'TxRemoved',
    'TxsHandled',
    'Unfrozen',
    'UnfrozenTx',
  ],
  complianceManager: [
    'AssetCompliancePaused',
    'AssetComplianceReplaced',
    'AssetComplianceReset',
    'AssetComplianceResumed',
    'ComplianceRequirementChanged',
    'ComplianceRequirementCreated',
    'ComplianceRequirementRemoved',
    'TrustedDefaultClaimIssuerAdded',
    'TrustedDefaultClaimIssuerRemoved',
  ],
  corporateAction: [
    'CAInitiated',
    'CALinkedToDoc',
    'CARemoved',
    'DefaultTargetIdentitiesChanged',
    'DefaultWithholdingTaxChanged',
    'DidWithholdingTaxChanged',
    'MaxDetailsLengthChanged',
    'RecordDateChanged',
  ],
  capitalDistribution: ['BenefitClaimed', 'Created', 'Reclaimed', 'Removed'],
  externalAgents: [
    'AgentAdded',
    'AgentRemoved',
    'GroupChanged',
    'GroupCreated',
    'GroupPermissionsUpdated',
  ],
  corporateBallot: ['Created', 'MetaChanged', 'RCVChanged', 'RangeChanged', 'Removed', 'VoteCast'],
  checkpoint: [
    'CheckpointCreated',
    'MaximumSchedulesComplexityChanged',
    'ScheduleCreated',
    'ScheduleRemoved',
  ],
  multiSig: [
    'MultiSigCreated',
    'MultiSigSignaturesRequiredChanged',
    'MultiSigSignerAdded',
    'MultiSigSignerAuthorized',
    'MultiSigSignerRemoved',
    'ProposalAdded',
    'ProposalApproved',
    'ProposalExecuted',
    'ProposalExecutionFailed',
    'ProposalRejected',
    'ProposalRejectionVote',
    'SchedulingFailed',
    'ProposalFailedToExecute',
  ],
  nft: ['NFTPortfolioUpdated', 'NftCollectionCreated'],
  portfolio: [
    'FundsMovedBetweenPortfolios',
    'MovedBetweenPortfolios',
    'PortfolioCreated',
    'PortfolioCustodianChanged',
    'PortfolioDeleted',
    'PortfolioRenamed',
    'UserPortfolios',
  ],
  pips: [
    'ActivePipLimitChanged',
    'DefaultEnactmentPeriodChanged',
    'ExecutionCancellingFailed',
    'ExecutionScheduled',
    'ExecutionSchedulingFailed',
    'ExpiryScheduled',
    'ExpirySchedulingFailed',
    'HistoricalPipsPruned',
    'MaxPipSkipCountChanged',
    'MinimumProposalDepositChanged',
    'PendingPipExpiryChanged',
    'PipClosed',
    'PipSkipped',
    'ProposalCreated',
    'ProposalRefund',
    'ProposalStateUpdated',
    'SnapshotCleared',
    'SnapshotResultsEnacted',
    'SnapshotTaken',
    'Voted',
  ],
  settlement: [
    'AffirmationWithdrawn',
    'FailedToExecuteInstruction',
    'InstructionAuthorized',
    'InstructionUnauthorized',
    'InstructionAffirmed',
    'InstructionCreated',
    'InstructionExecuted',
    'InstructionFailed',
    'InstructionRejected',
    'InstructionRescheduled',
    'InstructionAutomaticallyAffirmed',
    'MediatorAffirmationReceived',
    'MediatorAffirmationWithdrawn',
    'InstructionMediators',
    'LegFailedExecution',
    'ReceiptClaimed',
    'SchedulingFailed',
    'SettlementManuallyExecuted',
    'VenueCreated',
    'VenueDetailsUpdated',
    'VenueFiltering',
    'VenueSignersUpdated',
    'VenueTypeUpdated',
    'VenueUnauthorized',
    'VenuesAllowed',
    'VenuesBlocked',
  ],
  statistics: [
    'AssetStatsUpdated',
    'SetAssetTransferCompliance',
    'StatTypesAdded',
    'StatTypesRemoved',
    'TransferManagerAdded',
    'TransferManagerRemoved',
    'ExemptionsAdded',
    'ExemptionsRemoved',
    'TransferConditionExemptionsAdded',
    'TransferConditionExemptionsRemoved',
  ],
  sto: [
    'FundraiserClosed',
    'FundraiserCreated',
    'FundraiserFrozen',
    'FundraiserUnfrozen',
    'FundraiserWindowModified',
    'Invested',
  ],
  transactionPayment: ['TransactionFeePaid'],
  staking: [
    'Bonded',
    'CommissionCapUpdated',
    'EraPayout',
    'InvalidatedNominators',
    'MinimumBondThresholdUpdated',
    'Nominated',
    'OldSlashingReportDiscarded',
    'PermissionedIdentityAdded',
    'PermissionedIdentityRemoved',
    'Reward',
    'RewardPaymentSchedulingInterrupted',
    'Slash',
    'SlashingAllowedForChanged',
    'SolutionStored',
    'StakingElection',
    'Unbonded',
    'Withdrawn',
  ],
  treasury: ['TreasuryDisbursement', 'TreasuryDisbursementFailed', 'TreasuryReimbursement'],
  balances: [
    'AccountBalanceBurned',
    'BalanceSet',
    'Endowed',
    'ReserveRepatriated',
    'Reserved',
    'Transfer',
    'Unreserved',
  ],
  protocolFee: ['FeeCharged'],
  system: ['CodeUpdated', 'NewAccount'],
  confidentialAsset: [
    'AccountCreated',
    'AccountDeposit',
    'AccountDepositIncoming',
    'AccountWithdraw',
    'AccountAssetFrozen',
    'AccountAssetUnfrozen',
    'AssetCreated',
    'AssetFrozen',
    'AssetUnfrozen',
    'AssetBurned',
    'Issued',
    'TransactionAffirmed',
    'TransactionCreated',
    'TransactionExecuted',
    'TransactionRejected',
    'VenueCreated',
    'VenueFiltering',
    'VenuesAllowed',
    'VenuesBlocked',
    'FundsMoved',
  ],
};

const handlers: SubstrateEventHandler[] = Object.keys(filters)
  .map(module =>
    filters[module].map(method => ({
      kind: SubstrateHandlerKind.Event,
      handler: 'handleEvent',
      filter: {
        module,
        method,
      },
    }))
  )
  .flat();

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
    chainId,
    /**
     * This endpoint must be a public non-pruned archive node
     * Public nodes may be rate limited, which can affect indexing speed
     * When developing your project we suggest getting a private API key
     * You can get them from OnFinality for free https://app.onfinality.io
     * https://documentation.onfinality.io/support/the-enhanced-api-service
     */
    endpoint: [endpoint],
    dictionary,
    chaintypes: {
      file: './dist/chainTypes.js',
    },
  },
  dataSources: [
    {
      kind: SubstrateDatasourceKind.Runtime,
      startBlock: 1,
      endBlock: 1,
      mapping: {
        file: './dist/index.js',
        handlers: [
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleGenesis',
          },
        ],
      },
    },
    {
      kind: SubstrateDatasourceKind.Runtime,
      startBlock,
      mapping: {
        file: './dist/index.js',
        handlers: [
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleMigration',
            filter: {
              module: 'system',
              method: 'CodeUpdated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAssetCreated',
            filter: {
              module: 'asset',
              method: 'AssetCreated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleDocumentAdded',
            filter: {
              module: 'asset',
              method: 'DocumentAdded',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleDocumentRemoved',
            filter: {
              module: 'asset',
              method: 'DocumentRemoved',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleIssued',
            filter: {
              module: 'asset',
              method: 'Issued',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleRedeemed',
            filter: {
              module: 'asset',
              method: 'Redeemed',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAssetOwnershipTransferred',
            filter: {
              module: 'asset',
              method: 'AssetOwnershipTransferred',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAssetTransfer',
            filter: {
              module: 'asset',
              method: 'Transfer',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAssetBalanceUpdated',
            filter: {
              module: 'asset',
              method: 'AssetBalanceUpdated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAssetMediatorsAdded',
            filter: {
              module: 'asset',
              method: 'AssetMediatorsAdded',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAssetMediatorsRemoved',
            filter: {
              module: 'asset',
              method: 'AssetMediatorsRemoved',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handlePreApprovedAsset',
            filter: {
              module: 'asset',
              method: 'PreApprovedAsset',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleRemovePreApprovedAsset',
            filter: {
              module: 'asset',
              method: 'RemovePreApprovedAsset',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAssetRenamed',
            filter: {
              module: 'asset',
              method: 'AssetRenamed',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleFundingRoundSet',
            filter: {
              module: 'asset',
              method: 'FundingRoundSet',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleIdentifiersUpdated',
            filter: {
              module: 'asset',
              method: 'IdentifiersUpdated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleDivisibilityChanged',
            filter: {
              module: 'asset',
              method: 'DivisibilityChanged',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleFrozen',
            filter: {
              module: 'asset',
              method: 'AssetFrozen',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleUnfrozen',
            filter: {
              module: 'asset',
              method: 'AssetUnfrozen',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleDidCreated',
            filter: {
              module: 'identity',
              method: 'DidCreated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleChildDidCreated',
            filter: {
              module: 'identity',
              method: 'ChildDidCreated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleChildDidUnlinked',
            filter: {
              module: 'identity',
              method: 'ChildDidUnlinked',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleSecondaryKeysAdded',
            filter: {
              module: 'identity',
              method: 'SecondaryKeysAdded',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleSecondaryKeysFrozen',
            filter: {
              module: 'identity',
              method: 'SecondaryKeysFrozen',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleSecondaryKeysUnfrozen',
            filter: {
              module: 'identity',
              method: 'SecondaryKeysUnfrozen',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleSecondaryKeysRemoved',
            filter: {
              module: 'identity',
              method: 'SecondaryKeysRemoved',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleSecondaryKeysPermissionsUpdated',
            filter: {
              module: 'identity',
              method: 'SecondaryKeyPermissionsUpdated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handlePrimaryKeyUpdated',
            filter: {
              module: 'identity',
              method: 'PrimaryKeyUpdated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleSecondaryKeyLeftIdentity',
            filter: {
              module: 'identity',
              method: 'SecondaryKeyLeftIdentity',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleCustomClaimTypeCreated',
            filter: {
              module: 'identity',
              method: 'CustomClaimTypeAdded',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleNftCollectionCreated',
            filter: {
              module: 'nft',
              method: 'NftCollectionCreated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleNftPortfolioUpdates',
            filter: {
              module: 'nft',
              method: 'NFTPortfolioUpdated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAssetCompliancePaused',
            filter: {
              module: 'complianceManager',
              method: 'AssetCompliancePaused',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAssetComplianceResumed',
            filter: {
              module: 'complianceManager',
              method: 'AssetComplianceResumed',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleComplianceReset',
            filter: {
              module: 'complianceManager',
              method: 'AssetComplianceReset',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleComplianceReplaced',
            filter: {
              module: 'complianceManager',
              method: 'AssetComplianceReplaced',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleComplianceCreated',
            filter: {
              module: 'complianceManager',
              method: 'ComplianceRequirementCreated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleComplianceRemoved',
            filter: {
              module: 'complianceManager',
              method: 'ComplianceRequirementRemoved',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleTrustedDefaultClaimIssuerAdded',
            filter: {
              module: 'complianceManager',
              method: 'TrustedDefaultClaimIssuerAdded',
            },
          },

          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleTrustedDefaultClaimIssuerRemoved',
            filter: {
              module: 'complianceManager',
              method: 'TrustedDefaultClaimIssuerRemoved',
            },
          },

          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleTransferManagerAdded',
            filter: {
              module: 'statistics',
              method: 'TransferManagerAdded',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleTransferManagerRemoved',
            filter: {
              module: 'statistics',
              method: 'TransferManagerRemoved',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleExemptionsAdded',
            filter: {
              module: 'statistics',
              method: 'ExemptionsAdded',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleExemptionsRemoved',
            filter: {
              module: 'statistics',
              method: 'ExemptionsRemoved',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handlePortfolioCreated',
            filter: {
              module: 'portfolio',
              method: 'PortfolioCreated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handlePortfolioRenamed',
            filter: {
              module: 'portfolio',
              method: 'PortfolioRenamed',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handlePortfolioCustodianChanged',
            filter: {
              module: 'portfolio',
              method: 'PortfolioCustodianChanged',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handlePortfolioDeleted',
            filter: {
              module: 'portfolio',
              method: 'PortfolioDeleted',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handlePortfolioMovement',
            filter: {
              module: 'portfolio',
              method: 'MovedBetweenPortfolios',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleFundsMovedBetweenPortfolios',
            filter: {
              module: 'portfolio',
              method: 'FundsMovedBetweenPortfolios',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleVenueCreated',
            filter: {
              module: 'settlement',
              method: 'VenueCreated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleVenueDetailsUpdated',
            filter: {
              module: 'settlement',
              method: 'VenueDetailsUpdated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleVenueTypeUpdated',
            filter: {
              module: 'settlement',
              method: 'VenueTypeUpdated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleVenueSignersUpdated',
            filter: {
              module: 'settlement',
              method: 'VenueSignersUpdated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleInstructionCreated',
            filter: {
              module: 'settlement',
              method: 'InstructionCreated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleMediatorAffirmationReceived',
            filter: {
              module: 'settlement',
              method: 'MediatorAffirmationReceived',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleMediatorAffirmationWithdrawn',
            filter: {
              module: 'settlement',
              method: 'MediatorAffirmationWithdrawn',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleInstructionMediators',
            filter: {
              module: 'settlement',
              method: 'InstructionMediators',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleReceiptClaimed',
            filter: {
              module: 'settlement',
              method: 'ReceiptClaimed',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleInstructionUpdate',
            filter: {
              module: 'settlement',
              method: 'InstructionAuthorized',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleInstructionUpdate',
            filter: {
              module: 'settlement',
              method: 'InstructionUnauthorized',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleInstructionUpdate',
            filter: {
              module: 'settlement',
              method: 'InstructionAffirmed',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAffirmationWithdrawn',
            filter: {
              module: 'settlement',
              method: 'AffirmationWithdrawn',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAutomaticAffirmation',
            filter: {
              module: 'settlement',
              method: 'InstructionAutomaticallyAffirmed',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleInstructionRejected',
            filter: {
              module: 'settlement',
              method: 'InstructionRejected',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleInstructionFinalizedEvent',
            filter: {
              module: 'settlement',
              method: 'InstructionExecuted',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleInstructionFinalizedEvent',
            filter: {
              module: 'settlement',
              method: 'InstructionFailed',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleFailedToExecuteInstruction',
            filter: {
              module: 'settlement',
              method: 'FailedToExecuteInstruction',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleSettlementManuallyExecuted',
            filter: {
              module: 'settlement',
              method: 'SettlementManuallyExecuted',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleStakingEvent',
            filter: {
              module: 'staking',
              method: 'Bonded',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleStakingEvent',
            filter: {
              module: 'staking',
              method: 'Unbonded',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleStakingEvent',
            filter: {
              module: 'staking',
              method: 'Nominated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleStakingEvent',
            filter: {
              module: 'staking',
              method: 'Reward',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleStakingEvent',
            filter: {
              module: 'staking',
              method: 'Slash',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleBridgeEvent',
            filter: {
              module: 'bridge',
              method: 'Bridged',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleFundraiserCreated',
            filter: {
              module: 'sto',
              method: 'FundraiserCreated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleFundraiserCreated',
            filter: {
              module: 'sto',
              method: 'FundraiserCreated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleStoFrozen',
            filter: {
              module: 'sto',
              method: 'FundraiserFrozen',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleStoUnfrozen',
            filter: {
              module: 'sto',
              method: 'FundraiserUnfrozen',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleStoClosed',
            filter: {
              module: 'sto',
              method: 'FundraiserClosed',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleFundraiserWindowModified',
            filter: {
              module: 'sto',
              method: 'FundraiserWindowModified',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleInvested',
            filter: {
              module: 'sto',
              method: 'Invested',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleExternalAgentAdded',
            filter: {
              module: 'externalAgents',
              method: 'AgentAdded',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleExternalAgentRemoved',
            filter: {
              module: 'externalAgents',
              method: 'AgentRemoved',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAuthorization',
            filter: {
              module: 'identity',
              method: 'AuthorizationAdded',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAuthorization',
            filter: {
              module: 'identity',
              method: 'AuthorizationConsumed',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAuthorization',
            filter: {
              module: 'identity',
              method: 'AuthorizationRejected',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAuthorization',
            filter: {
              module: 'identity',
              method: 'AuthorizationRevoked',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleClaimAdded',
            filter: {
              module: 'identity',
              method: 'ClaimAdded',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleClaimRevoked',
            filter: {
              module: 'identity',
              method: 'ClaimRevoked',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleDidRegistered',
            filter: {
              module: 'identity',
              method: 'AssetDidRegistered',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleDistributionCreated',
            filter: {
              module: 'capitalDistribution',
              method: 'Created',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleBenefitClaimed',
            filter: {
              module: 'capitalDistribution',
              method: 'BenefitClaimed',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleReclaimed',
            filter: {
              module: 'capitalDistribution',
              method: 'Reclaimed',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleDistributionRemoved',
            filter: {
              module: 'capitalDistribution',
              method: 'Removed',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleProposalCreated',
            filter: {
              module: 'pips',
              method: 'ProposalCreated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleProposalStateUpdated',
            filter: {
              module: 'pips',
              method: 'ProposalStateUpdated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleVoted',
            filter: {
              module: 'pips',
              method: 'Voted',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleSnapshotTaken',
            filter: {
              module: 'pips',
              method: 'SnapshotTaken',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleSnapshotTaken',
            filter: {
              module: 'pips',
              method: 'SnapshotTaken',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleGroupCreated',
            filter: {
              module: 'externalAgents',
              method: 'GroupCreated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleGroupPermissionsUpdated',
            filter: {
              module: 'externalAgents',
              method: 'GroupPermissionsUpdated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAgentAdded',
            filter: {
              module: 'externalAgents',
              method: 'AgentAdded',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleGroupChanged',
            filter: {
              module: 'externalAgents',
              method: 'GroupChanged',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAgentRemoved',
            filter: {
              module: 'externalAgents',
              method: 'AgentRemoved',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleTreasuryReimbursement',
            filter: {
              module: 'treasury',
              method: 'TreasuryReimbursement',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleTreasuryDisbursement',
            filter: {
              module: 'treasury',
              method: 'TreasuryDisbursement',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleBalanceTransfer',
            filter: {
              module: 'balances',
              method: 'Transfer',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleBalanceEndowed',
            filter: {
              module: 'balances',
              method: 'Endowed',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleBalanceReserved',
            filter: {
              module: 'balances',
              method: 'Reserved',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleBalanceReserved',
            filter: {
              module: 'balances',
              method: 'Reserved',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleBalanceBurned',
            filter: {
              module: 'balances',
              method: 'AccountBalanceBurned',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleBalanceSet',
            filter: {
              module: 'balances',
              method: 'BalanceSet',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleBonded',
            filter: {
              module: 'staking',
              method: 'Bonded',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleUnbonded',
            filter: {
              module: 'staking',
              method: 'Unbonded',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleReward',
            filter: {
              module: 'staking',
              method: 'Reward',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleWithdrawn',
            filter: {
              module: 'staking',
              method: 'Withdrawn',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleFeeCharged',
            filter: {
              module: 'protocolfee',
              method: 'FeeCharged',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleTransactionFeeCharged',
            filter: {
              module: 'transactionPayment',
              method: 'FeeCharged',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleMultiSigCreated',
            filter: {
              module: 'multiSig',
              method: 'MultiSigCreated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleMultiSigSignaturesRequiredChanged',
            filter: {
              module: 'multiSig',
              method: 'MultiSigSignaturesRequiredChanged',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleMultiSigSignerAuthorized',
            filter: {
              module: 'multiSig',
              method: 'MultiSigSignerAuthorized',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleMultiSigSignerAdded',
            filter: {
              module: 'multiSig',
              method: 'MultiSigSignerAdded',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleMultiSigSignerRemoved',
            filter: {
              module: 'multiSig',
              method: 'MultiSigSignerRemoved',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleMultiSigProposalAdded',
            filter: {
              module: 'multiSig',
              method: 'ProposalAdded',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleMultiSigProposalRejected',
            filter: {
              module: 'multiSig',
              method: 'ProposalRejected',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleMultiSigProposalExecuted',
            filter: {
              module: 'multiSig',
              method: 'ProposalExecuted',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleMultiSigVoteApproved',
            filter: {
              module: 'multiSig',
              method: 'ProposalApproved',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleMultiSigVoteRejected',
            filter: {
              module: 'multiSig',
              method: 'ProposalRejectionVote',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleStatTypeAdded',
            filter: {
              module: 'statistics',
              method: 'StatTypesAdded',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleStatTypeRemoved',
            filter: {
              module: 'statistics',
              method: 'StatTypesRemoved',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleSetTransferCompliance',
            filter: {
              module: 'statistics',
              method: 'SetAssetTransferCompliance',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleStatisticExemptionsAdded',
            filter: {
              module: 'statistics',
              method: 'TransferConditionExemptionsAdded',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleStatisticExemptionsRemoved',
            filter: {
              module: 'statistics',
              method: 'TransferConditionExemptionsRemoved',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleStatisticTransferManagerAdded',
            filter: {
              module: 'statistics',
              method: 'TransferManagerAdded',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleTransferManagerExemptionsAdded',
            filter: {
              module: 'statistics',
              method: 'ExemptionsAdded',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleTransferManagerExemptionsRemoved',
            filter: {
              module: 'statistics',
              method: 'ExemptionsRemoved',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAssetIssuedStatistics',
            filter: {
              module: 'asset',
              method: 'Issued',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAssetRedeemedStatistics',
            filter: {
              module: 'asset',
              method: 'Redeemed',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleConfidentialAccountCreated',
            filter: {
              module: 'confidentialAsset',
              method: 'AccountCreated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleConfidentialAssetFrozenForAccount',
            filter: {
              module: 'confidentialAsset',
              method: 'AccountAssetFrozen',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleConfidentialAssetUnfrozenForAccount',
            filter: {
              module: 'confidentialAsset',
              method: 'AccountAssetUnfrozen',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleConfidentialAssetMoveFunds',
            filter: {
              module: 'confidentialAsset',
              method: 'FundsMoved',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleConfidentialAssetCreated',
            filter: {
              module: 'confidentialAsset',
              method: 'AssetCreated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleConfidentialAssetIssuedOrBurned',
            filter: {
              module: 'confidentialAsset',
              method: 'Issued',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleConfidentialAssetIssuedOrBurned',
            filter: {
              module: 'confidentialAsset',
              method: 'Burned',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleVenueFiltering',
            filter: {
              module: 'confidentialAsset',
              method: 'VenueFiltering',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleVenuesAllowed',
            filter: {
              module: 'confidentialAsset',
              method: 'VenuesAllowed',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleVenuesBlocked',
            filter: {
              module: 'confidentialAsset',
              method: 'VenuesBlocked',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleConfidentialVenueCreated',
            filter: {
              module: 'confidentialAsset',
              method: 'VenueCreated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAssetFrozenUnfrozen',
            filter: {
              module: 'confidentialAsset',
              method: 'AssetFrozen',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAssetFrozenUnfrozen',
            filter: {
              module: 'confidentialAsset',
              method: 'Unfrozen',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleConfidentialTransactionCreated',
            filter: {
              module: 'confidentialAsset',
              method: 'TransactionCreated',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleConfidentialTransactionAffirmed',
            filter: {
              module: 'confidentialAsset',
              method: 'TransactionAffirmed',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleConfidentialTransactionExecutedOrRejected',
            filter: {
              module: 'confidentialAsset',
              method: 'TransactionRejected',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleConfidentialTransactionExecutedOrRejected',
            filter: {
              module: 'confidentialAsset',
              method: 'TransactionExecuted',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleConfidentialDepositOrWithdraw',
            filter: {
              module: 'confidentialAsset',
              method: 'AccountDeposit',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleConfidentialDepositOrWithdraw',
            filter: {
              module: 'confidentialAsset',
              method: 'AccountWithdraw',
            },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: 'handleAccountDepositIncoming',
            filter: {
              module: 'confidentialAsset',
              method: 'AccountDepositIncoming',
            },
          },
        ],
      },
    },
    {
      kind: SubstrateDatasourceKind.Runtime,
      startBlock,
      mapping: {
        file: './dist/index.js',
        handlers,
      },
    },
  ],
};

// Must set default to the project instance
export default project;
