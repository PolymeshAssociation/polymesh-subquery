import { EventIdEnum, ModuleIdEnum, Sto } from '../../types';
import { getTextValue, serializeTicker } from '../util';
import { HandlerArgs } from './common';

/**
 * Subscribes to events related to STOs
 */
export async function mapSto({ blockId, eventId, moduleId, params }: HandlerArgs): Promise<void> {
  if (moduleId === ModuleIdEnum.sto && eventId === EventIdEnum.FundraiserCreated) {
    const offeringAsset = params[3] instanceof Map ? params[3].get('offering_asset') : undefined;
    if (!offeringAsset) {
      throw new Error("Couldn't find offeringAsset for sto");
    }
    await Sto.create({
      id: getTextValue(params[1]),
      offeringAssetId: serializeTicker(offeringAsset),
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  }
}
