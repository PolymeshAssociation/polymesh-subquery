import { ConfidentialAccount, EventIdEnum, ModuleIdEnum } from '../../types';
import { getTextValue } from '../util';
import { HandlerArgs } from './common';

export const mapConfidentialAccountCreated = async (args: HandlerArgs): Promise<void> => {
  const { blockId, moduleId, eventId, params } = args;

  if (moduleId !== ModuleIdEnum.confidentialasset) {
    return;
  }

  if (eventId !== EventIdEnum.AccountCreated) {
    return;
  }

  const creator = getTextValue(params[0]);
  const account = getTextValue(params[1]);

  await ConfidentialAccount.create({
    id: account,
    account,
    creatorId: creator,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};
