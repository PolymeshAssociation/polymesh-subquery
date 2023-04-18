import { SubstrateEvent } from '@subql/types';
import BigNumber from 'bignumber.js';
import {
  Account,
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

  const amount = getBigIntValue(rawBalance);
  const details = getBasicDetails(args);
  if (details.extrinsicId) {
    const transactions = await PolyxTransaction.getByExtrinsicId(details.extrinsicId);
    const transferPolyxTransaction = transactions.find(
      ({ eventId }) => eventId === EventIdEnum.Transfer
    );
    /**
     * in case when `treasury.disbursement` extrinsic is used to disburse some amount to an identity,
     * both `Transfer` and `TreasuryDisbursement` events are triggered,
     * in this case we update the `Transfer` entry to reflect `Disbursement`
     * and skip adding a separate `TreasuryDisbursement` entry
     */
    if (transferPolyxTransaction && amount === transferPolyxTransaction.amount) {
      // this is the case where treasury reimbursement is showing that 80% of protocol fee charged
      // We ignore this case to insert in PolyxTransaction
      Object.assign(transferPolyxTransaction, {
        eventId: EventIdEnum.TreasuryDisbursement,
      });
      await transferPolyxTransaction.save();
      return;
    }
  }

  const fromDid = getTextValue(rawFromIdentity);
  const fromIdentity = await Identity.get(fromDid);

  await PolyxTransaction.create({
    ...getBasicDetails(args),
    identityId: fromDid,
    address: fromIdentity?.primaryAccount,
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

const handleTransactionFeePaid = async (args: HandlerArgs): Promise<void> => {
  const [rawAddress, rawActualFee] = args.params;

  const amount = getBigIntValue(rawActualFee);
  const address = getTextValue(rawAddress);
  const details = getBasicDetails(args);
  if (details.extrinsicId) {
    const transactions = await PolyxTransaction.getByExtrinsicId(details.extrinsicId);
    const reimbursementTransaction = transactions
      .reverse()
      .find(({ eventId }) => eventId === EventIdEnum.TreasuryReimbursement);
    /**
     * From chain 5.4, with `TreasuryReimbursement` there is a `TransactionFeePaid` event as well.
     * In this case, we will update the already inserted `TreasuryReimbursement` to point that it was indeed for done for `TransactionFeePaid`
     * We also update the amount to get the exact value (since in treasury reimbursement, we calculate the amount as amount * 1.25 which can be off by some balance amount)
     */
    if (reimbursementTransaction) {
      Object.assign(reimbursementTransaction, {
        address,
        amount,
        moduleId: ModuleIdEnum.transactionpayment,
        eventId: EventIdEnum.TransactionFeePaid,
      });
      await reimbursementTransaction.save();
      return;
    }
  }

  const account = await Account.get(address);

  await PolyxTransaction.create({
    ...details,
    identityId: account?.identityId,
    address,
    amount,
    type: BalanceType.Free,
  }).save();
};

const handleBalanceAdded = async (args: HandlerArgs, type: BalanceType): Promise<void> => {
  const [rawAddress, rawBalance] = args.params;

  const amount = getBigIntValue(rawBalance);
  const address = getTextValue(rawAddress);

  const account = await Account.get(address);

  await PolyxTransaction.create({
    ...getBasicDetails(args),
    toAddress: address,
    toId: account?.identityId,
    amount,
    type,
  }).save();
};

const handleBalanceCharged = async (args: HandlerArgs, type: BalanceType): Promise<void> => {
  const [rawAddress, rawBalance] = args.params;

  const amount = getBigIntValue(rawBalance);
  const address = getTextValue(rawAddress);

  const account = await Account.get(address);

  logger.info(address, account);

  await PolyxTransaction.create({
    ...getBasicDetails(args),
    address,
    identityId: account?.identityId,
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

const handleBalanceSet = async (args: HandlerArgs): Promise<void> => {
  const [rawDid, rawAddress, rawFreeBalance, rawReservedBalance] = args.params;

  // add the newly set free balance
  await PolyxTransaction.create({
    ...getBasicDetails(args),
    toId: getTextValue(rawDid),
    toAddress: getTextValue(rawAddress),
    amount: getBigIntValue(rawFreeBalance),
    type: BalanceType.Free,
  }).save();

  // add the newly set reserve balance
  await PolyxTransaction.create({
    ...getBasicDetails(args),
    toId: getTextValue(rawDid),
    toAddress: getTextValue(rawAddress),
    amount: getBigIntValue(rawReservedBalance),
    type: BalanceType.Reserved,
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
      await handleBalanceCharged(args, BalanceType.Reserved);
      break;
    case EventIdEnum.Unreserved:
      await handleBalanceAdded(args, BalanceType.Free);
      break;
    case EventIdEnum.AccountBalanceBurned:
      await handleBalanceSpent(args, BalanceType.Free);
      break;
    case EventIdEnum.BalanceSet:
      await handleBalanceSet(args);
      break;
  }
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

const handleTransactionPayment = async (args: HandlerArgs): Promise<void> => {
  const { eventId } = args;
  if (eventId === EventIdEnum.TransactionFeePaid) {
    await handleTransactionFeePaid(args);
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
  if (moduleId === ModuleIdEnum.transactionpayment) {
    await handleTransactionPayment(args);
  }
}
