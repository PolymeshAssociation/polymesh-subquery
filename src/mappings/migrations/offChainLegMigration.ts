import { Asset, Instruction, InstructionStatusEnum, Leg, LegTypeEnum } from '../../types';
import { getAllByFields } from '../../utils';
import { getAssetIdForLegacyTicker } from '../../utils/assets';

/**
 * What 6.0's settlement migration did to legs, with no event: each leg it still held became
 * off-chain if its ticker was no asset then, fungible otherwise (`migrate_legs`). The index decides
 * a pre-6.0 leg when its instruction is created, so a leg whose ticker became an asset while its
 * instruction was pending is fungible from here. Before 6.0 the chain kept an instruction while it
 * was pending or failed, which a reschedule could retry, and pruned it once settled.
 */

const HELD = new Set([InstructionStatusEnum.Created, InstructionStatusEnum.Failed]);

/** `leg` as 6.0 holds it, fungible; `undefined` when it stays off-chain */
const fungibleAt6 = async (leg: Leg, blockEventId: string): Promise<Leg | undefined> => {
  if (leg.legType !== LegTypeEnum.OffChain || !leg.ticker) {
    return undefined;
  }

  const assetId = await getAssetIdForLegacyTicker(leg.ticker);
  if (!(await Asset.get(assetId))) {
    return undefined;
  }

  leg.legType = LegTypeEnum.Fungible;
  leg.assetId = assetId;
  leg.updatedEventId = blockEventId;
  return leg;
};

export const migrateOffChainLegs = async (blockEventId: string): Promise<void> => {
  // read whole, once: no index covers `status`
  const held = (await getAllByFields<Instruction>('Instruction', [])).filter(({ status }) =>
    HELD.has(status)
  );
  const legs = (
    await Promise.all(
      held.map(({ id }) => getAllByFields<Leg>('Leg', [['instructionId', '=', id]]))
    )
  ).flat();
  const fungible = await Promise.all(legs.map(leg => fungibleAt6(leg, blockEventId)));

  await Promise.all(fungible.map(leg => leg?.save()));
};
