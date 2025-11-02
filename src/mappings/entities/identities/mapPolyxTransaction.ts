import { SubstrateEvent } from '@subql/types';
import BigNumber from 'bignumber.js';
import {
  Account,
  BalanceTypeEnum,
  EventIdEnum,
  Identity,
  ModuleIdEnum,
  PolyxTransaction,
} from '../../../types';
import { bytesToString, getBigIntValue, getEventParams, getTextValue } from '../../../utils';
import { is8xChain } from '../../../utils/common';
import { HandlerArgs, extractArgs } from '../common';
import { getPaginatedData } from './../../../utils/common';

export const handleTreasuryReimbursement = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
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
  const details = getEventParams(args);

  if (details.extrinsicId) {
    const transactions: PolyxTransaction[] = await getPaginatedData<
      PolyxTransaction,
      'extrinsicId'
    >('PolyxTransaction', 'extrinsicId', details.extrinsicId);

    const protocolFeePolyxTransaction: PolyxTransaction | undefined = transactions.find(
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

export const handleTreasuryDisbursement = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);

  const { identityId, toId, toAddress, amount } = await processTreasuryDisbursementArgs(args);

  const details = getEventParams(args);

  if (details.extrinsicId) {
    const transactions: PolyxTransaction[] = await getPaginatedData<
      PolyxTransaction,
      'extrinsicId'
    >('PolyxTransaction', 'extrinsicId', details.extrinsicId);

    const transferPolyxTransaction: PolyxTransaction | undefined = transactions.find(
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
      transferPolyxTransaction.eventId = EventIdEnum.TreasuryDisbursement;
      await PolyxTransaction.create(transferPolyxTransaction).save();
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

export const handleBalanceTransfer = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);

  const [rawFromDid, rawFrom, rawToDid, rawTo, rawBalance, rawMemo] = args.params;

  const amount = getBigIntValue(rawBalance);
  const identityId = getTextValue(rawFromDid);
  const address = getTextValue(rawFrom);
  const toId = getTextValue(rawToDid);
  const toAddress = getTextValue(rawTo);
  const memo = bytesToString(rawMemo);

  const details = getEventParams(args);

  if (details.extrinsicId) {
    const transactions: PolyxTransaction[] = await getPaginatedData<
      PolyxTransaction,
      'extrinsicId'
    >('PolyxTransaction', 'extrinsicId', details.extrinsicId);

    const endowedPolyxTransaction: PolyxTransaction | undefined = transactions.find(
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
      endowedPolyxTransaction.identityId = identityId;
      endowedPolyxTransaction.address = address;
      endowedPolyxTransaction.memo = memo;

      await PolyxTransaction.create(endowedPolyxTransaction).save();
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

export const handleTransactionFeeCharged = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);

  const [rawAddress, rawActualFee] = args.params;
  const address = getTextValue(rawAddress);
  const amount = getBigIntValue(rawActualFee);

  const details = getEventParams(args);
  if (details.extrinsicId) {
    const transactions: PolyxTransaction[] = await getPaginatedData<
      PolyxTransaction,
      'extrinsicId'
    >('PolyxTransaction', 'extrinsicId', details.extrinsicId);

    const reimbursementTransaction: PolyxTransaction | undefined = transactions
      .slice()
      .reverse()
      .find(({ eventId }) => eventId === EventIdEnum.TreasuryReimbursement);
    /**
     * From chain 5.4, with `TreasuryReimbursement` there is a `TransactionFeePaid` event as well.
     * In this case, we will update the already inserted `TreasuryReimbursement` to point that it was indeed for done for `TransactionFeePaid`
     * We also update the amount to get the exact value (since in treasury reimbursement, we calculate the amount as amount * 1.25 which can be off by some balance amount)
     */
    if (reimbursementTransaction) {
      reimbursementTransaction.address = address;
      reimbursementTransaction.amount = amount;
      reimbursementTransaction.moduleId = ModuleIdEnum.transactionpayment;
      reimbursementTransaction.eventId = EventIdEnum.TransactionFeePaid;
      await PolyxTransaction.create(reimbursementTransaction).save();
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

const handleBalanceAdded = async (event: SubstrateEvent, type: BalanceTypeEnum): Promise<void> => {
  const args = extractArgs(event);

  const [rawAddress, rawBalance] = args.params;
  const toAddress = getTextValue(rawAddress);
  const amount = getBigIntValue(rawBalance);

  const details = getEventParams(args);
  const account = await Account.get(toAddress);

  await PolyxTransaction.create({
    ...details,
    toAddress: toAddress,
    toId: account?.identityId,
    amount,
    type,
  }).save();
};

const handleBalanceCharged = async (
  event: SubstrateEvent,
  type: BalanceTypeEnum
): Promise<void> => {
  const args = extractArgs(event);

  const [rawAddress, rawBalance] = args.params;
  const address = getTextValue(rawAddress);
  const amount = getBigIntValue(rawBalance);

  const account = await Account.get(address);

  await PolyxTransaction.create({
    ...getEventParams(args),
    address,
    identityId: account?.identityId,
    amount,
    type,
  }).save();
};

const handleBalanceReceived = async (
  event: SubstrateEvent,
  type: BalanceTypeEnum
): Promise<void> => {
  const args = extractArgs(event);

  const [rawDid, rawAddress, rawBalance] = args.params;
  const toId = getTextValue(rawDid);
  const toAddress = getTextValue(rawAddress);
  const amount = getBigIntValue(rawBalance);

  await PolyxTransaction.create({
    ...getEventParams(args),
    toId,
    toAddress,
    amount,
    type,
  }).save();
};

const handleBalanceSpent = async (event: SubstrateEvent, type: BalanceTypeEnum): Promise<void> => {
  const args = extractArgs(event);

  let identityId: string | undefined;
  let address: string | undefined;
  let amount: bigint | undefined;
  if (is8xChain(args.block)) {
    const [rawAddress, rawBalance] = args.params;
    address = getTextValue(rawAddress);
    amount = getBigIntValue(rawBalance);
  } else {
    const [rawDid, rawAddress, rawBalance] = args.params;
    identityId = getTextValue(rawDid);
    address = getTextValue(rawAddress);
    amount = getBigIntValue(rawBalance);
  }

  await PolyxTransaction.create({
    ...getEventParams(args),
    identityId,
    address,
    amount,
    type,
  }).save();
};

export const handleBalanceSet = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  let toId: string;
  let toAddress: string;
  let amount: bigint;
  let reservedAmount: bigint;

  if (is8xChain(args.block)) {
    const [rawAddress, rawFreeBalance] = args.params;
    toAddress = getTextValue(rawAddress);
    amount = getBigIntValue(rawFreeBalance);
  } else {
    const [rawDid, rawAddress, rawFreeBalance, rawReservedBalance] = args.params;
    toId = getTextValue(rawDid);
    toAddress = getTextValue(rawAddress);
    amount = getBigIntValue(rawFreeBalance);
    reservedAmount = getBigIntValue(rawReservedBalance);
  }

  const details = getEventParams(args);

  // add the newly set free balance
  await PolyxTransaction.create({
    ...details,
    toId,
    toAddress,
    amount,
    type: BalanceTypeEnum.Free,
  }).save();

  if (reservedAmount) {
    // add the newly set reserve balance
    await PolyxTransaction.create({
      ...details,
      toId,
      toAddress,
      amount: reservedAmount,
      type: BalanceTypeEnum.Reserved,
    }).save();
  }
};

export const handleBalanceEndowed = async (event: SubstrateEvent): Promise<void> => {
  await handleBalanceReceived(event, BalanceTypeEnum.Free);
};

export const handleBalanceReserved = async (event: SubstrateEvent): Promise<void> => {
  await handleBalanceCharged(event, BalanceTypeEnum.Reserved);
};

export const handleBalanceUnreserved = async (event: SubstrateEvent): Promise<void> => {
  await handleBalanceAdded(event, BalanceTypeEnum.Free);
};

export const handleBalanceBurned = async (event: SubstrateEvent): Promise<void> => {
  await handleBalanceSpent(event, BalanceTypeEnum.Free);
};

export const handleBonded = async (event: SubstrateEvent): Promise<void> => {
  await handleBalanceSpent(event, BalanceTypeEnum.Bonded);
};

export const handleUnbonded = async (event: SubstrateEvent): Promise<void> => {
  await handleBalanceReceived(event, BalanceTypeEnum.Unbonded);
};

export const handleReward = async (event: SubstrateEvent): Promise<void> => {
  await handleBalanceReceived(event, BalanceTypeEnum.Free);
};

export const handleWithdrawn = async (event: SubstrateEvent): Promise<void> => {
  await handleBalanceAdded(event, BalanceTypeEnum.Unbonded);
};

export const handleFeeCharged = async (event: SubstrateEvent): Promise<void> => {
  await handleBalanceCharged(event, BalanceTypeEnum.Free);
};

export const handleBalanceDeposit = async (event: SubstrateEvent): Promise<void> => {
  await handleBalanceAdded(event, BalanceTypeEnum.Free);
};
