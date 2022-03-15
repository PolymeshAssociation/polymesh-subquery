export enum ModuleIdEnum {
  System = 'system',
  Babe = 'babe',
  Timestamp = 'timestamp',
  Indices = 'indices',
  Balances = 'balances',
  Transactionpayment = 'transactionpayment',
  Authorship = 'authorship',
  Staking = 'staking',
  Offences = 'offences',
  Session = 'session',
  Finalitytracker = 'finalitytracker',
  Grandpa = 'grandpa',
  Imonline = 'imonline',
  Authoritydiscovery = 'authoritydiscovery',
  Randomnesscollectiveflip = 'randomnesscollectiveflip',
  Historical = 'historical',
  Sudo = 'sudo',
  Multisig = 'multisig',
  Basecontracts = 'basecontracts',
  Contracts = 'contracts',
  Treasury = 'treasury',
  Polymeshcommittee = 'polymeshcommittee',
  Committeemembership = 'committeemembership',
  Pips = 'pips',
  Technicalcommittee = 'technicalcommittee',
  Technicalcommitteemembership = 'technicalcommitteemembership',
  Upgradecommittee = 'upgradecommittee',
  Upgradecommitteemembership = 'upgradecommitteemembership',
  Asset = 'asset',
  Dividend = 'dividend',
  Identity = 'identity',
  Bridge = 'bridge',
  Compliancemanager = 'compliancemanager',
  Externalagents = 'externalagents',
  Voting = 'voting',
  Stocapped = 'stocapped',
  Exemption = 'exemption',
  Settlement = 'settlement',
  Sto = 'sto',
  Cddserviceproviders = 'cddserviceproviders',
  Statistics = 'statistics',
  Protocolfee = 'protocolfee',
  Utility = 'utility',
  Portfolio = 'portfolio',
  Confidential = 'confidential',
  Permissions = 'permissions',
  Scheduler = 'scheduler',
  Corporateaction = 'corporateaction',
  Corporateballot = 'corporateballot',
  Capitaldistribution = 'capitaldistribution',
  Checkpoint = 'checkpoint',
  Testnet = 'testnet',
  Rewards = 'rewards',
  Relayer = 'relayer',
}

