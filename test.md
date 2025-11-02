# All Events by Module

Complete list of all events in `augment-api-events.ts` organized by module.

## asset (32 events)

1. AssetAffirmationExemption
2. AssetBalanceUpdated
3. AssetCreated
4. AssetFrozen
5. AssetMediatorsAdded
6. AssetMediatorsRemoved
7. AssetOwnershipTransferred
8. AssetRenamed
9. AssetTypeChanged
10. AssetUnfrozen
11. ControllerTransfer
12. CustomAssetTypeExists
13. CustomAssetTypeRegistered
14. DivisibilityChanged
15. DocumentAdded
16. DocumentRemoved
17. FundingRoundSet
18. GlobalMetadataSpecUpdated
19. IdentifiersUpdated
20. LocalMetadataKeyDeleted
21. MetadataValueDeleted
22. PreApprovedAsset
23. RegisterAssetMetadataGlobalType
24. RegisterAssetMetadataLocalType
25. RemoveAssetAffirmationExemption
26. RemovePreApprovedAsset
27. SetAssetMetadataValue
28. SetAssetMetadataValueDetails
29. TickerLinkedToAsset
30. TickerRegistered
31. TickerTransferred
32. TickerUnlinkedFromAsset

## balances (23 events)

1. BalanceSet
2. Burned
3. Deposit
4. DustLost
5. Endowed
6. Frozen
7. Issued
8. Locked
9. Minted
10. Rescinded
11. Reserved
12. ReserveRepatriated
13. Restored
14. Slashed
15. Suspended
16. Thawed
17. TotalIssuanceForced
18. Transfer
19. TransferMemo
20. Unlocked
21. Unreserved
22. Upgraded
23. Withdraw

## base (1 event)

1. UnexpectedError

## capitalDistribution (4 events)

1. BenefitClaimed
2. Created
3. Reclaimed
4. Removed

## cddServiceProviders (7 events)

1. ActiveLimitChanged
2. Dummy
3. MemberAdded
4. MemberRemoved
5. MemberRevoked
6. MembersReset
7. MembersSwapped

## checkpoint (5 events)

1. CheckpointCreated
2. MaximumSchedulesComplexityChanged
3. ScheduleCreated
4. ScheduleRemoved

## committeeMembership (7 events)

1. ActiveLimitChanged
2. Dummy
3. MemberAdded
4. MemberRemoved
5. MemberRevoked
6. MembersReset
7. MembersSwapped

## complianceManager (9 events)

1. AssetCompliancePaused
2. AssetComplianceReplaced
3. AssetComplianceReset
4. AssetComplianceResumed
5. ComplianceRequirementChanged
6. ComplianceRequirementCreated
7. ComplianceRequirementRemoved
8. TrustedDefaultClaimIssuerAdded
9. TrustedDefaultClaimIssuerRemoved

## contracts (12 events)

1. Called
2. CodeRemoved
3. CodeStored
4. ContractCodeUpdated
5. ContractEmitted
6. DelegateCalled
7. Instantiated
8. StorageDepositTransferredAndHeld
9. StorageDepositTransferredAndReleased
10. Terminated

## corporateAction (8 events)

1. CAInitiated
2. CALinkedToDoc
3. CARemoved
4. DefaultTargetIdentitiesChanged
5. DefaultWithholdingTaxChanged
6. DidWithholdingTaxChanged
7. MaxDetailsLengthChanged
8. RecordDateChanged

## corporateBallot (7 events)

1. Created
2. MetaChanged
3. RangeChanged
4. RCVChanged
5. Removed
6. VoteCast

## electionProviderMultiPhase (7 events)

1. ElectionFailed
2. ElectionFinalized
3. PhaseTransitioned
4. Rewarded
5. Slashed
6. SolutionStored

## externalAgents (6 events)

1. AgentAdded
2. AgentRemoved
3. GroupChanged
4. GroupCreated
5. GroupPermissionsUpdated

