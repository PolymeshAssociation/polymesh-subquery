import {
  Event,
  EventIdEnum,
  ModuleIdEnum,
  StatOpTypeEnum,
  TransferCompliance,
  TransferComplianceExemption,
  TransferComplianceTypeEnum,
} from '../../types';
import { getAllByFields } from '../../utils';
import { getAssetIdForLegacyTicker } from '../../utils/assets';
import { conditionId, getStatTypeId, upsertStatType } from '../entities/assets/mapStatistics';

/**
 * What 5.0's statistics `migrate_v1` did with no event: each asset's active transfer managers
 * became transfer conditions (`CountTransferManager(max)` a `MaxInvestorCount(max)`,
 * `PercentageTransferManager(max)` a `MaxInvestorOwnership(max)`), the statistics those need, and
 * the exemptions each manager carried, keyed by the condition's statistic. 4.x's
 * `remove_transfer_manager` left a manager's exemptions behind, so a manager added again had them
 * back. The index replays the 4.x events it stored to reach the same state; the investor count
 * every asset with a holder got is the `Count` statistic `handleAssetIssuedStatistics` wrote.
 */

const MANAGER_EVENTS = [
  EventIdEnum.TransferManagerAdded,
  EventIdEnum.TransferManagerRemoved,
  EventIdEnum.ExemptionsAdded,
  EventIdEnum.ExemptionsRemoved,
];

interface ManagerArgs {
  ticker: string;
  transferManager: Record<string, unknown>;
  scopeIds?: string[];
}

/** A transfer manager's kind and its limit, the `CountTransferManager(10)` of `{ CountTransferManager: '10' }` */
const managerOf = ({ transferManager }: ManagerArgs) => {
  const [[kind, limit]] = Object.entries(transferManager);
  return { kind: kind.toLowerCase(), limit: BigInt(limit as string | number) };
};

const managerKey = (args: ManagerArgs): string => {
  const { kind, limit } = managerOf(args);
  return `${kind}/${limit}`;
};

const conditionOf = async (args: ManagerArgs) => {
  const { kind, limit } = managerOf(args);
  const assetId = await getAssetIdForLegacyTicker(args.ticker);
  const opType = kind === 'counttransfermanager' ? StatOpTypeEnum.Count : StatOpTypeEnum.Balance;
  const condition = {
    assetId,
    type:
      opType === StatOpTypeEnum.Count
        ? TransferComplianceTypeEnum.MaxInvestorCount
        : TransferComplianceTypeEnum.MaxInvestorOwnership,
    statTypeId: getStatTypeId(assetId, opType),
    value: limit,
  };
  return { assetId, opType, condition };
};

export const migrateTransferManagers = async (blockEventId: string): Promise<void> => {
  const events = (
    await Promise.all(
      MANAGER_EVENTS.map(eventId =>
        getAllByFields<Event>('Event', [
          ['moduleId', '=', ModuleIdEnum.statistics],
          ['eventId', '=', eventId],
        ])
      )
    )
  )
    .flat()
    .sort((a, b) => {
      if (a.id === b.id) {
        return 0;
      }
      return a.id < b.id ? -1 : 1;
    });

  // per ticker, its active managers in the order they were added
  const managers = new Map<string, Map<string, ManagerArgs>>();
  // per ticker and manager, the scopes it exempts, whether or not the manager is active
  const exemptions = new Map<string, Set<string>>();

  for (const { eventId, args } of events) {
    const event = args as unknown as ManagerArgs;
    const key = managerKey(event);
    const active = managers.get(event.ticker) ?? new Map<string, ManagerArgs>();
    managers.set(event.ticker, active);
    const exempt = exemptions.get(`${event.ticker}/${key}`) ?? new Set<string>();
    exemptions.set(`${event.ticker}/${key}`, exempt);

    if (eventId === EventIdEnum.TransferManagerAdded) {
      active.set(key, event);
    } else if (eventId === EventIdEnum.TransferManagerRemoved) {
      active.delete(key);
    } else if (eventId === EventIdEnum.ExemptionsAdded) {
      event.scopeIds?.forEach(scope => exempt.add(scope));
    } else {
      event.scopeIds?.forEach(scope => exempt.delete(scope));
    }
  }

  const conditions = await Promise.all(
    [...managers].flatMap(([ticker, active]) =>
      [...active].map(async ([key, manager]) => ({
        ...(await conditionOf(manager)),
        scopes: [...(exemptions.get(`${ticker}/${key}`) ?? [])],
      }))
    )
  );

  // one statistic per asset and kind, though two of an asset's conditions may share it
  const statTypes = new Map(
    conditions.map(({ assetId, opType }) => [getStatTypeId(assetId, opType), { assetId, opType }])
  );
  await Promise.all(
    [...statTypes.values()].map(statType =>
      upsertStatType(statType as Parameters<typeof upsertStatType>[0], blockEventId)
    )
  );

  await Promise.all(
    conditions.flatMap(({ assetId, opType, condition, scopes }) => [
      TransferCompliance.create({
        id: conditionId(condition),
        ...condition,
        createdEventId: blockEventId,
        updatedEventId: blockEventId,
      }).save(),
      ...scopes.map(scope =>
        TransferComplianceExemption.create({
          id: `${assetId}/${opType}/null/${scope}`,
          assetId,
          opType,
          exemptedEntityId: scope,
          createdEventId: blockEventId,
          updatedEventId: blockEventId,
        }).save()
      ),
    ])
  );
};
