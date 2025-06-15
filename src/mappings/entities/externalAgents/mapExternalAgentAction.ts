import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import { EventIdEnum, ModuleIdEnum, TickerExternalAgentAction } from '../../../types';
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

/**
 * Subscribes to the events related to external agents
 */
export async function mapExternalAgentAction(event: SubstrateEvent): Promise<void> {
  const { moduleId, eventId, blockId, block, params, extrinsic, eventIdx, blockEventId } =
    extractArgs(event);

  const assetId = await mgr.getAssetIdForEvent(
    moduleId,
    eventId,
    blockId,
    block,
    params,
    extrinsic
  );
  if (assetId) {
    await TickerExternalAgentAction.create({
      id: blockEventId,
      eventIdx,
      assetId,
      palletName: moduleId,
      eventId,
      callerId: getTextValue(params[0]),
      createdBlockId: blockId,
      updatedBlockId: blockId,
      createdEventId: blockEventId,
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
        [EventIdEnum.AssetStatsUpdated, EventIdEnum.StatTypesAdded, EventIdEnum.StatTypesRemoved],
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
      .add(
        ModuleIdEnum.capitaldistribution,
        [EventIdEnum.Created, EventIdEnum.Removed, EventIdEnum.BenefitClaimed],
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
          // EventIdEnum.TickerLinkedToAsset,
        ],
        2
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
