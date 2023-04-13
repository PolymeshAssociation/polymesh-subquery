import { SubstrateEvent } from '@subql/types';
import BigNumber from 'bignumber.js';
import {
  BalanceType,
  CallIdEnum,
  EventIdEnum,
  Identity,
  ModuleIdEnum,
  PolyxTransaction,
} from '../../types';
import { PolyxTransactionProps } from '../../types/models/PolyxTransaction';
import { getAccountId, systematicIssuers } from '../consts';
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

  const did = getTextValue(rawIdentity);
  const identity = await Identity.get(did);

  // treasury reimbursement is only 80% of the actual amount deducted
  const reimbursementBalance = new BigNumber(getTextValue(rawBalance) || 0);
  const amount = BigInt(
    reimbursementBalance.multipliedBy(1.25).integerValue(BigNumber.ROUND_FLOOR).toString()
  );
  const details = getBasicDetails(args);

  if (details.extrinsicId) {
    const transactions = await PolyxTransaction.getByExtrinsicId(details.extrinsicId);
    const protocolFeePolyxTransaction = transactions.find(
      ({ eventId }) => eventId === EventIdEnum.FeeCharged
    );
    if (protocolFeePolyxTransaction && amount === protocolFeePolyxTransaction.amount) {
      // this is the case where treasury reimbursement is showing that 80% of protocol fee charged
      // We ignore this case to insert in PolyxTransaction
      return;
    }
  }

  const { did: treasuryDid, accountId: treasuryAccount } = systematicIssuers.treasury;
  await PolyxTransaction.create({
    ...details,
    identityId: did,
    address: identity?.primaryAccount,
    toId: treasuryDid,
    toAddress: getAccountId(treasuryAccount, rawIdentity.registry.chainSS58),
    amount,
    type: BalanceType.Free,
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
    type: BalanceType.Free,
  }).save();
};

const handleBalanceTransfer = async (args: HandlerArgs): Promise<void> => {
  const [rawFromDid, rawFrom, rawToDid, rawTo, rawBalance, rawMemo] = args.params;

  const amount = getBigIntValue(rawBalance);
  const details = getBasicDetails(args);
  if (details.extrinsicId) {
    const transactions = await PolyxTransaction.getByExtrinsicId(details.extrinsicId);
    const endowedPolyxTransaction = transactions.find(
      ({ eventId }) => eventId === EventIdEnum.Endowed
    );
    /**
     * in case when `balances.transfer` extrinsic is used to transfer some balance
     * to an account for the first time, both `Endowed` and `Transfer` events are triggered,
     * in this case we update the `Endowed` entry to reflect details of the account from which
     * transfer was initiated and skip adding a separate `Transfer` entry
     */
    if (endowedPolyxTransaction && amount === endowedPolyxTransaction.amount) {
      // this is the case where treasury reimbursement is showing that 80% of protocol fee charged
      // We ignore this case to insert in PolyxTransaction
      Object.assign(endowedPolyxTransaction, {
        identityId: getTextValue(rawFromDid),
        address: getTextValue(rawFrom),
        memo: bytesToString(rawMemo),
      });
      await endowedPolyxTransaction.save();
      return;
    }
  }

  await PolyxTransaction.create({
    ...details,
    identityId: getTextValue(rawFromDid),
    address: getTextValue(rawFrom),
    toId: getTextValue(rawToDid),
    toAddress: getTextValue(rawTo),
    amount: getBigIntValue(rawBalance),
    memo: bytesToString(rawMemo),
    type: BalanceType.Free,
  }).save();
};

const handleBalanceAdded = async (args: HandlerArgs, type: BalanceType): Promise<void> => {
  const [rawAddress, rawBalance] = args.params;

  const amount = getBigIntValue(rawBalance);
  await PolyxTransaction.create({
    ...getBasicDetails(args),
    toAddress: getTextValue(rawAddress),
    amount,
    type,
  }).save();
};

const handleBalanceCharged = async (args: HandlerArgs, type: BalanceType): Promise<void> => {
  const [rawAddress, rawBalance] = args.params;

  const amount = getBigIntValue(rawBalance);
  await PolyxTransaction.create({
    ...getBasicDetails(args),
    address: getTextValue(rawAddress),
    amount,
    type,
  }).save();
};

const handleBalanceReceived = async (args: HandlerArgs, type: BalanceType): Promise<void> => {
  const [rawDid, rawAddress, rawBalance] = args.params;

  const amount = getBigIntValue(rawBalance);
  await PolyxTransaction.create({
    ...getBasicDetails(args),
    toId: getTextValue(rawDid),
    toAddress: getTextValue(rawAddress),
    amount,
    type,
  }).save();
};

const handleBalanceSpent = async (args: HandlerArgs, type: BalanceType): Promise<void> => {
  const [rawDid, rawAddress, rawBalance] = args.params;

  const amount = getBigIntValue(rawBalance);
  await PolyxTransaction.create({
    ...getBasicDetails(args),
    identityId: getTextValue(rawDid),
    address: getTextValue(rawAddress),
    amount,
    type,
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
  switch (eventId) {
    case EventIdEnum.Transfer:
      await handleBalanceTransfer(args);
      break;
    case EventIdEnum.Endowed:
      await handleBalanceReceived(args, BalanceType.Free);
      break;
    case EventIdEnum.Reserved:
      await handleBalanceCharged(args, BalanceType.Free);
      break;
    case EventIdEnum.Unreserved:
      await handleBalanceAdded(args, BalanceType.Free);
      break;
    case EventIdEnum.AccountBalanceBurned:
      await handleBalanceSpent(args, BalanceType.Unbonded);
      break;
  }
  // BalanceSet and ReserveRepatriated left to be handled
};

const handleStaking = async (args: HandlerArgs): Promise<void> => {
  const { eventId } = args;
  switch (eventId) {
    case EventIdEnum.Bonded:
      await handleBalanceSpent(args, BalanceType.Bonded);
      break;
    case EventIdEnum.Unbonded:
      await handleBalanceReceived(args, BalanceType.Unbonded);
      break;
    case EventIdEnum.Reward:
      await handleBalanceReceived(args, BalanceType.Free);
      break;
    case EventIdEnum.Withdrawn:
      await handleBalanceAdded(args, BalanceType.Unbonded);
      break;
  }
};

const handleProtocolFee = async (args: HandlerArgs): Promise<void> => {
  const { eventId } = args;
  if (eventId === EventIdEnum.FeeCharged) {
    await handleBalanceCharged(args, BalanceType.Free);
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
  if (moduleId === ModuleIdEnum.protocolfee) {
    await handleProtocolFee(args);
  }
}