export enum EventIdEnum {
  ExtrinsicSuccess = 'ExtrinsicSuccess',
  ExtrinsicFailed = 'ExtrinsicFailed',
  CodeUpdated = 'CodeUpdated',
  NewAccount = 'NewAccount',
  KilledAccount = 'KilledAccount',
  IndexAssigned = 'IndexAssigned',
  IndexFreed = 'IndexFreed',
  IndexFrozen = 'IndexFrozen',
  Endowed = 'Endowed',
  Transfer = 'Transfer',
  BalanceSet = 'BalanceSet',
  AccountBalanceBurned = 'AccountBalanceBurned',
  Reserved = 'Reserved',
  Unreserved = 'Unreserved',
  ReserveRepatriated = 'ReserveRepatriated',
  EraPayout = 'EraPayout',
  Reward = 'Reward',
  Slash = 'Slash',
  OldSlashingReportDiscarded = 'OldSlashingReportDiscarded',
  StakingElection = 'StakingElection',
  SolutionStored = 'SolutionStored',
  Bonded = 'Bonded',
  Unbonded = 'Unbonded',
  Nominated = 'Nominated',
  Withdrawn = 'Withdrawn',
  PermissionedValidatorAdded = 'PermissionedValidatorAdded',
  PermissionedValidatorRemoved = 'PermissionedValidatorRemoved',
  PermissionedValidatorStatusChanged = 'PermissionedValidatorStatusChanged',
  PermissionedIdentityAdded = 'PermissionedIdentityAdded',
  PermissionedIdentityRemoved = 'PermissionedIdentityRemoved',
  InvalidatedNominators = 'InvalidatedNominators',
  CommissionCapUpdated = 'CommissionCapUpdated',
  IndividualCommissionEnabled = 'IndividualCommissionEnabled',
  GlobalCommissionUpdated = 'GlobalCommissionUpdated',
  MinimumBondThresholdUpdated = 'MinimumBondThresholdUpdated',
  RewardPaymentSchedulingInterrupted = 'RewardPaymentSchedulingInterrupted',
  SlashingAllowedForChanged = 'SlashingAllowedForChanged',
  Offence = 'Offence',
  NewSession = 'NewSession',
  NewAuthorities = 'NewAuthorities',
  Paused = 'Paused',
  Resumed = 'Resumed',
  HeartbeatReceived = 'HeartbeatReceived',
  AllGood = 'AllGood',
  SomeOffline = 'SomeOffline',
  SlashingParamsUpdated = 'SlashingParamsUpdated',
  Sudid = 'Sudid',
  KeyChanged = 'KeyChanged',
  SudoAsDone = 'SudoAsDone',
  MultiSigCreated = 'MultiSigCreated',
  ProposalAdded = 'ProposalAdded',
  ProposalExecuted = 'ProposalExecuted',
  MultiSigSignerAdded = 'MultiSigSignerAdded',
  MultiSigSignerAuthorized = 'MultiSigSignerAuthorized',
  MultiSigSignerRemoved = 'MultiSigSignerRemoved',
  MultiSigSignaturesRequiredChanged = 'MultiSigSignaturesRequiredChanged',
  ProposalApproved = 'ProposalApproved',
  ProposalRejectionVote = 'ProposalRejectionVote',
  ProposalRejected = 'ProposalRejected',
  ProposalExecutionFailed = 'ProposalExecutionFailed',
  Instantiated = 'Instantiated',
  Evicted = 'Evicted',
  Restored = 'Restored',
  CodeStored = 'CodeStored',
  ScheduleUpdated = 'ScheduleUpdated',
  ContractExecution = 'ContractExecution',
  InstantiationFeeChanged = 'InstantiationFeeChanged',
  InstantiationFreezed = 'InstantiationFreezed',
  InstantiationUnFreezed = 'InstantiationUnFreezed',
  TemplateOwnershipTransferred = 'TemplateOwnershipTransferred',
  TemplateUsageFeeChanged = 'TemplateUsageFeeChanged',
  TemplateInstantiationFeeChanged = 'TemplateInstantiationFeeChanged',
  TemplateMetaUrlChanged = 'TemplateMetaUrlChanged',
  PutCodeFlagChanged = 'PutCodeFlagChanged',
  TreasuryDisbursement = 'TreasuryDisbursement',
  TreasuryReimbursement = 'TreasuryReimbursement',
  Proposed = 'Proposed',
  Voted = 'Voted',
  VoteRetracted = 'VoteRetracted',
  FinalVotes = 'FinalVotes',
  Approved = 'Approved',
  Rejected = 'Rejected',
  Executed = 'Executed',
  Closed = 'Closed',
  ReleaseCoordinatorUpdated = 'ReleaseCoordinatorUpdated',
  ExpiresAfterUpdated = 'ExpiresAfterUpdated',
  VoteThresholdUpdated = 'VoteThresholdUpdated',
  VoteEnactReferendum = 'VoteEnactReferendum',
  VoteRejectReferendum = 'VoteRejectReferendum',
  MemberAdded = 'MemberAdded',
  MemberRemoved = 'MemberRemoved',
  MemberRevoked = 'MemberRevoked',
  MembersSwapped = 'MembersSwapped',
  MembersReset = 'MembersReset',
  ActiveLimitChanged = 'ActiveLimitChanged',
  Dummy = 'Dummy',
  HistoricalPipsPruned = 'HistoricalPipsPruned',
  ProposalCreated = 'ProposalCreated',
  ProposalDetailsAmended = 'ProposalDetailsAmended',
  ProposalBondAdjusted = 'ProposalBondAdjusted',
  ProposalStateUpdated = 'ProposalStateUpdated',
  PipClosed = 'PipClosed',
  ExecutionScheduled = 'ExecutionScheduled',
  ReferendumCreated = 'ReferendumCreated',
  ReferendumScheduled = 'ReferendumScheduled',
  ReferendumStateUpdated = 'ReferendumStateUpdated',
  DefaultEnactmentPeriodChanged = 'DefaultEnactmentPeriodChanged',
  MinimumProposalDepositChanged = 'MinimumProposalDepositChanged',
  QuorumThresholdChanged = 'QuorumThresholdChanged',
  ProposalCoolOffPeriodChanged = 'ProposalCoolOffPeriodChanged',
  PendingPipExpiryChanged = 'PendingPipExpiryChanged',
  MaxPipSkipCountChanged = 'MaxPipSkipCountChanged',
  ActivePipLimitChanged = 'ActivePipLimitChanged',
  ProposalDurationChanged = 'ProposalDurationChanged',
  ProposalRefund = 'ProposalRefund',
  SnapshotCleared = 'SnapshotCleared',
  SnapshotTaken = 'SnapshotTaken',
  PipSkipped = 'PipSkipped',
  SnapshotResultsEnacted = 'SnapshotResultsEnacted',
  Approval = 'Approval',
  Issued = 'Issued',
  Redeemed = 'Redeemed',
  ControllerTransfer = 'ControllerTransfer',
  ControllerRedemption = 'ControllerRedemption',
  AssetCreated = 'AssetCreated',
  IdentifiersUpdated = 'IdentifiersUpdated',
  DivisibilityChanged = 'DivisibilityChanged',
  TransferWithData = 'TransferWithData',
  IsIssuable = 'IsIssuable',
  TickerRegistered = 'TickerRegistered',
  TickerTransferred = 'TickerTransferred',
  AssetOwnershipTransferred = 'AssetOwnershipTransferred',
  AssetFrozen = 'AssetFrozen',
  AssetUnfrozen = 'AssetUnfrozen',
  AssetRenamed = 'AssetRenamed',
  FundingRoundSet = 'FundingRoundSet',
  ExtensionAdded = 'ExtensionAdded',
  ExtensionArchived = 'ExtensionArchived',
  ExtensionUnArchive = 'ExtensionUnArchive',
  CheckpointCreated = 'CheckpointCreated',
  PrimaryIssuanceAgentTransferred = 'PrimaryIssuanceAgentTransferred',
  PrimaryIssuanceAgentTransfered = 'PrimaryIssuanceAgentTransfered',
  DocumentAdded = 'DocumentAdded',
  DocumentRemoved = 'DocumentRemoved',
  ExtensionRemoved = 'ExtensionRemoved',
  ClassicTickerClaimed = 'ClassicTickerClaimed',
  CustomAssetTypeExists = 'CustomAssetTypeExists',
  CustomAssetTypeRegistered = 'CustomAssetTypeRegistered',
  DividendCreated = 'DividendCreated',
  DividendCanceled = 'DividendCanceled',
  DividendPaidOutToUser = 'DividendPaidOutToUser',
  DividendRemainingClaimed = 'DividendRemainingClaimed',
  DidCreated = 'DidCreated',
  SecondaryKeysAdded = 'SecondaryKeysAdded',
  SecondaryKeysRemoved = 'SecondaryKeysRemoved',
  SignerLeft = 'SignerLeft',
  SecondaryKeyPermissionsUpdated = 'SecondaryKeyPermissionsUpdated',
  SecondaryPermissionsUpdated = 'SecondaryPermissionsUpdated',
  PrimaryKeyUpdated = 'PrimaryKeyUpdated',
  ClaimAdded = 'ClaimAdded',
  ClaimRevoked = 'ClaimRevoked',
  DidStatus = 'DidStatus',
  CddStatus = 'CddStatus',
  AssetDidRegistered = 'AssetDidRegistered',
  AuthorizationAdded = 'AuthorizationAdded',
  AuthorizationRevoked = 'AuthorizationRevoked',
  AuthorizationRejected = 'AuthorizationRejected',
  AuthorizationConsumed = 'AuthorizationConsumed',
  OffChainAuthorizationRevoked = 'OffChainAuthorizationRevoked',
  CddRequirementForPrimaryKeyUpdated = 'CddRequirementForPrimaryKeyUpdated',
  CddClaimsInvalidated = 'CddClaimsInvalidated',
  SecondaryKeysFrozen = 'SecondaryKeysFrozen',
  SecondaryKeysUnfrozen = 'SecondaryKeysUnfrozen',
  UnexpectedError = 'UnexpectedError',
  ControllerChanged = 'ControllerChanged',
  AdminChanged = 'AdminChanged',
  TimelockChanged = 'TimelockChanged',
  Bridged = 'Bridged',
  Frozen = 'Frozen',
  Unfrozen = 'Unfrozen',
  FrozenTx = 'FrozenTx',
  UnfrozenTx = 'UnfrozenTx',
  ExemptedUpdated = 'ExemptedUpdated',
  BridgeLimitUpdated = 'BridgeLimitUpdated',
  TxsHandled = 'TxsHandled',
  BridgeTxScheduled = 'BridgeTxScheduled',
  FreezeAdminAdded = 'FreezeAdminAdded',
  FreezeAdminRemoved = 'FreezeAdminRemoved',
  BridgeTxScheduleFailed = 'BridgeTxScheduleFailed',
  ComplianceRequirementCreated = 'ComplianceRequirementCreated',
  ComplianceRequirementRemoved = 'ComplianceRequirementRemoved',
  AssetComplianceReplaced = 'AssetComplianceReplaced',
  AssetComplianceReset = 'AssetComplianceReset',
  AssetComplianceResumed = 'AssetComplianceResumed',
  AssetCompliancePaused = 'AssetCompliancePaused',
  ComplianceRequirementChanged = 'ComplianceRequirementChanged',
  TrustedDefaultClaimIssuerAdded = 'TrustedDefaultClaimIssuerAdded',
  TrustedDefaultClaimIssuerRemoved = 'TrustedDefaultClaimIssuerRemoved',
  BallotCreated = 'BallotCreated',
  VoteCast = 'VoteCast',
  BallotCancelled = 'BallotCancelled',
  AssetPurchased = 'AssetPurchased',
  ExemptionListModified = 'ExemptionListModified',
  VenueCreated = 'VenueCreated',
  VenueUpdated = 'VenueUpdated',
  InstructionCreated = 'InstructionCreated',
  InstructionAuthorized = 'InstructionAuthorized',
  InstructionUnauthorized = 'InstructionUnauthorized',
  InstructionAffirmed = 'InstructionAffirmed',
  AffirmationWithdrawn = 'AffirmationWithdrawn',
  InstructionRejected = 'InstructionRejected',
  ReceiptClaimed = 'ReceiptClaimed',
  ReceiptValidityChanged = 'ReceiptValidityChanged',
  ReceiptUnclaimed = 'ReceiptUnclaimed',
  VenueFiltering = 'VenueFiltering',
  VenuesAllowed = 'VenuesAllowed',
  VenuesBlocked = 'VenuesBlocked',
  LegFailedExecution = 'LegFailedExecution',
  InstructionRescheduled = 'InstructionRescheduled',
  InstructionFailed = 'InstructionFailed',
  InstructionExecuted = 'InstructionExecuted',
  VenueUnauthorized = 'VenueUnauthorized',
  VenueDetailsUpdated = 'VenueDetailsUpdated',
  VenueTypeUpdated = 'VenueTypeUpdated',
  FundraiserCreated = 'FundraiserCreated',
  FundsRaised = 'FundsRaised',
  FundraiserWindowModifed = 'FundraiserWindowModifed',
  FundraiserClosed = 'FundraiserClosed',
  FundraiserFrozen = 'FundraiserFrozen',
  FundraiserUnfrozen = 'FundraiserUnfrozen',
  TransferManagerAdded = 'TransferManagerAdded',
  TransferManagerRemoved = 'TransferManagerRemoved',
  ExemptionsAdded = 'ExemptionsAdded',
  ExemptionsRemoved = 'ExemptionsRemoved',
  FeeSet = 'FeeSet',
  CoefficientSet = 'CoefficientSet',
  FeeCharged = 'FeeCharged',
  BatchInterrupted = 'BatchInterrupted',
  BatchOptimisticFailed = 'BatchOptimisticFailed',
  BatchCompleted = 'BatchCompleted',
  PortfolioCreated = 'PortfolioCreated',
  PortfolioDeleted = 'PortfolioDeleted',
  MovedBetweenPortfolios = 'MovedBetweenPortfolios',
  PortfolioRenamed = 'PortfolioRenamed',
  UserPortfolios = 'UserPortfolios',
  PortfolioCustodianChanged = 'PortfolioCustodianChanged',
  RangeProofAdded = 'RangeProofAdded',
  RangeProofVerified = 'RangeProofVerified',
  Scheduled = 'Scheduled',
  Canceled = 'Canceled',
  Dispatched = 'Dispatched',
  MaxDetailsLengthChanged = 'MaxDetailsLengthChanged',
  DefaultTargetIdentitiesChanged = 'DefaultTargetIdentitiesChanged',
  DefaultWithholdingTaxChanged = 'DefaultWithholdingTaxChanged',
  DidWithholdingTaxChanged = 'DidWithholdingTaxChanged',
  CaaTransferred = 'CAATransferred',
  CaInitiated = 'CAInitiated',
  CaLinkedToDoc = 'CALinkedToDoc',
  CaRemoved = 'CARemoved',
  RecordDateChanged = 'RecordDateChanged',
  Created = 'Created',
  RangeChanged = 'RangeChanged',
  MetaChanged = 'MetaChanged',
  RcvChanged = 'RCVChanged',
  Removed = 'Removed',
  BenefitClaimed = 'BenefitClaimed',
  Reclaimed = 'Reclaimed',
  MaximumSchedulesComplexityChanged = 'MaximumSchedulesComplexityChanged',
  ScheduleCreated = 'ScheduleCreated',
  ScheduleRemoved = 'ScheduleRemoved',
  GroupCreated = 'GroupCreated',
  GroupPermissionsUpdated = 'GroupPermissionsUpdated',
  AgentAdded = 'AgentAdded',
  AgentRemoved = 'AgentRemoved',
  GroupChanged = 'GroupChanged',
  AuthorizedPayingKey = 'AuthorizedPayingKey',
  AcceptedPayingKey = 'AcceptedPayingKey',
  RemovedPayingKey = 'RemovedPayingKey',
  UpdatedPolyxLimit = 'UpdatedPolyxLimit',
  ItnRewardClaimed = 'ItnRewardClaimed',
  CustodyTransfer = 'CustodyTransfer',
  CustodyAllowanceChanged = 'CustodyAllowanceChanged',
  TreasuryDidSet = 'TreasuryDidSet',
  SigningKeysAdded = 'SigningKeysAdded',
  SigningKeysRemoved = 'SigningKeysRemoved',
  SigningPermissionsUpdated = 'SigningPermissionsUpdated',
  MasterKeyUpdated = 'MasterKeyUpdated',
  CddRequirementForMasterKeyUpdated = 'CddRequirementForMasterKeyUpdated',
  SigningKeysFrozen = 'SigningKeysFrozen',
  SigningKeysUnfrozen = 'SigningKeysUnfrozen',
  NewAssetRuleCreated = 'NewAssetRuleCreated',
  AssetRuleRemoved = 'AssetRuleRemoved',
  AssetRulesReplaced = 'AssetRulesReplaced',
  AssetRulesReset = 'AssetRulesReset',
  AssetRulesResumed = 'AssetRulesResumed',
  AssetRulesPaused = 'AssetRulesPaused',
  AssetRuleChanged = 'AssetRuleChanged',
  Invested = 'Invested',
}

