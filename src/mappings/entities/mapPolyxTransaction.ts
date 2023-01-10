import { SubstrateEvent } from '@subql/types';
import { PolyxTransactionProps } from 'polymesh-subql/types/models/PolyxTransaction';
import { CallIdEnum, EventIdEnum, ModuleIdEnum, PolyxTransaction } from '../../types';
import { bytesToString, camelToSnakeCase, getBigIntValue, getTextValue } from '../util';
import { HandlerArgs } from './common';

const getExtrinsicDetails = (
  blockId: string,
  event: SubstrateEvent
): Pick<PolyxTransactionProps, 'callId' | 'extrinsicId'> => {
  let callId: CallIdEnum;
  let extrinsicId: string;
  if (event.extrinsic) {
    callId = camelToSnakeCase(event.extrinsic.extrinsic.method.method) as CallIdEnum;
    extrinsicId = `${blockId}/${event.extrinsic.idx}`;
  }
  return { callId, extrinsicId };
};

const getBasicDetails = ({ blockId, eventId, moduleId, event }: HandlerArgs) => ({
  id: `${blockId}/${event.idx}`,
  moduleId,
  eventId,
  ...getExtrinsicDetails(blockId, event),
  datetime: event.block.timestamp,
  createdBlockId: blockId,
  updatedBlockId: blockId,
});

const handleTreasuryReimbursement = async (args: HandlerArgs): Promise<void> => {
  const [rawIdentity, rawBalance] = args.params;

  await PolyxTransaction.create({
    ...getBasicDetails(args),
    identityId: getTextValue(rawIdentity),
    amount: getBigIntValue(rawBalance),
  }).save();
};

const handleTreasuryDisbursement = async (args: HandlerArgs): Promise<void> => {
  const [rawFromIdentity, rawToDid, rawTo, rawBalance] = args.params;

  await PolyxTransaction.create({
    ...getBasicDetails(args),
    identityId: getTextValue(rawFromIdentity),
    toId: getTextValue(rawToDid),
    toAddress: getTextValue(rawTo),
    amount: getBigIntValue(rawBalance),
  }).save();
};

const handleBalanceTransfer = async (args: HandlerArgs): Promise<void> => {
  const [rawFromDid, rawFrom, rawToDid, rawTo, rawBalance, rawMemo] = args.params;

  await PolyxTransaction.create({
    ...getBasicDetails(args),
    identityId: getTextValue(rawFromDid),
    address: getTextValue(rawFrom),
    toId: getTextValue(rawToDid),
    toAddress: getTextValue(rawTo),
    amount: getBigIntValue(rawBalance),
    memo: bytesToString(rawMemo),
  }).save();
};

const handleBalanceEndowed = async (args: HandlerArgs): Promise<void> => {
  const [rawDid, rawAddress, rawBalance] = args.params;

  const amount = getBigIntValue(rawBalance);
  if (amount > 0) {
    await PolyxTransaction.create({
      ...getBasicDetails(args),
      toId: getTextValue(rawDid),
      toAddress: getTextValue(rawAddress),
      amount,
    }).save();
  }
};

const handleBalanceReserved = async (args: HandlerArgs): Promise<void> => {
  const [rawAddress, rawBalance] = args.params;

  const amount = getBigIntValue(rawBalance);
  await PolyxTransaction.create({
    ...getBasicDetails(args),
    toAddress: getTextValue(rawAddress),
    amount,
  }).save();
};

const handleBalanceUnreserved = async (args: HandlerArgs): Promise<void> => {
  const [rawAddress, rawBalance] = args.params;

  const amount = getBigIntValue(rawBalance);
  await PolyxTransaction.create({
    ...getBasicDetails(args),
    address: getTextValue(rawAddress),
    amount,
  }).save();
};

const handleBalanceAdded = async (args: HandlerArgs): Promise<void> => {
  const [rawDid, rawAddress, rawBalance] = args.params;

  const amount = getBigIntValue(rawBalance);
  await PolyxTransaction.create({
    ...getBasicDetails(args),
    toId: getTextValue(rawDid),
    toAddress: getTextValue(rawAddress),
    amount,
  }).save();
};

const handleBalanceBurned = async (args: HandlerArgs): Promise<void> => {
  const [rawDid, rawAddress, rawBalance] = args.params;

  const amount = getBigIntValue(rawBalance);
  await PolyxTransaction.create({
    ...getBasicDetails(args),
    identityId: getTextValue(rawDid),
    address: getTextValue(rawAddress),
    amount,
  }).save();
};

const handleTreasury = async (args: HandlerArgs): Promise<void> => {
  const { eventId } = args;
  if (eventId === EventIdEnum.TreasuryReimbursement) {
    await handleTreasuryReimbursement(args);
  }
  if (eventId === EventIdEnum.TreasuryDisbursement) {
    await handleTreasuryDisbursement(args);
  }
};

const handleBalances = async (args: HandlerArgs): Promise<void> => {
  const { eventId } = args;
  if (eventId === EventIdEnum.Transfer) {
    await handleBalanceTransfer(args);
  }
  if (eventId === EventIdEnum.Endowed) {
    await handleBalanceEndowed(args);
  }
  if (eventId === EventIdEnum.Reserved) {
    await handleBalanceReserved(args);
  }
  if (eventId === EventIdEnum.Unreserved) {
    await handleBalanceUnreserved(args);
  }
  if (eventId === EventIdEnum.AccountBalanceBurned) {
    await handleBalanceBurned(args);
  }
  // BalanceSet and ReserveRepatriated left to be handled
};

const handleStaking = async (args: HandlerArgs): Promise<void> => {
  const { eventId } = args;
  if (eventId === EventIdEnum.Bonded) {
    await handleBalanceBurned(args);
  }
  if ([EventIdEnum.Reward, EventIdEnum.Unbonded].includes(eventId)) {
    await handleBalanceAdded(args);
  }
  if (eventId === EventIdEnum.Withdrawn) {
    await handleBalanceUnreserved(args);
  }
};

export async function mapPolyxTransaction(args: HandlerArgs): Promise<void> {
  const { moduleId } = args;
  if (moduleId === ModuleIdEnum.treasury) {
    await handleTreasury(args);
  }
  if (moduleId === ModuleIdEnum.balances) {
    await handleBalances(args);
  }
  if (moduleId === ModuleIdEnum.staking) {
    await handleStaking(args);
  }
}
