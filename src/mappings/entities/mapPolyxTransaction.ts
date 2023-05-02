import { SubstrateEvent } from '@subql/types';
import BigNumber from 'bignumber.js';
import {
  Account,
  BalanceTypeEnum,
  Block,
  CallIdEnum,
  Event,
  EventIdEnum,
  Extrinsic,
  Identity,
  ModuleIdEnum,
  PolyxTransaction,
} from '../../types';
import { PolyxTransactionProps } from '../../types/models/PolyxTransaction';
import {
  bytesToString,
  camelToSnakeCase,
  getAccountKey,
  getBigIntValue,
  getTextValue,
} from '../util';
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

const getBasicDetails = async (args: HandlerArgs | Event) => {
  if (args instanceof Event) {
    const { id, moduleId, eventId, blockId, eventIdx } = args;
    const extrinsic = await Extrinsic.get(`${blockId}/${args.extrinsicIdx}`);
    const block = await Block.get(blockId);
    return {
      id,
      moduleId,
      eventId,
      callId: extrinsic?.callId,
      extrinsicId: extrinsic?.id,
      datetime: block?.datetime,
      eventIdx,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    };
  } else {
    const { blockId, eventId, moduleId, event } = args;
    return {
      id: `${blockId}/${event.idx}`,
      moduleId,
      eventId,
      ...getExtrinsicDetails(blockId, event),
      datetime: event.block.timestamp,
      eventIdx: event.idx,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    };
  }
};

const handleTreasuryReimbursement = async (args: HandlerArgs | Event): Promise<void> => {
  let did, balance;
  if (args instanceof Event) {
    const attributes = JSON.parse(args.attributesTxt);
    [{ value: did }, { value: balance }] = attributes;
  } else {
    const [rawIdentity, rawBalance] = args.params;
    did = getTextValue(rawIdentity);
    balance = getTextValue(rawBalance);
  }

  const identity = await Identity.get(did);

  // treasury reimbursement is only 80% of the actual amount deducted
  const reimbursementBalance = new BigNumber(balance || 0);
  const amount = BigInt(
    reimbursementBalance.multipliedBy(1.25).integerValue(BigNumber.ROUND_FLOOR).toString()
  );
  const details = await getBasicDetails(args);

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

const handleTreasuryDisbursement = async (
  args: HandlerArgs | Event,
  ss58Format?: number
): Promise<void> => {
  let identityId, toId, toAddress, amount;
  if (args instanceof Event) {
    const attributes = JSON.parse(args.attributesTxt);
    const [{ value: did }, { value: toDid }, { value: toAddressHex }, { value: balance }] =
      attributes;
    identityId = did;
    toId = toDid;
    amount = BigInt(balance);
    toAddress = getAccountKey(toAddressHex, ss58Format);
  } else {
    const [rawFromIdentity, rawToDid, rawTo, rawBalance] = args.params;
    identityId = getTextValue(rawFromIdentity);
    toId = getTextValue(rawToDid);
    toAddress = getTextValue(rawTo);
    amount = getBigIntValue(rawBalance);
  }

  const details = await getBasicDetails(args);
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

  const details = await getBasicDetails(args);

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

  const details = await getBasicDetails(args);
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

  const details = await getBasicDetails(args);
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
    ...(await getBasicDetails(args)),
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
    ...(await getBasicDetails(args)),
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
    ...(await getBasicDetails(args)),
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

  const details = await getBasicDetails(args);

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
