import { Codec } from '@polkadot/types/types';
import { EventIdEnum, ModuleIdEnum, CustomClaimType } from '../../types';
import { bytesToString, getNumberValue, getTextValue } from '../util';
import { HandlerArgs } from './common';

export const createCustomClaimType = (
  attributes: Pick<CustomClaimType, 'id' | 'name' | 'identityId'>,
  blockId: string
): Promise<void> => {
  const { id, name, identityId } = attributes;
  return CustomClaimType.create({
    id,
    name,
    identityId,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

const handleCustomClaimTypeCreated = async (blockId: string, params: Codec[]): Promise<void> => {
  const [rawDid, rawCustomClaimTypeId, rawName] = params;

  const identityId = getTextValue(rawDid);
  const id = getNumberValue(rawCustomClaimTypeId);
  const name = bytesToString(rawName);

  const customClaimType = await CustomClaimType.get(`${id}`);

  if (!customClaimType) {
    await createCustomClaimType(
      {
        id: `${id}`,
        name,
        identityId,
      },
      blockId
    );
  }
};

export async function mapCustomClaimType({
  blockId,
  eventId,
  moduleId,
  params,
}: HandlerArgs): Promise<void> {
  if (moduleId !== ModuleIdEnum.identity) {
    return;
  }

  if (eventId === EventIdEnum.CustomClaimTypeAdded) {
    await handleCustomClaimTypeCreated(blockId, params);
  }
}