## grandpa (3 events)

1. NewAuthorities
2. Paused
3. Resumed

## identity (23 events)

1. AssetDidRegistered
2. AuthorizationAdded
3. AuthorizationConsumed
4. AuthorizationRejected
5. AuthorizationRetryLimitReached
6. AuthorizationRevoked
7. CddClaimsInvalidated
8. CddRequirementForPrimaryKeyUpdated
9. ChildDidCreated
10. ChildDidUnlinked
11. ClaimAdded
12. ClaimRevoked
13. CustomClaimTypeAdded
14. DidCreated
15. PrimaryKeyUpdated
16. SecondaryKeyLeftIdentity
17. SecondaryKeyPermissionsUpdated
18. SecondaryKeysAdded
19. SecondaryKeysFrozen
20. SecondaryKeysRemoved
21. SecondaryKeysUnfrozen

## imOnline (3 events)

1. AllGood
2. HeartbeatReceived
3. SomeOffline

## indices (5 events)

1. DepositPoked
2. IndexAssigned
3. IndexFreed
4. IndexFrozen

## multiSig (14 events)

1. MultiSigAddedAdmin
2. MultiSigCreated
3. MultiSigRemovedAdmin
4. MultiSigRemovedPayingDid
5. MultiSigSignerAdded
6. MultiSigSignersAuthorized
7. MultiSigSignersRemoved
8. MultiSigSignersRequiredChanged
9. ProposalAdded
10. ProposalApprovalVote
11. ProposalApproved
12. ProposalExecuted
13. ProposalRejected
14. ProposalRejectionVote

## nft (2 events)

1. NftCollectionCreated
2. NFTPortfolioUpdated

## offences (1 event)

1. Offence

## pips (20 events)

1. ActivePipLimitChanged
2. DefaultEnactmentPeriodChanged
3. ExecutionCancellingFailed
4. ExecutionScheduled
5. ExecutionSchedulingFailed
6. ExpiryScheduled
7. ExpirySchedulingFailed
8. HistoricalPipsPruned
9. MaxPipSkipCountChanged
10. MinimumProposalDepositChanged
11. PendingPipExpiryChanged
12. PipClosed
13. PipSkipped
14. ProposalCreated
15. ProposalRefund
16. ProposalStateUpdated
17. SnapshotCleared
18. SnapshotResultsEnacted
19. SnapshotTaken
20. Voted

## polymeshCommittee (10 events)

1. Approved
2. Executed
3. ExpiresAfterUpdated
4. FinalVotes
5. Proposed
6. Rejected
7. ReleaseCoordinatorUpdated
8. Voted
9. VoteRetracted
10. VoteThresholdUpdated

## polymeshContracts (2 events)

1. ApiHashUpdated
2. SCRuntimeCall

## portfolio (10 events)

1. AllowIdentityToCreatePortfolios
2. FundsMovedBetweenPortfolios
3. PortfolioCreated
4. PortfolioCustodianChanged
5. PortfolioDeleted
6. PortfolioRenamed
7. PreApprovedPortfolio
8. RevokeCreatePortfoliosPermission
9. RevokePreApprovedPortfolio
10. UserPortfolios

## preimage (3 events)

1. Cleared
2. Noted
3. Requested

## protocolFee (3 events)

1. CoefficientSet
2. FeeCharged
3. FeeSet

## relayer (5 events)

1. AcceptedPayingKey
2. AuthorizedPayingKey
3. RemovedPayingKey
4. UpdatedPolyxLimit

## scheduler (11 events)

1. AgendaIncomplete
2. CallUnavailable
3. Canceled
4. Dispatched
5. PeriodicFailed
6. PermanentlyOverweight
7. RetryCancelled
8. RetryFailed
9. RetrySet
10. Scheduled

## session (3 events)

1. NewSession
2. ValidatorDisabled
3. ValidatorReenabled

