import { Codec } from '@polkadot/types/types';
import { EventIdEnum, ModuleIdEnum, Portfolio, CustomClaimType } from '../../types';
import { bytesToString, getNumberValue, getTextValue } from '../util';
import { HandlerArgs } from './common';

export const getPortfolio = async ({
  identityId,
  number,
}: Pick<Portfolio, 'identityId' | 'number'>): Promise<Portfolio> => {
  const portfolioId = `${identityId}/${number}`;

  const portfolio = await Portfolio.get(portfolioId);

  if (!portfolio) {
    throw new Error(`Portfolio number ${number} not found for DID ${identityId}`);
  }

  return portfolio;
};

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

/**
 * Creates a CustomClaimType if not present.
 *
 * @note - WARNING: This is needed when an CustomClaim is created with a CustomClaimType that doesn't exist. It should not be used unless necessary.
 */
export const createCustomClaimTypeIfNotExists = async (
  { id }: Pick<CustomClaimType, 'id'>,
  blockId: string
): Promise<void> => {
  const customClaimType = await CustomClaimType.get(id);

  if (!customClaimType) {
    await createCustomClaimType(
      {
        id,
        name: '',
        identityId: '',
      },
      blockId
    );
  }
};

const handleCustomClaimTypeCreated = async (
  blockId: string,
  params: Codec[],
  eventIdx: number
): Promise<void> => {
  const [rawDid, rawCustomClaimTypeId, rawName] = params;

  const identityId = getTextValue(rawDid);
  const id = getNumberValue(rawCustomClaimTypeId);
  const name = bytesToString(rawName);

  const customClaimType = await Portfolio.get(`${id}`);

  if (!customClaimType) {
    await createCustomClaimType(
      {
        id: `${id}`,
        name,
        identityId,
      },
      blockId
    );
  } else {
    Object.assign(customClaimType, {
      name,
      eventIdx,
      updatedBlockId: blockId,
    });

    await customClaimType.save();
  }
};

export async function mapCustomClaimType({
  blockId,
  eventId,
  moduleId,
  params,
  eventIdx,
}: HandlerArgs): Promise<void> {
  if (moduleId !== ModuleIdEnum.identity) {
    return;
  }

  if (eventId === EventIdEnum.CustomClaimTypeAdded) {
    await handleCustomClaimTypeCreated(blockId, params, eventIdx);
  }
}
