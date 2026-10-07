import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import { AssetAgentAction, EventIdEnum, ModuleIdEnum } from '../../../types';
import {
  getAssetId,
  getExemptKeyValue,
  getOfferingAsset,
  getOrDefault,
  getTextValue,
  is7Dot3Chain,
} from '../../../utils';
import { extractArgs } from '../common';
import { getAssetIdForStatisticsEvent } from '../assets/mapStatistics';
import { assetOfCollection } from '../assets/mapNfts';

/**
 * Subscribes to the events related to external agents
 */
export async function mapExternalAgentAction(event: SubstrateEvent): Promise<void> {
  const { moduleId, eventId, blockId, block, params, extrinsic, blockEventId } = extractArgs(event);

  const assetId = await mgr.getAssetIdForEvent(
    moduleId,
    eventId,
    blockId,
    block,
    params,
    extrinsic
  );
  if (assetId) {
    await AssetAgentAction.create({
      id: blockEventId,
      assetId,
      palletName: moduleId,
      eventId,
      callerId: getTextValue(params[0]),
      createdEventId: blockEventId,
      updatedEventId: blockEventId,
    }).save();
  }
}

type EntryOptions = {
  maxBlock?: number;
  minBlock?: number;
};

type StandardEntry = {
  type: 'standard';
  paramIndex: number;
  options: EntryOptions;
};

type AssetIdFromParams = (
  params: Codec[],
  block: SubstrateBlock,
  extrinsic?: SubstrateExtrinsic
) => Promise<string>;

type SpecialEntry = {
  type: 'special';
  assetIdFromParams: AssetIdFromParams;
  options: EntryOptions;
};
type Entry = StandardEntry | SpecialEntry;

const assetIdFromCorporateAction: AssetIdFromParams = async (
  params: Codec[],
  block: SubstrateBlock
) => {
  if (params[1] instanceof Map) {
    const rawAssetId = params[1].get('ticker') ?? params[1].get('assetId');
    if (rawAssetId) {
      return getAssetId(rawAssetId, block);
    }
  }
  if (params[2] instanceof Map) {
    const rawAssetId = params[2].get('ticker') ?? params[2].get('assetId');
    if (rawAssetId) {
      return getAssetId(rawAssetId, block);
    }
  }
  throw new Error("Event didn't have a CaID parameter");
};

/**
 * Class designed to manage the list of events produced by external agent authorized extrinsics
 * in a single source of truth.
 *
 * External agent authorized extrinsics are defined as those that call "ensure_agent_permissioned"
 * meaning they are extrinsics that can only be called if you are an external agent of the Asset.
 */
/**
 * Still positional, deliberately.
 *
 * This table locates the asset id in events from roughly twenty pallets, most of which are not
 * migrated to the decode layer yet - `statistics`, `sto`, `complianceManager`, `nft` and the
 * rest. Reading it by name would mean registering shapes for all of them here rather than as
 * each domain is migrated, so it moves when they do.
 *
 * Kept honest by hand, which is its weak point: `scripts/sync-metadata.ts` catches an event the
 * chain added that the *schema enum* does not know, and lists the enum members a subscribed pallet
 * emits that no handler reads, but nothing tells this table it is missing an agent-permissioned
 * event. The gaps found by review so far were a whole pallet (`nft`) and single events in two
 * others, so the analogous report — events of a pallet already in this table that the table does
 * not list — is worth adding to that script rather than sweeping it by hand again.
 */
class ExternalAgentEventsManager {
  private entries: Map<ModuleIdEnum, Map<EventIdEnum, Entry[]>> = new Map();

  // eslint-disable-next-line no-useless-constructor, @typescript-eslint/no-empty-function
  private constructor() {
    // Explicit private empty constructor
  }

  public async getAssetIdForEvent(
    moduleId: ModuleIdEnum,
    eventId: EventIdEnum,
    blockId: string,
    block: SubstrateBlock,
    params: Codec[],
    extrinsic?: SubstrateExtrinsic
  ): Promise<string | undefined> {
    const entries = this.entries.get(moduleId)?.get(eventId);

    if (!entries) {
      return undefined;
    }

    for (const entry of entries) {
      if (entry.options.maxBlock && Number(blockId) > entry.options.maxBlock) {
        continue;
      }
      if (entry.options.minBlock && Number(blockId) < entry.options.minBlock) {
        continue;
      }
      if (entry.type === 'standard') {
        return getAssetId(params[entry.paramIndex], block);
      } else {
        return entry.assetIdFromParams(params, block, extrinsic);
      }
    }
    return undefined;
  }

