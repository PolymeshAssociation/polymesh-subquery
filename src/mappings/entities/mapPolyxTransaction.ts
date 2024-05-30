import BigNumber from 'bignumber.js';
import {
  Account,
  BalanceTypeEnum,
  EventIdEnum,
  Identity,
  ModuleIdEnum,
  PolyxTransaction,
} from '../../types';
import { bytesToString, getBigIntValue, getEventParams, getTextValue } from '../util';
import { HandlerArgs } from './common';

const handleTreasuryReimbursement = async (args: HandlerArgs): Promise<void> => {
  const [rawIdentity, rawBalance] = args.params;
  const did = getTextValue(rawIdentity);
  const balance = getTextValue(rawBalance);
  const { specVersion } = args.block;

  const identity = await Identity.get(did);

  /**
   * Till chain 5.4.1, treasury reimbursement was only 80% of the actual amount deducted
   * Post that the split between author/treasury was removed
   */
  let amount: bigint;
  if (specVersion < 5004001) {
    amount = BigInt(
      new BigNumber(balance || 0).multipliedBy(1.25).integerValue(BigNumber.ROUND_FLOOR).toString()
    );
  } else {
    amount = BigInt(balance || 0);
  }
  const details = await getEventParams(args);

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

  await PolyxTransaction.create({
    ...details,
    identityId: did,
    address: identity?.primaryAccount,
    toId: null,
    toAddress: null,
    amount,
    type: BalanceTypeEnum.Free,
  }).save();
};

const processTreasuryDisbursementArgs = async (args: HandlerArgs) => {
  let rawFromIdentity, rawToDid, rawTo, rawBalance;

  const specName = api.runtimeVersion.specName.toString();
  if (args.block.specVersion < 5000000 && specName !== 'polymesh_private_dev') {
    [rawFromIdentity, rawToDid, rawBalance] = args.params;
  } else {
    [rawFromIdentity, rawToDid, rawTo, rawBalance] = args.params;
  }
  const identityId = getTextValue(rawFromIdentity);
  const toId = getTextValue(rawToDid);
  const amount = getBigIntValue(rawBalance);

  let toAddress = getTextValue(rawTo);

  if (!toAddress) {
    ({ primaryAccount: toAddress } = await Identity.get(toId));
  }

  return { identityId, toId, toAddress, amount };
};

const handleTreasuryDisbursement = async (args: HandlerArgs): Promise<void> => {
  const { identityId, toId, toAddress, amount } = await processTreasuryDisbursementArgs(args);

  const details = await getEventParams(args);

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

  const fromIdentity = await Identity.get(identityId);

  await PolyxTransaction.create({
    ...details,
    identityId,
    address: fromIdentity?.primaryAccount,
    toId,
    toAddress,
    amount,
    type: BalanceTypeEnum.Free,
  }).save();
};

const handleBalanceTransfer = async (args: HandlerArgs): Promise<void> => {
  const [rawFromDid, rawFrom, rawToDid, rawTo, rawBalance, rawMemo] = args.params;

  const amount = getBigIntValue(rawBalance);
  const identityId = getTextValue(rawFromDid);
  const address = getTextValue(rawFrom);
  const toId = getTextValue(rawToDid);
  const toAddress = getTextValue(rawTo);
  const memo = bytesToString(rawMemo);

  const details = await getEventParams(args);

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
        identityId,
        address,
        memo,
      });
      await endowedPolyxTransaction.save();
      return;
    }
  }

  await PolyxTransaction.create({
    ...details,
    identityId,
    address,
    toId,
    toAddress,
    amount,
    memo,
    type: BalanceTypeEnum.Free,
  }).save();
};

const handleTransactionFeePaid = async (args: HandlerArgs): Promise<void> => {
  const [rawAddress, rawActualFee] = args.params;
  const address = getTextValue(rawAddress);
  const amount = getBigIntValue(rawActualFee);

  const details = await getEventParams(args);
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
    type: BalanceTypeEnum.Free,
  }).save();
};