export enum CallIdEnum {
  CreateAsset = 'createAsset',
  AddDocuments = 'addDocuments',
  RemoveDocuments = 'removeDocuments',
  SetFundingRound = 'setFundingRound',
  RenameAsset = 'renameAsset',
  UpdateIdentifiers = 'updateIdentifiers',
  MakeDivisible = 'makeDivisible',
  Issue = 'issue',
  Redeem = 'redeem',
  Freeze = 'freeze',
  Unfreeze = 'unfreeze',
  AddAndAffirmInstruction = 'addAndAffirmInstruction',
  AffirmInstruction = 'affirmInstruction',
  RejectInstruction = 'rejectInstruction',
  AddAuthorization = 'addAuthorization',
  RemoveAuthorization = 'removeAuthorization',
  AcceptAssetOwnershipTransfer = 'acceptAssetOwnershipTransfer',
  AcceptBecomeAgent = 'acceptBecomeAgent',
  PauseAssetCompliance = 'pauseAssetCompliance',
  ResumeAssetCompliance = 'resumeAssetCompliance',
  ResetAssetCompliance = 'resetAssetCompliance',
  AddComplianceRequirement = 'addComplianceRequirement',
  RemoveComplianceRequirement = 'removeComplianceRequirement',
  AddTransferManager = 'addTransferManager',
  RemoveTransferManager = 'removeTransferManager',
  AddExemptedEntities = 'addExemptedEntities',
  RemoveExemptedEntities = 'removeExemptedEntities',
}

export enum ClaimTypeEnum {
  Accredited = 'Accredited',
  Affiliate = 'Affiliate',
  BuyLockup = 'BuyLockup',
  SellLockup = 'SellLockup',
  CustomerDueDiligence = 'CustomerDueDiligence',
  KnowYourCustomer = 'KnowYourCustomer',
  Jurisdiction = 'Jurisdiction',
  Exempted = 'Exempted',
  Blocked = 'Blocked',
  InvestorUniqueness = 'InvestorUniqueness',
  NoData = 'NoData',
  InvestorUniquenessV2 = 'InvestorUniquenessV2',
}

export enum AuthorizationTypeEnum {
  TransferAssetOwnership = 'TransferAssetOwnership',
}

export enum AgentTypeEnum {
  Full = 'Full',
}
