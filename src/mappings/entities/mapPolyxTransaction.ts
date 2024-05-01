import BigNumber from 'bignumber.js';
import {
  Account,
  BalanceTypeEnum,
  Block,
  Event,
  EventIdEnum,
  Identity,
  ModuleIdEnum,
  PolyxTransaction,
} from '../../types';
import {
  bytesToString,
  getAccountKey,
  getBigIntValue,
  getEventParams,
  getTextValue,
} from '../util';
import { HandlerArgs } from './common';

const handleTreasuryReimbursement = async (args: HandlerArgs | Event): Promise<void> => {
  let did, balance;
  let specVersion: number;
  if (args instanceof Event) {
    const attributes = JSON.parse(args.attributesTxt);
    [{ value: did }, { value: balance }] = attributes;
    ({ specVersionId: specVersion } = await Block.get(args.blockId));
  } else {
    const [rawIdentity, rawBalance] = args.params;
    did = getTextValue(rawIdentity);
    balance = getTextValue(rawBalance);
    ({ specVersion } = args.block);
  }

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

const processTreasuryDisbursementArgs = async (args: HandlerArgs | Event, ss58Format?: number) => {
  let identityId, toId, toAddress, amount;
  if (args instanceof Event) {
    const attributes = JSON.parse(args.attributesTxt);
    let did, toDid, toAddressHex, balance;
    /**
     * Before spec version 500000, TreasuryDisbursement only had three params and there was not target account address in the event
     */
    const specName = api.runtimeVersion.specName.toString();
    if (args.specVersionId < 5000000 && specName !== 'polymesh_private_dev') {
      [{ value: did }, { value: toDid }, { value: balance }] = attributes;
    } else {
      [{ value: did }, { value: toDid }, { value: toAddressHex }, { value: balance }] = attributes;
    }
    identityId = did;
    toId = toDid;
    amount = BigInt(balance);
    if (toAddressHex) {
      toAddress = getAccountKey(toAddressHex, ss58Format);
    } else {
      ({ primaryAccount: toAddress } = await Identity.get(toDid));
    }
  } else {
    let rawFromIdentity, rawToDid, rawTo, rawBalance;

    const specName = api.runtimeVersion.specName.toString();
    if (args.block.specVersion < 5000000 && specName !== 'polymesh_private_dev') {
      [rawFromIdentity, rawToDid, rawBalance] = args.params;
    } else {
      [rawFromIdentity, rawToDid, rawTo, rawBalance] = args.params;
    }
    identityId = getTextValue(rawFromIdentity);
    toId = getTextValue(rawToDid);
    toAddress = getTextValue(rawTo);
    amount = getBigIntValue(rawBalance);
    if (!toAddress) {
      ({ primaryAccount: toAddress } = await Identity.get(toId));
    }
  }
  return { identityId, toId, toAddress, amount };
};

const handleTreasuryDisbursement = async (
  args: HandlerArgs | Event,
  ss58Format?: number
): Promise<void> => {
  const { identityId, toId, toAddress, amount } = await processTreasuryDisbursementArgs(
    args,
    ss58Format
  );

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

const handleBalanceTransfer = async (
  args: HandlerArgs | Event,
  ss58Format?: number
): Promise<void> => {
  let identityId, address, toId, toAddress, amount, memo;
  if (args instanceof Event) {
    let balance = 0;
    let addressHex = null,
      toAddressHex = null;
    const attributes = JSON.parse(args.attributesTxt);
    [
      { value: identityId },
      { value: addressHex },
      { value: toId },
      { value: toAddressHex },
      { value: balance },
      { value: memo },
    ] = attributes;

    amount = BigInt(balance);
    address = getAccountKey(addressHex, ss58Format);
    toAddress = getAccountKey(toAddressHex, ss58Format);
  } else {
    const [rawFromDid, rawFrom, rawToDid, rawTo, rawBalance, rawMemo] = args.params;

    amount = getBigIntValue(rawBalance);
    identityId = getTextValue(rawFromDid);
    address = getTextValue(rawFrom);
    toId = getTextValue(rawToDid);
    toAddress = getTextValue(rawTo);
    memo = bytesToString(rawMemo);
  }

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

const handleTransactionFeePaid = async (
  args: HandlerArgs | Event,
  ss58Format?: number
): Promise<void> => {
  let address, amount;

  if (args instanceof Event) {
    const attributes = JSON.parse(args.attributesTxt);
    const [{ value: addressHex }, { value: balance }] = attributes;
    address = getAccountKey(addressHex, ss58Format);
    amount = BigInt(balance);
  } else {
    const [rawAddress, rawActualFee] = args.params;
    address = getTextValue(rawAddress);
    amount = getBigIntValue(rawActualFee);
  }

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

const handleBalanceAdded = async (
  args: HandlerArgs | Event,
  type: BalanceTypeEnum,
  ss58Format?: number
): Promise<void> => {
  let toAddress, amount;

  if (args instanceof Event) {
    const attributes = JSON.parse(args.attributesTxt);
    const [{ value: addressHex }, { value: balance }] = attributes;
    toAddress = getAccountKey(addressHex, ss58Format);
    amount = BigInt(balance);
  } else {
    const [rawAddress, rawBalance] = args.params;
    toAddress = getTextValue(rawAddress);
    amount = getBigIntValue(rawBalance);
  }

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

const handleBalanceCharged = async (
  args: HandlerArgs | Event,
  type: BalanceTypeEnum,
  ss58Format?: number
): Promise<void> => {
  let address, amount;

  if (args instanceof Event) {
    const attributes = JSON.parse(args.attributesTxt);
    const [{ value: addressHex }, { value: balance }] = attributes;
    address = getAccountKey(addressHex, ss58Format);
    amount = BigInt(balance);
  } else {
    const [rawAddress, rawBalance] = args.params;
    address = getTextValue(rawAddress);
    amount = getBigIntValue(rawBalance);
  }

  const account = await Account.get(address);

  await PolyxTransaction.create({
    ...(await getEventParams(args)),
    address,
    identityId: account?.identityId,
    amount,
    type,
  }).save();
};

const handleBalanceReceived = async (
  args: HandlerArgs | Event,
  type: BalanceTypeEnum,
  ss58Format?: number
): Promise<void> => {
  let toId, toAddress, amount;

  if (args instanceof Event) {
    const attributes = JSON.parse(args.attributesTxt);
    const [{ value: did }, { value: addressHex }, { value: balance }] = attributes;
    toId = did;
    toAddress = getAccountKey(addressHex, ss58Format);
    amount = BigInt(balance);
  } else {
    const [rawDid, rawAddress, rawBalance] = args.params;
    toId = getTextValue(rawDid);
    toAddress = getTextValue(rawAddress);
    amount = getBigIntValue(rawBalance);
  }

  await PolyxTransaction.create({
    ...(await getEventParams(args)),
    toId,
    toAddress,
    amount,
    type,
  }).save();
};

const handleBalanceSpent = async (
  args: HandlerArgs | Event,
  type: BalanceTypeEnum,
  ss58Format?: number
): Promise<void> => {
  let identityId, address, amount;

  if (args instanceof Event) {
    const attributes = JSON.parse(args.attributesTxt);
    const [{ value: did }, { value: addressHex }, { value: balance }] = attributes;
    identityId = did;
    address = getAccountKey(addressHex, ss58Format);
    amount = BigInt(balance);
  } else {
    const [rawDid, rawAddress, rawBalance] = args.params;
    identityId = getTextValue(rawDid);
    address = getTextValue(rawAddress);
    amount = getBigIntValue(rawBalance);
  }

  await PolyxTransaction.create({
    ...(await getEventParams(args)),
    identityId,
    address,
    amount,
    type,
  }).save();
};

const handleBalanceSet = async (args: HandlerArgs | Event, ss58Format?: number): Promise<void> => {
  let toId, toAddress, amount, reservedAmount;

  if (args instanceof Event) {
    const attributes = JSON.parse(args.attributesTxt);
    const [{ value: did }, { value: addressHex }, { value: balance }, { value: reservedBalance }] =
      attributes;
    toId = did;
    toAddress = getAccountKey(addressHex, ss58Format);
    amount = BigInt(balance);
    reservedAmount = BigInt(reservedBalance);
  } else {
    const [rawDid, rawAddress, rawFreeBalance, rawReservedBalance] = args.params;
    toId = getTextValue(rawDid);
    toAddress = getTextValue(rawAddress);
    amount = getBigIntValue(rawFreeBalance);
    reservedAmount = getBigIntValue(rawReservedBalance);
  }

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

const handleTreasury = async (args: HandlerArgs | Event, ss58Format?: number): Promise<void> => {
  const { eventId } = args;
  if (eventId === EventIdEnum.TreasuryReimbursement) {
    await handleTreasuryReimbursement(args);
  }
  if (eventId === EventIdEnum.TreasuryDisbursement) {
    await handleTreasuryDisbursement(args, ss58Format);
  }
};

const handleBalances = async (args: HandlerArgs | Event, ss58Format?: number): Promise<void> => {
  const { eventId } = args;
  switch (eventId) {
    case EventIdEnum.Transfer:
      await handleBalanceTransfer(args, ss58Format);
      break;
    case EventIdEnum.Endowed:
      await handleBalanceReceived(args, BalanceTypeEnum.Free, ss58Format);
      break;
    case EventIdEnum.Reserved:
      await handleBalanceCharged(args, BalanceTypeEnum.Reserved, ss58Format);
      break;
    case EventIdEnum.Unreserved:
      await handleBalanceAdded(args, BalanceTypeEnum.Free, ss58Format);
      break;
    case EventIdEnum.AccountBalanceBurned:
      await handleBalanceSpent(args, BalanceTypeEnum.Free, ss58Format);
      break;
    case EventIdEnum.BalanceSet:
      await handleBalanceSet(args, ss58Format);
      break;
  }
};

const handleStaking = async (args: HandlerArgs | Event, ss58Format?: number): Promise<void> => {
  const { eventId } = args;
  switch (eventId) {
    case EventIdEnum.Bonded:
      await handleBalanceSpent(args, BalanceTypeEnum.Bonded, ss58Format);
      break;
    case EventIdEnum.Unbonded:
      await handleBalanceReceived(args, BalanceTypeEnum.Unbonded, ss58Format);
      break;
    case EventIdEnum.Reward:
      await handleBalanceReceived(args, BalanceTypeEnum.Free, ss58Format);
      break;
    case EventIdEnum.Withdrawn:
      await handleBalanceAdded(args, BalanceTypeEnum.Unbonded, ss58Format);
      break;
  }
};

const handleProtocolFee = async (args: HandlerArgs | Event, ss58Format?: number): Promise<void> => {
  const { eventId } = args;
  if (eventId === EventIdEnum.FeeCharged) {
    await handleBalanceCharged(args, BalanceTypeEnum.Free, ss58Format);
  }
};

const handleTransactionPayment = async (args: HandlerArgs | Event): Promise<void> => {
  const { eventId } = args;
  if (eventId === EventIdEnum.TransactionFeePaid) {
    await handleTransactionFeePaid(args);
  }
};

export async function mapPolyxTransaction(
  args: HandlerArgs | Event,
  ss58Format?: number
): Promise<void> {
  const { moduleId } = args;
  if (moduleId === ModuleIdEnum.treasury) {
    await handleTreasury(args);
  }
  if (moduleId === ModuleIdEnum.balances) {
    await handleBalances(args, ss58Format);
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