const handleBalanceAdded = async (args: HandlerArgs, type: BalanceTypeEnum): Promise<void> => {
  const [rawAddress, rawBalance] = args.params;
  const toAddress = getTextValue(rawAddress);
  const amount = getBigIntValue(rawBalance);

  const details = await getEventParams(args);
  const account = await Account.get(toAddress);

  await PolyxTransaction.create({
    ...details,
    toAddress: toAddress,
    toId: account?.identityId,
    amount,
    type,
  }).save();
};

const handleBalanceCharged = async (args: HandlerArgs, type: BalanceTypeEnum): Promise<void> => {
  const [rawAddress, rawBalance] = args.params;
  const address = getTextValue(rawAddress);
  const amount = getBigIntValue(rawBalance);

  const account = await Account.get(address);

  await PolyxTransaction.create({
    ...(await getEventParams(args)),
    address,
    identityId: account?.identityId,
    amount,
    type,
  }).save();
};

const handleBalanceReceived = async (args: HandlerArgs, type: BalanceTypeEnum): Promise<void> => {
  const [rawDid, rawAddress, rawBalance] = args.params;
  const toId = getTextValue(rawDid);
  const toAddress = getTextValue(rawAddress);
  const amount = getBigIntValue(rawBalance);

  await PolyxTransaction.create({
    ...(await getEventParams(args)),
    toId,
    toAddress,
    amount,
    type,
  }).save();
};

const handleBalanceSpent = async (args: HandlerArgs, type: BalanceTypeEnum): Promise<void> => {
  const [rawDid, rawAddress, rawBalance] = args.params;
  const identityId = getTextValue(rawDid);
  const address = getTextValue(rawAddress);
  const amount = getBigIntValue(rawBalance);

  await PolyxTransaction.create({
    ...(await getEventParams(args)),
    identityId,
    address,
    amount,
    type,
  }).save();
};

const handleBalanceSet = async (args: HandlerArgs): Promise<void> => {
  const [rawDid, rawAddress, rawFreeBalance, rawReservedBalance] = args.params;
  const toId = getTextValue(rawDid);
  const toAddress = getTextValue(rawAddress);
  const amount = getBigIntValue(rawFreeBalance);
  const reservedAmount = getBigIntValue(rawReservedBalance);

  const details = await getEventParams(args);

  // add the newly set free balance
  await PolyxTransaction.create({
    ...details,
    toId,
    toAddress,
    amount,
    type: BalanceTypeEnum.Free,
  }).save();

  // add the newly set reserve balance
  await PolyxTransaction.create({
    ...details,
    toId,
    toAddress,
    amount: reservedAmount,
    type: BalanceTypeEnum.Reserved,
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
      await handleBalanceReceived(args, BalanceTypeEnum.Free);
      break;
    case EventIdEnum.Reserved:
      await handleBalanceCharged(args, BalanceTypeEnum.Reserved);
      break;
    case EventIdEnum.Unreserved:
      await handleBalanceAdded(args, BalanceTypeEnum.Free);
      break;
    case EventIdEnum.AccountBalanceBurned:
      await handleBalanceSpent(args, BalanceTypeEnum.Free);
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
      await handleBalanceSpent(args, BalanceTypeEnum.Bonded);
      break;
    case EventIdEnum.Unbonded:
      await handleBalanceReceived(args, BalanceTypeEnum.Unbonded);
      break;
    case EventIdEnum.Reward:
      await handleBalanceReceived(args, BalanceTypeEnum.Free);
      break;
    case EventIdEnum.Withdrawn:
      await handleBalanceAdded(args, BalanceTypeEnum.Unbonded);
      break;
  }
};

const handleProtocolFee = async (args: HandlerArgs): Promise<void> => {
  const { eventId } = args;
  if (eventId === EventIdEnum.FeeCharged) {
    await handleBalanceCharged(args, BalanceTypeEnum.Free);
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
