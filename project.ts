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
  asset: {
    AssetBalanceUpdated: ['handleAssetBalanceUpdated'],
    AssetCreated: ['handleAssetCreated'],
    AssetFrozen: ['handleFrozen'],
    AssetOwnershipTransferred: ['handleAssetOwnershipTransferred'],
    AssetRenamed: ['handleAssetRenamed'],
    AssetTypeChanged: [],
    AssetUnfrozen: ['handleUnfrozen'],
    ControllerTransfer: [],
    CustomAssetTypeExists: [],
    CustomAssetTypeRegistered: [],
    DivisibilityChanged: ['handleDivisibilityChanged'],
    DocumentAdded: ['handleDocumentAdded'],
    DocumentRemoved: ['handleDocumentRemoved'],
    ExtensionRemoved: [],
    FundingRoundSet: ['handleFundingRoundSet'],
    IdentifiersUpdated: ['handleIdentifiersUpdated'],
    IsIssuable: [],
    Issued: ['handleIssued', 'handleAssetIssuedStatistics'],
    LocalMetadataKeyDeleted: [],
    MetadataValueDeleted: [],
    Redeemed: ['handleRedeemed', 'handleAssetRedeemedStatistics'],
    RegisterAssetMetadataGlobalType: [],
    RegisterAssetMetadataLocalType: [],
    SetAssetMetadataValue: [],
    SetAssetMetadataValueDetails: [],
    TickerRegistered: [],
    TickerTransferred: [],
    Transfer: ['handleAssetTransfer'],
    TransferWithData: [],
    PreApprovedAsset: ['handlePreApprovedAsset'],
    RemovePreApprovedAsset: ['handleRemovePreApprovedAsset'],
    AssetMediatorsAdded: ['handleAssetMediatorsAdded'],
    AssetMediatorsRemoved: ['handleAssetMediatorsRemoved'],
  },
  balances: {
    AccountBalanceBurned: ['handleBalanceBurned'],
    BalanceSet: ['handleBalanceSet'],
    Endowed: ['handleBalanceEndowed'],
    ReserveRepatriated: [],
    Reserved: ['handleBalanceReserved'],
    Transfer: ['handleBalanceTransfer'],
    Unreserved: [],
  },
  bridge: {
    AdminChanged: [],
    BridgeLimitUpdated: [],
    BridgeTxFailed: [],
    BridgeTxScheduleFailed: [],
    BridgeTxScheduled: [],
    Bridged: ['handleBridgeEvent'],
    ControllerChanged: [],
    ExemptedUpdated: [],
    FreezeAdminAdded: [],
    FreezeAdminRemoved: [],
    Frozen: [],
    FrozenTx: [],
    TimelockChanged: [],
    TxRemoved: [],
    TxsHandled: [],
    Unfrozen: [],
    UnfrozenTx: [],
  },
  capitalDistribution: {
    BenefitClaimed: ['handleBenefitClaimed'],
    Created: ['handleDistributionCreated'],
    Reclaimed: ['handleReclaimed'],
    Removed: ['handleDistributionRemoved'],
  },
  checkpoint: {
    CheckpointCreated: [],
    MaximumSchedulesComplexityChanged: [],
    ScheduleCreated: [],
    ScheduleRemoved: [],
  },
  complianceManager: {
    AssetCompliancePaused: ['handleAssetCompliancePaused'],
    AssetComplianceReplaced: ['handleComplianceReplaced'],
    AssetComplianceReset: ['handleComplianceReset'],
    AssetComplianceResumed: ['handleAssetComplianceResumed'],
    ComplianceRequirementChanged: [],
    ComplianceRequirementCreated: ['handleComplianceCreated'],
    ComplianceRequirementRemoved: ['handleComplianceRemoved'],
    TrustedDefaultClaimIssuerAdded: ['handleTrustedDefaultClaimIssuerAdded'],
    TrustedDefaultClaimIssuerRemoved: ['handleTrustedDefaultClaimIssuerRemoved'],
  },
  confidentialAsset: {
    AccountCreated: ['handleConfidentialAccountCreated'],
    AccountDeposit: ['handleConfidentialDepositOrWithdraw'],
    AccountDepositIncoming: ['handleAccountDepositIncoming'],
    AccountWithdraw: ['handleConfidentialDepositOrWithdraw'],
    AccountAssetFrozen: ['handleConfidentialAssetFrozenForAccount'],
    AccountAssetUnfrozen: ['handleConfidentialAssetUnfrozenForAccount'],
    AssetCreated: ['handleConfidentialAssetCreated'],
    AssetFrozen: ['handleAssetFrozenUnfrozen'],
    AssetUnfrozen: ['handleAssetFrozenUnfrozen'],
    AssetBurned: ['handleConfidentialAssetIssuedOrBurned'],
    Issued: ['handleConfidentialAssetIssuedOrBurned'],
    Burned: ['handleConfidentialAssetIssuedOrBurned'],
    TransactionAffirmed: ['handleConfidentialTransactionAffirmed'],
    TransactionCreated: ['handleConfidentialTransactionCreated'],
    TransactionExecuted: ['handleConfidentialTransactionExecutedOrRejected'],
    TransactionRejected: ['handleConfidentialTransactionExecutedOrRejected'],
    VenueCreated: ['handleConfidentialVenueCreated'],
    VenueFiltering: ['handleVenueFiltering'],
    VenuesAllowed: ['handleVenuesAllowed'],
    VenuesBlocked: ['handleVenuesBlocked'],
    FundsMoved: ['handleConfidentialAssetMoveFunds'],
  },
  corporateAction: {
    CAInitiated: [],
    CALinkedToDoc: [],
    CARemoved: [],
    DefaultTargetIdentitiesChanged: [],
    DefaultWithholdingTaxChanged: [],
    DidWithholdingTaxChanged: [],
    MaxDetailsLengthChanged: [],
    RecordDateChanged: [],
  },
  corporateBallot: {
    Created: [],
    MetaChanged: [],
    RCVChanged: [],
    RangeChanged: [],
    Removed: [],
    VoteCast: [],
  },
  externalAgents: {
    AgentAdded: ['handleExternalAgentAdded', 'handleAgentAdded'],
    AgentRemoved: ['handleExternalAgentRemoved', 'handleAgentRemoved'],
    GroupChanged: ['handleGroupChanged'],
    GroupCreated: ['handleGroupCreated'],
    GroupPermissionsUpdated: ['handleGroupPermissionsUpdated'],
  },
  identity: {
    AssetDidRegistered: ['handleDidRegistered'],
    AuthorizationAdded: ['handleAuthorization'],
    AuthorizationConsumed: ['handleAuthorization'],
    AuthorizationRejected: ['handleAuthorization'],
    AuthorizationRetryLimitReached: [],
    AuthorizationRevoked: ['handleAuthorization'],
    CddClaimsInvalidated: [],
    CddRequirementForPrimaryKeyUpdated: [],
    ChildDidCreated: ['handleChildDidCreated'],
    ChildDidUnlinked: ['handleChildDidUnlinked'],
    ClaimAdded: ['handleClaimAdded'],
    ClaimRevoked: ['handleClaimRevoked'],
    CustomClaimTypeAdded: ['handleCustomClaimTypeCreated'],
    DidCreated: ['handleDidCreated'],
    PrimaryKeyUpdated: ['handlePrimaryKeyUpdated'],
    SecondaryKeyLeftIdentity: ['handleSecondaryKeyLeftIdentity'],
    SecondaryKeyPermissionsUpdated: ['handleSecondaryKeysPermissionsUpdated'],
    SecondaryKeysAdded: ['handleSecondaryKeysAdded'],
    SecondaryKeysFrozen: ['handleSecondaryKeysFrozen'],
    SecondaryKeysRemoved: ['handleSecondaryKeysRemoved'],
    SecondaryKeysUnfrozen: ['handleSecondaryKeysUnfrozen'],
  },
  multiSig: {
    MultiSigCreated: ['handleMultiSigCreated'],
    MultiSigSignaturesRequiredChanged: ['handleMultiSigSignaturesRequiredChanged'],
    MultiSigSignerAdded: ['handleMultiSigSignerAdded'],
    MultiSigSignerAuthorized: ['handleMultiSigSignerAuthorized'],
    MultiSigSignerRemoved: ['handleMultiSigSignerRemoved'],
    ProposalAdded: ['handleMultiSigProposalAdded'],
    ProposalApproved: ['handleMultiSigVoteApproved'],
    ProposalExecuted: ['handleMultiSigProposalExecuted'],
    ProposalExecutionFailed: [],
    ProposalRejected: ['handleMultiSigProposalRejected'],
    ProposalRejectionVote: ['handleMultiSigVoteRejected'],
    SchedulingFailed: [],
    ProposalFailedToExecute: [],
  },
  nft: {
    NFTPortfolioUpdated: ['handleNftPortfolioUpdates'],
    NftCollectionCreated: ['handleNftCollectionCreated'],
  },
  pips: {
    ActivePipLimitChanged: [],
    DefaultEnactmentPeriodChanged: [],
    ExecutionCancellingFailed: [],
    ExecutionScheduled: [],
    ExecutionSchedulingFailed: [],
    ExpiryScheduled: [],
    ExpirySchedulingFailed: [],
    HistoricalPipsPruned: [],
    MaxPipSkipCountChanged: [],
    MinimumProposalDepositChanged: [],
    PendingPipExpiryChanged: [],
    PipClosed: [],
    PipSkipped: [],
    ProposalCreated: ['handleProposalCreated'],
    ProposalRefund: [],
    ProposalStateUpdated: ['handleProposalStateUpdated'],
    SnapshotCleared: [],
    SnapshotResultsEnacted: [],
    SnapshotTaken: ['handleSnapshotTaken'],
    Voted: ['handleVoted'],
  },
  portfolio: {
    FundsMovedBetweenPortfolios: ['handleFundsMovedBetweenPortfolios'],
    MovedBetweenPortfolios: ['handlePortfolioMovement'],
    PortfolioCreated: ['handlePortfolioCreated'],
    PortfolioCustodianChanged: ['handlePortfolioCustodianChanged'],
    PortfolioDeleted: ['handlePortfolioDeleted'],
    PortfolioRenamed: ['handlePortfolioRenamed'],
    UserPortfolios: [],
  },
  protocolFee: {
    FeeCharged: ['handleFeeCharged'],
  },
  settlement: {
    AffirmationWithdrawn: ['handleAffirmationWithdrawn'],
    FailedToExecuteInstruction: ['handleFailedToExecuteInstruction'],
    InstructionAuthorized: ['handleInstructionUpdate'],
    InstructionUnauthorized: ['handleInstructionUpdate'],
    InstructionAffirmed: ['handleInstructionUpdate'],
    InstructionCreated: ['handleInstructionCreated'],
    InstructionExecuted: ['handleInstructionFinalizedEvent'],
    InstructionFailed: ['handleInstructionFinalizedEvent'],
    InstructionRejected: ['handleInstructionRejected'],
    InstructionRescheduled: [],
    InstructionAutomaticallyAffirmed: ['handleAutomaticAffirmation'],
    MediatorAffirmationReceived: ['handleMediatorAffirmationReceived'],
    MediatorAffirmationWithdrawn: ['handleMediatorAffirmationWithdrawn'],
    InstructionMediators: ['handleInstructionMediators'],
    LegFailedExecution: [],
    ReceiptClaimed: ['handleReceiptClaimed'],
    SchedulingFailed: [],
    SettlementManuallyExecuted: ['handleSettlementManuallyExecuted'],
    VenueCreated: ['handleVenueCreated'],
    VenueDetailsUpdated: ['handleVenueDetailsUpdated'],
    VenueFiltering: [],
    VenueSignersUpdated: ['handleVenueSignersUpdated'],
    VenueTypeUpdated: ['handleVenueTypeUpdated'],
    VenueUnauthorized: [],
    VenuesAllowed: [],
    VenuesBlocked: [],
  },
  staking: {
    Bonded: ['handleStakingEvent', 'handleBonded'],
    CommissionCapUpdated: [],
    EraPayout: [],
    InvalidatedNominators: [],
    MinimumBondThresholdUpdated: [],
    Nominated: ['handleStakingEvent'],
    OldSlashingReportDiscarded: [],
    PermissionedIdentityAdded: [],
    PermissionedIdentityRemoved: [],
    Reward: ['handleStakingEvent', 'handleReward'],
    RewardPaymentSchedulingInterrupted: [],
    Slash: ['handleStakingEvent'],
    SlashingAllowedForChanged: [],
    SolutionStored: [],
    StakingElection: [],
    Unbonded: ['handleStakingEvent', 'handleUnbonded'],
    Withdrawn: ['handleWithdrawn'],
  },
  statistics: {
    AssetStatsUpdated: [],
    SetAssetTransferCompliance: ['handleSetTransferCompliance'],
    StatTypesAdded: ['handleStatTypeAdded'],
    StatTypesRemoved: ['handleStatTypeRemoved'],
    TransferManagerAdded: ['handleTransferManagerAdded', 'handleStatisticTransferManagerAdded'],
    TransferManagerRemoved: ['handleTransferManagerRemoved'],
    ExemptionsAdded: ['handleExemptionsAdded', 'handleTransferManagerExemptionsAdded'],
    ExemptionsRemoved: ['handleExemptionsRemoved', 'handleTransferManagerExemptionsRemoved'],
    TransferConditionExemptionsAdded: ['handleStatisticExemptionsAdded'],
    TransferConditionExemptionsRemoved: ['handleStatisticExemptionsRemoved'],
  },
  sto: {
    FundraiserClosed: ['handleStoClosed'],
    FundraiserCreated: ['handleFundraiserCreated'],
    FundraiserFrozen: ['handleStoFrozen'],
    FundraiserUnfrozen: ['handleStoUnfrozen'],
    FundraiserWindowModified: ['handleFundraiserWindowModified'],
    Invested: ['handleInvested'],
  },
  system: {
    CodeUpdated: ['handleMigration'],
    NewAccount: [],
  },
  transactionPayment: {
    TransactionFeePaid: [],
    FeeCharged: ['handleTransactionFeeCharged'],
  },
  treasury: {
    TreasuryDisbursement: ['handleTreasuryDisbursement'],
    TreasuryDisbursementFailed: [],
    TreasuryReimbursement: ['handleTreasuryReimbursement'],
  },
};

const handlers: SubstrateEventHandler[] = [];
const eventSpecificHandlers: SubstrateEventHandler[] = [];

Object.keys(filters).forEach(module => {
  Object.keys(filters[module]).forEach(method => {
    handlers.push({
      kind: SubstrateHandlerKind.Event,
      handler: 'handleEvent',
      filter: {
        module,
        method,
      },
    } as SubstrateEventHandler);

    if (filters[module][method].length > 0) {
      const handlerList = filters[module][method];

      handlerList.forEach(handler => {
        eventSpecificHandlers.push({
          kind: SubstrateHandlerKind.Event,
          handler,
          filter: {
            module,
            method,
          },
        } as SubstrateEventHandler);
      });
    }
  });
});

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
        handlers: eventSpecificHandlers,
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
