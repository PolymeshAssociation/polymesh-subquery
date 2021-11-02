import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { Sto, TickerExternalAgentAction } from '../../types';
import { getOrDefault, serializeTicker } from '../util';
import { EventIdEnum, ModuleIdEnum } from './common';

/**
 * Subscribes to the events related to external agents
 */
export async function mapExternalAgentAction(
  blockId: number,
  eventId: EventIdEnum,
  moduleId: ModuleIdEnum,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> {
  const ticker = await mgr.getTicker(moduleId, eventId, blockId, params);
  if (ticker) {
    await TickerExternalAgentAction.create({
      id: `${blockId}/${event.idx}`,
      blockId,
      eventIdx: event.idx,
      ticker,
      palletName: moduleId,
      eventId,
      callerDid: params[0].toString(),
      datetime: event.block.timestamp,
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

  // explicit private empty constructor
  // eslint-disable-next-line no-useless-constructor, @typescript-eslint/no-empty-function
  private constructor() {}
  public async getTicker(
    moduleId: ModuleIdEnum,
    eventId: EventIdEnum,
    blockId: number,
    params: Codec[]
  ): Promise<string | undefined> {
    const entries = this.entries.get(moduleId)?.get(eventId);

    if (!entries) {
      return undefined;
    }

    for (const entry of entries) {
      if (entry.options.maxBlock && blockId > entry.options.maxBlock) {
        continue;
      }
      if (entry.options.minBlock && blockId < entry.options.minBlock) {
        continue;
      }
      if (entry.type === 'standard') {
        return serializeTicker(params[entry.paramIndex]);
      } else {
        return await entry.tickerFromParams(params);
      }
    }
    return undefined;
  }

  public static production() {
    const mgr = new ExternalAgentEventsManager();

    /**
     *  _____ _  _ ___   _____   _____ _  _ _____   _    ___ ___ _____
     * |_   _| || | __| | __\ \ / / __| \| |_   _| | |  |_ _/ __|_   _|
     *   | | | __ | _|  | _| \ V /| _|| .` | | |   | |__ | |\__ \ | |
     *   |_| |_||_|___| |___| \_/ |___|_|\_| |_|   |____|___|___/ |_|
     *
     * (Here is the source of truth for events that come from external agent authorized extrinsics)
     */
    mgr
      .add(
        ModuleIdEnum.Statistics,
        [
          EventIdEnum.TransferManagerAdded,
          EventIdEnum.TransferManagerRemoved,
          EventIdEnum.ExemptionsAdded,
          EventIdEnum.ExemptionsRemoved,
        ],
        1
      )
      .add(
        ModuleIdEnum.Corporateaction,
        [
          EventIdEnum.DefaultTargetIdentitiesChanged,
          EventIdEnum.DefaultWithholdingTaxChanged,
          EventIdEnum.DidWithholdingTaxChanged,
        ],
        1
      )
      .add(
        ModuleIdEnum.Corporateaction,
        [
          EventIdEnum.CaInitiated,
          EventIdEnum.CaLinkedToDoc,
          EventIdEnum.CaRemoved,
          EventIdEnum.RecordDateChanged,
        ],
        tickerFromCorporateAction
      )
      .add(
        ModuleIdEnum.Corporateballot,
        [
          EventIdEnum.Created,
          EventIdEnum.RangeChanged,
          EventIdEnum.MetaChanged,
          EventIdEnum.RcvChanged,
          EventIdEnum.Removed,
        ],
        tickerFromCorporateAction
      )
      .add(
        ModuleIdEnum.Compliancemanager,
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
        ModuleIdEnum.Capitaldistribution,
        [EventIdEnum.Created, EventIdEnum.Removed, EventIdEnum.BenefitClaimed],
        tickerFromCorporateAction
      )
      .add(
        ModuleIdEnum.Checkpoint,
        [EventIdEnum.CheckpointCreated, EventIdEnum.ScheduleCreated, EventIdEnum.ScheduleRemoved],
        1
      )
      .add(
        ModuleIdEnum.Asset,
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
        ModuleIdEnum.Externalagents,
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
        ModuleIdEnum.Settlement,
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
      .add(ModuleIdEnum.Sto, [EventIdEnum.FundraiserCreated], async params => {
        const offeringAsset =
          params[3] instanceof Map ? params[3].get('offering_asset') : undefined;
        if (!offeringAsset) {
          throw new Error("Couldn't find offeringAsset for sto");
        }
        return serializeTicker(offeringAsset);
      })
      .add(
        ModuleIdEnum.Sto,
        [
          EventIdEnum.FundraiserClosed,
          EventIdEnum.FundraiserWindowModifed,
          EventIdEnum.FundraiserFrozen,
          EventIdEnum.FundraiserUnfrozen,
        ],
        async params => {
          const stoId = params[1].toString();
          const sto = await Sto.get(stoId);
          return sto.offeringAsset;
        }
      );
    return mgr;
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
