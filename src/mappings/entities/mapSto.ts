import { EventIdEnum, ModuleIdEnum, Sto } from '../../types';
import { getNumberValue, getOfferingAsset } from '../util';
import { HandlerArgs } from './common';

/**
 * Subscribes to events related to STOs
 */
export async function mapSto({ blockId, eventId, moduleId, params }: HandlerArgs): Promise<void> {
  if (moduleId === ModuleIdEnum.sto && eventId === EventIdEnum.FundraiserCreated) {
    const [, rawStoId, , rawFundraiser] = params;
    const offeringAssetId = getOfferingAsset(rawFundraiser);
    const stoId = getNumberValue(rawStoId);

    await Sto.create({
      id: `${offeringAssetId}/${stoId}`,
      stoId,
      offeringAssetId,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  }
}