  public static production() {
    const eventsManager = new ExternalAgentEventsManager();

    /**
     *  _____ _  _ ___   _____   _____ _  _ _____   _    ___ ___ _____
     * |_   _| || | __| | __\ \ / / __| \| |_   _| | |  |_ _/ __|_   _|
     *   | | | __ | _|  | _| \ V /| _|| .` | | |   | |__ | |\__ \ | |
     *   |_| |_||_|___| |___| \_/ |___|_|\_| |_|   |____|___|___/ |_|
     *
     * (Here is the source of truth for events that come from external agent authorized extrinsics)
     */
    eventsManager
      .add(
        ModuleIdEnum.statistics,
        [
          EventIdEnum.TransferManagerAdded,
          EventIdEnum.TransferManagerRemoved,
          EventIdEnum.ExemptionsAdded,
          EventIdEnum.ExemptionsRemoved,
        ],
        1
      )
      .add(
        ModuleIdEnum.statistics,
        [
          EventIdEnum.AssetStatsUpdated,
          EventIdEnum.StatTypesAdded,
          EventIdEnum.StatTypesRemoved,
          // the remaining agent-permissioned event in this pallet; the other nine were already here
          EventIdEnum.SetAssetTransferCompliance,
        ],
        async (params, block) => await getAssetIdForStatisticsEvent(params[1], block)
      )
      .add(
        ModuleIdEnum.statistics,
        [
          EventIdEnum.TransferConditionExemptionsAdded,
          EventIdEnum.TransferConditionExemptionsRemoved,
        ],
        async (params, block) => (await getExemptKeyValue(params[1], block)).assetId
      )
      .add(
        ModuleIdEnum.corporateaction,
        [
          EventIdEnum.DefaultTargetIdentitiesChanged,
          EventIdEnum.DefaultWithholdingTaxChanged,
          EventIdEnum.DidWithholdingTaxChanged,
        ],
        1
      )
      .add(
        ModuleIdEnum.corporateaction,
        [
          EventIdEnum.CAInitiated,
          EventIdEnum.CALinkedToDoc,
          EventIdEnum.CARemoved,
          EventIdEnum.RecordDateChanged,
        ],
        assetIdFromCorporateAction
      )
      .add(
        ModuleIdEnum.corporateballot,
        [
          EventIdEnum.Created,
          EventIdEnum.RangeChanged,
          EventIdEnum.MetaChanged,
          EventIdEnum.RCVChanged,
          EventIdEnum.Removed,
          EventIdEnum.VoteCast,
        ],
        assetIdFromCorporateAction
      )
      .add(
        ModuleIdEnum.compliancemanager,
        [
          EventIdEnum.ComplianceRequirementCreated,
          EventIdEnum.ComplianceRequirementRemoved,
          EventIdEnum.AssetComplianceReplaced,
          EventIdEnum.AssetComplianceReset,
          EventIdEnum.TrustedDefaultClaimIssuerAdded,
          EventIdEnum.TrustedDefaultClaimIssuerRemoved,
          EventIdEnum.ComplianceRequirementChanged,
          EventIdEnum.AssetCompliancePaused,
          EventIdEnum.AssetComplianceResumed,
        ],
        1
      )
      /**
       * `BenefitClaimed` is deliberately absent. It is emitted by `push_benefit`, which an agent
       * calls, *and* by `claim`, which any holder calls — so recording it would attribute holders'
       * own claims to the agents, the same over-inclusion `asset.Transfer` is excluded for.
       * `Reclaimed` has no such ambiguity: only an agent can reclaim.
       */
      .add(
        ModuleIdEnum.capitaldistribution,
        [EventIdEnum.Created, EventIdEnum.Removed, EventIdEnum.Reclaimed],
        assetIdFromCorporateAction
      )
      .add(
        ModuleIdEnum.checkpoint,
        [EventIdEnum.CheckpointCreated, EventIdEnum.ScheduleCreated, EventIdEnum.ScheduleRemoved],
        1
      )
      .add(
        ModuleIdEnum.asset,
        [
          EventIdEnum.AssetOwnershipTransferred,
          /*
          EventIdEnum.Transfer,

          The `Transfer` event is only emitted together with the `Redeemed` event https://github.com/PolymathNetwork/Polymesh/blob/583f5c57d28de922899217bb56b0bab160d4b63a/pallets/asset/src/lib.rs#L2047
          and the `Issued` event https://github.com/PolymathNetwork/Polymesh/blob/583f5c57d28de922899217bb56b0bab160d4b63a/pallets/asset/src/lib.rs#L1579

          And including it in the list would also include all other Transfers that are not related to external agents,
          therefore we have decided to exclude it.
          */
          EventIdEnum.Issued,
          EventIdEnum.Redeemed,
          EventIdEnum.ControllerTransfer,
          EventIdEnum.ControllerTransferTo,
          EventIdEnum.AssetFrozen,
          EventIdEnum.AssetUnfrozen,
          EventIdEnum.AssetRenamed,
          EventIdEnum.DivisibilityChanged,
          EventIdEnum.DocumentAdded,
          EventIdEnum.DocumentRemoved,
          EventIdEnum.FundingRoundSet,
          EventIdEnum.IdentifiersUpdated,
          EventIdEnum.AssetMediatorsAdded,
          EventIdEnum.AssetMediatorsRemoved,
          EventIdEnum.AssetTypeChanged,
          EventIdEnum.LocalMetadataKeyDeleted,
          EventIdEnum.MetadataValueDeleted,
          EventIdEnum.PreApprovedAsset,
          EventIdEnum.RegisterAssetMetadataLocalType,
          EventIdEnum.RemovePreApprovedAsset,
          EventIdEnum.SetAssetMetadataValue,
          EventIdEnum.SetAssetMetadataValueDetails,
        ],
        1
      )
      .add(
        ModuleIdEnum.asset,
        [EventIdEnum.AssetAffirmationExemption, EventIdEnum.RemoveAssetAffirmationExemption],
        0
      )
      .add(
        ModuleIdEnum.asset,
        [
          EventIdEnum.TickerLinkedToAsset,
          EventIdEnum.TickerUnlinkedFromAsset,
          EventIdEnum.FrozenBalanceSet,
          EventIdEnum.SetAccountFreeze,
        ],
        2
      )
      /**
       * The `nft` counterparts of `asset.create` / `issue` / `redeem`, which are all in this table:
       * without them an agent minting a fungible token is recorded and one minting an NFT is not.
       *
       * Every spec version is covered, not just the current one — the index replays from genesis, so
       * the names deprecated at 6.0 count. `RedeemedNFT(IdentityId, Ticker, NFTId)` names the asset
       * at index 1 like the rest; `NftCollectionCreated` spans every version.
       *
       * `NFTPortfolioUpdated` / `NFTHoldingsUpdated` stay out for the reason `asset.Transfer` does:
       * they fire on every transfer, not only on agent-permissioned calls.
       *
       * `IssuedNFT` names the collection rather than the asset — pre-6.0 it is `(IdentityId,
       * NFTCollectionId, NFTId)` — so it resolves through the collection's own storage instead of
       * by parameter position.
       */
      .add(ModuleIdEnum.nft, [EventIdEnum.NftCollectionCreated, EventIdEnum.RedeemedNFT], 1)
      .add(
        ModuleIdEnum.nft,
        [EventIdEnum.IssuedNFT],
        async (params, block) => (await assetOfCollection(params[1], block)) as string
      )
      .add(
        ModuleIdEnum.externalagents,
        [
          EventIdEnum.AgentAdded,
          EventIdEnum.GroupCreated,
          EventIdEnum.GroupPermissionsUpdated,
          EventIdEnum.GroupChanged,
          EventIdEnum.AgentRemoved,
        ],
        1
      )
      .add(
        ModuleIdEnum.settlement,
        [
          EventIdEnum.VenueFiltering,
          EventIdEnum.VenuesAllowed,
          EventIdEnum.VenuesBlocked,
          EventIdEnum.VenueUnauthorized,
        ],
        1
      )
      // Special case for the Sto pallet because most events don't contain the Asset,
      // they contain a reference to a previously created fundraiser instead.
      .add(ModuleIdEnum.sto, [EventIdEnum.FundraiserCreated], async (params, block) =>
        is7Dot3Chain(block) ? getAssetId(params[1], block) : getOfferingAsset(params[3])
      )
      .add(
        ModuleIdEnum.sto,
        [
          EventIdEnum.FundraiserClosed,
          EventIdEnum.FundraiserWindowModified,
          EventIdEnum.FundraiserFrozen,
          EventIdEnum.FundraiserUnfrozen,
        ],
        async (params, block, extrinsic) =>
          is7Dot3Chain(block)
            ? getAssetId(params[1], block)
            : getAssetId(extrinsic?.extrinsic.args[0] as unknown as Codec, block)
      )
      .add(ModuleIdEnum.sto, [EventIdEnum.FundraiserOffchainFundingEnabled], 1);

    return eventsManager;
  }

  private add(
    moduleId: ModuleIdEnum,
    eventIds: EventIdEnum[],
    param: number | AssetIdFromParams,
    options: EntryOptions = {}
  ) {
    // entries
    const map = getOrDefault(this.entries, moduleId, () => new Map<EventIdEnum, Entry[]>());
    for (const event of eventIds) {
      const entry: Entry =
        typeof param === 'number'
          ? { type: 'standard', paramIndex: param, options }
          : { type: 'special', assetIdFromParams: param, options };
      getOrDefault(map, event, () => []).push(entry);
    }

    return this;
  }
}
const mgr = ExternalAgentEventsManager.production();