## settlement (24 events)

1. AffirmationWithdrawn
2. FailedToExecuteInstruction
3. InstructionAffirmed
4. InstructionAutomaticallyAffirmed
5. InstructionCreated
6. InstructionExecuted
7. InstructionLocked
8. InstructionMediators
9. InstructionRejected
10. InstructionRescheduled
11. LegFailedExecution
12. MediatorAffirmationReceived
13. MediatorAffirmationWithdrawn
14. ReceiptClaimed
15. SchedulingFailed
16. SettlementManuallyExecuted
17. VenueCreated
18. VenueDetailsUpdated
19. VenueFiltering
20. VenuesAllowed
21. VenuesBlocked
22. VenueSignersUpdated
23. VenueTypeUpdated
24. VenueUnauthorized

## staking (19 events)

1. Bonded
2. Chilled
3. ControllerBatchDeprecated
4. CurrencyMigrated
5. EraPaid
6. ForceEra
7. Kicked
8. OldSlashingReportDiscarded
9. PayoutStarted
10. Rewarded
11. Slashed
12. SlashReported
13. SnapshotTargetsSizeExceeded
14. SnapshotVotersSizeExceeded
15. StakersElected
16. StakingElectionFailed
17. Unbonded
18. ValidatorPrefsSet
19. Withdrawn

## statistics (6 events)

1. AssetStatsUpdated
2. SetAssetTransferCompliance
3. StatTypesAdded
4. StatTypesRemoved
5. TransferConditionExemptionsAdded
6. TransferConditionExemptionsRemoved

## sto (8 events)

1. FundraiserClosed
2. FundraiserCreated
3. FundraiserFrozen
4. FundraiserOffchainFundingEnabled
5. FundraiserUnfrozen
6. FundraiserWindowModified
7. Invested

## sudo (3 events)

1. KeyChanged
2. Sudid
3. SudoAsDone

## system (9 events)

1. CodeUpdated
2. ExtrinsicFailed
3. ExtrinsicSuccess
4. KilledAccount
5. NewAccount
6. RejectedInvalidAuthorizedUpgrade
7. Remarked
8. UpgradeAuthorized

## technicalCommittee (10 events)

1. Approved
2. Executed
3. ExpiresAfterUpdated
4. FinalVotes
5. Proposed
6. Rejected
7. ReleaseCoordinatorUpdated
8. Voted
9. VoteRetracted
10. VoteThresholdUpdated

## technicalCommitteeMembership (7 events)

1. ActiveLimitChanged
2. Dummy
3. MemberAdded
4. MemberRemoved
5. MemberRevoked
6. MembersReset
7. MembersSwapped

## transactionPayment (1 event)

1. TransactionFeePaid

## treasury (3 events)

1. TreasuryDisbursement
2. TreasuryDisbursementFailed
3. TreasuryReimbursement

## upgradeCommittee (10 events)

1. Approved
2. Executed
3. ExpiresAfterUpdated
4. FinalVotes
5. Proposed
6. Rejected
7. ReleaseCoordinatorUpdated
8. Voted
9. VoteRetracted
10. VoteThresholdUpdated

## upgradeCommitteeMembership (7 events)

1. ActiveLimitChanged
2. Dummy
3. MemberAdded
4. MemberRemoved
5. MemberRevoked
6. MembersReset
7. MembersSwapped

## utility (7 events)

1. BatchCompleted
2. BatchCompletedWithErrors
3. BatchInterrupted
4. DispatchedAs
5. ItemCompleted
6. ItemFailed
7. RelayedTx

## validators (9 events)

1. CommissionCapUpdated
2. InvalidatedNominators
3. Nominated
4. PermissionedIdentityAdded
5. PermissionedIdentityRemoved
6. RewardPaymentSchedulingInterrupted
7. SlashingAllowedForChanged

---

**Summary:**

- **Total Modules:** 43
- **Total Events:** 354
