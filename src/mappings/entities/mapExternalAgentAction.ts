import { Codec } from '@polkadot/types/types';
import { EventIdEnum, ModuleIdEnum, Sto, TickerExternalAgentAction } from '../../types';
import { getOrDefault, getTextValue, serializeTicker } from '../util';
import { HandlerArgs } from './common';

/**
 * Subscribes to the events related to external agents
 */
export async function mapExternalAgentAction({
  blockId,
  eventId,
  moduleId,
  params,
  event,
}: HandlerArgs): Promise<void> {
  const ticker = await mgr.getTicker(moduleId, eventId, blockId, params);
  if (ticker) {
    await TickerExternalAgentAction.create({
      id: `${blockId}/${event.idx}`,
      eventIdx: event.idx,
      assetId: ticker,
      palletName: moduleId,
      eventId,
      callerId: getTextValue(params[0]),
      createdBlockId: blockId,
      updatedBlockId: blockId,
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
type TickerFromParams = (params: Codec[]) => Promise<string>;
type SpecialEntry = {
  type: 'special';
  tickerFromParams: TickerFromParams;
  options: EntryOptions;
};
type Entry = StandardEntry | SpecialEntry;
const tickerFromCorporateAction: TickerFromParams = async params => {
  if (params[1] instanceof Map && params[1].get('ticker')) {
    return serializeTicker(params[1].get('ticker'));
  }
  if (params[2] instanceof Map && params[2].get('ticker')) {
    return serializeTicker(params[2].get('ticker'));
  }
  throw new Error("Event didn't have a CaID parameter");
};

/**
 * Class designed to manage the list of events produced by external agent authorized extrinsics
 * in a single source of truth.
 *
 * External agent authorized extrinsics are defined as those that call "ensure_agent_permissioned"
 * meaning they are extrinsics that can only be called if you are an external agent of the ticker.
 */
class ExternalAgentEventsManager {
  private entries: Map<ModuleIdEnum, Map<EventIdEnum, Entry[]>> = new Map();

  // eslint-disable-next-line no-useless-constructor, @typescript-eslint/no-empty-function
  private constructor() {
    // Explicit private empty constructor
  }

  public async getTicker(
    moduleId: ModuleIdEnum,
    eventId: EventIdEnum,
    blockId: string,
    params: Codec[]
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
        return serializeTicker(params[entry.paramIndex]);
      } else {
        return entry.tickerFromParams(params);
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
        tickerFromCorporateAction
      )
      .add(
        ModuleIdEnum.corporateballot,
        [
          EventIdEnum.Created,
          EventIdEnum.RangeChanged,
          EventIdEnum.MetaChanged,
          EventIdEnum.RCVChanged,
          EventIdEnum.Removed,
        ],
        tickerFromCorporateAction
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
        tickerFromCorporateAction
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
        ],
        1
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
      // Special case for the Sto pallet because most events don't contain the ticker,
      // they contain a reference to a previously created fundraiser instead.
      .add(ModuleIdEnum.sto, [EventIdEnum.FundraiserCreated], async params => {
        const offeringAsset =
          params[3] instanceof Map ? params[3].get('offering_asset') : undefined;
        if (!offeringAsset) {
          throw new Error("Couldn't find offeringAsset for sto");
        }
        return serializeTicker(offeringAsset);
      })
      .add(
        ModuleIdEnum.sto,
        [
          EventIdEnum.FundraiserClosed,
          EventIdEnum.FundraiserWindowModified,
          EventIdEnum.FundraiserFrozen,
          EventIdEnum.FundraiserUnfrozen,
        ],
        async params => {
          const stoId = params[1].toString();
          const sto = await Sto.get(stoId);
          return sto.offeringAssetId;
        }
      );
    return eventsManager;
  }

  private add(
    moduleId: ModuleIdEnum,
    eventIds: EventIdEnum[],
    param: number | TickerFromParams,
    options: EntryOptions = {}
  ) {
    // entries
    const map = getOrDefault(this.entries, moduleId, () => new Map<EventIdEnum, Entry[]>());
    for (const event of eventIds) {
      const entry: Entry =
        typeof param === 'number'
          ? { type: 'standard', paramIndex: param, options }
          : { type: 'special', tickerFromParams: param, options };
      getOrDefault(map, event, () => []).push(entry);
    }

    return this;
  }
}
const mgr = ExternalAgentEventsManager.production();
