import { EventIdEnum, ModuleIdEnum, Sto } from '../../types';
import { getOfferingAsset, getTextValue } from '../util';
import { HandlerArgs } from './common';

/**
 * Subscribes to events related to STOs
 */
export async function mapSto({ blockId, eventId, moduleId, params }: HandlerArgs): Promise<void> {
  if (moduleId === ModuleIdEnum.sto && eventId === EventIdEnum.FundraiserCreated) {
    const [, rawStoId, , rawFundraiser] = params;
    const offeringAssetId = getOfferingAsset(rawFundraiser);

    await Sto.create({
      id: getTextValue(rawStoId),
      offeringAssetId,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  }
}
