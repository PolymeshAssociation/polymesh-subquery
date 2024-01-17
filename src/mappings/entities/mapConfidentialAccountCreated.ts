import { ConfidentialAccount, EventIdEnum, ModuleIdEnum } from '../../types';
import { getTextValue } from '../util';
import { HandlerArgs } from './common';

export const mapConfidentialAccountCreated = async (args: HandlerArgs): Promise<void> => {
  const { blockId, moduleId, eventId, params } = args;

  if (moduleId !== ModuleIdEnum.confidentialasset || eventId !== EventIdEnum.AccountCreated) {
    return;
  }

  const [rawCreator, rawAccount] = params;

  const creator = getTextValue(rawCreator);
  const account = getTextValue(rawAccount);

  await ConfidentialAccount.create({
    id: account,
    account,
    creatorId: creator,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};
