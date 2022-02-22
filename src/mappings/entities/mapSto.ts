import { Codec } from '@polkadot/types/types';
import { Sto } from '../../types';
import { serializeTicker } from '../util';
import { EventIdEnum, ModuleIdEnum } from './common';

/**
 * Subscribes to events related to STOs
 */
export async function mapSto(eventId: string, moduleId: string, params: Codec[]): Promise<void> {
  if (moduleId === ModuleIdEnum.Sto && eventId === EventIdEnum.FundraiserCreated) {
    const offeringAsset = params[3] instanceof Map ? params[3].get('offering_asset') : undefined;
    if (!offeringAsset) {
      throw new Error("Couldn't find offeringAsset for sto");
    }
    await Sto.create({
      id: params[1].toString(),
      offeringAsset: serializeTicker(offeringAsset),
    }).save();
  }
}
