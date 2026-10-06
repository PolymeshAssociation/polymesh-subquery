import { SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import { AnomalyKind, EventIdEnum, MovementKind, PolyxPool, Subsidy } from '../../../types';
import { recordAnomaly } from '../../../utils/anomaly';
import { closingEventOf, indexClosingEvent } from '../block/closingEvent';
import { extractArgs, HandlerArgs } from '../common';
import { resolveFeePayer } from './feePayer';
import { extrinsicEmits, postTransition } from './ledgerCore';
import { creditBlockAuthor, treasuryShareAt } from './preV8Ledger';

/**
 * Transaction fees before v5.4.0 (spec 5004000), which the chain charged without announcing them.
 *
 * `transactionPayment.TransactionFeePaid` first appears at v5.4.0. Before it, every transaction
 * fee was taken with no event of its own: on testnet, every one in the first 8.48 million blocks.
 * This module reconstructs each one: how much was taken (computed as the runtime did, and checked
 * against the treasury's cut), who paid it (`feePayer.ts`), and what reached the block author.
 * From v5.4.0 the fee events say all of that, and the ledger's own fee handlers take over, though
 * until v5.4.1 those events name someone other than the account charged (see `chargedFor`).
 */

/**
 * Every fee whose treasury cut is `share`, lowest first.
 *
 * The runtime gave the treasury `floor(fee × 80 / 100)`, so the fee lies in
 * `[⌈5·share / 4⌉, ⌈5·(share + 1) / 4⌉ − 1]` — one value for three shares in four, and two when
 * `share` is a multiple of 4. Empty for no cut at all.
 */
const feeCandidates = (share: bigint): bigint[] => {
  if (share <= BigInt(0)) {
    return [];
  }

  const ceilDiv = (n: bigint, d: bigint) => (n + d - BigInt(1)) / d;
  const lowest = ceilDiv(BigInt(5) * share, BigInt(4));
  const highest = ceilDiv(BigInt(5) * (share + BigInt(1)), BigInt(4)) - BigInt(1);

  return highest > lowest ? [lowest, highest] : [lowest];
};

/**
 * The weight-to-fee coefficient, in parts per billion: `Perbill::from_rational(PolyXBaseFee,
 * ExtrinsicBaseWeight)`, 30,000 / 650,000,000, which rounds to 46,153. The same in every runtime
 * from v4.0.0 to v5.3.0.
 */
const FEE_PER_WEIGHT_PPB = BigInt(46_153);
const PPB = BigInt(1_000_000_000);
/** `ExtrinsicBaseWeight`: 650 µs of weight, charged on every extrinsic. */
const EXTRINSIC_BASE_WEIGHT = BigInt(650_000_000);
/** `TransactionByteFee`: 10 millicents, 100 base units, per byte of the encoded extrinsic. */
const BYTE_FEE = BigInt(100);

/** `WeightToFee`: a `Perbill` times the weight, rounded to the nearest unit, halves down. */
const weightToFee = (weight: bigint): bigint => {
  const scaled = FEE_PER_WEIGHT_PPB * weight;
  const rest = scaled % PPB;

  return scaled / PPB + (rest * BigInt(2) > PPB ? BigInt(1) : BigInt(0));
};

/**
 * The fee the runtime charged, worked out the way it did.
 *
 * Before v5.4.0 the fee multiplier never moved (`FeeMultiplierUpdate = ()`), so
 * `pallet_transaction_payment` charged exactly the base weight's fee, a fee per byte, the fee for
 * the weight the call actually used, and the tip. The used weight is what the extrinsic's closing
 * `ExtrinsicSuccess`/`ExtrinsicFailed` reports, after any refund: `contracts.call`,
 * `contracts.instantiate` and `staking.rebond` routinely use less than they declare.
 */
export const exactFee = (extrinsic: SubstrateExtrinsic, closing: SubstrateEvent): bigint => {
  const { method, data } = closing.event;
  const info = data[method === 'ExtrinsicFailed' ? 1 : 0] as unknown as {
    weight: { refTime?: { toString(): string }; toString(): string };
  };
  const used = BigInt((info.weight.refTime ?? info.weight).toString());

  return (
    weightToFee(EXTRINSIC_BASE_WEIGHT) +
    BYTE_FEE * BigInt(extrinsic.extrinsic.encodedLength) +
    weightToFee(used) +
    BigInt(extrinsic.extrinsic.tip.toString())
  );
};

/**
 * What an extrinsic that announced no fee was actually charged.
 *
 * Computed from the extrinsic, and checked against the treasury's cut, which is the chain's own
 * record that a fee was taken. No cut means nothing was: a call the runtime let off its fee, `sudo`
 * among them. A computed fee the cut doesn't allow is recorded, and the lowest fee the cut does
 * allow is charged instead.
 *
 * A fee quote can't stand in for the computation: `payment.queryInfo` prices the weight a call
 * declared, so for a refunded call it is too high, and it can't choose between the two fees a cut
 * may allow. It also cost a round trip per extrinsic, which held whole spam blocks up.
 */
const uneventedFee = async (
  extrinsic: SubstrateExtrinsic,
  closing: SubstrateEvent,
  share: bigint
): Promise<bigint> => {
  const candidates = feeCandidates(share);

  if (candidates.length === 0) {
    return BigInt(0);
  }

  const fee = exactFee(extrinsic, closing);

  if (candidates.includes(fee)) {
    return fee;
  }

  await recordAnomaly({
    kind: AnomalyKind.UnreadableValue,
    detail: `${extrinsic.extrinsic.method.section}.${extrinsic.extrinsic.method.method}: computed a fee of ${fee}, which a treasury cut of ${share} does not allow; charged ${candidates[0]}`,
    block: extrinsic.block,
    eventIdx: closing.idx,
  });

  return candidates[0];
};

/**
 * Posts the transaction fee of a signed extrinsic whose runtime announced none.
 *
 * `transactionPayment.TransactionFeePaid` first appears at v5.4.0 (spec 5004000). Before it the fee
 * was charged with no event of its own — on testnet, every transaction fee in the first 8.48 million
 * blocks — so each one was missing: the signer kept POLYX it had spent, and the author never
 * received its part. The reconciler caught both halves, as accounts holding less than the index
 * said and validators holding more.
 *
 * Every runtime in that range split each fee, 80% to the treasury and the rest to the author, and
 * the treasury's part is announced as `TreasuryReimbursement` just before the extrinsic closes. The
 * fee is computed as the runtime did and checked against that cut (see `uneventedFee`).
 *
 * Posted against the extrinsic's closing event — see `indexClosingEvent`.
 */
export const postUneventedTransactionFee = async (extrinsic: SubstrateExtrinsic): Promise<void> => {
  const { block } = extrinsic;

  // Every signed extrinsic from v5.4.0 on announces its fee, even a zero one — so an announced fee
  // is the one sure sign this runtime needs nothing reconstructed.
  if (
    !extrinsic.extrinsic.isSigned ||
    extrinsicEmits(block, extrinsic.idx, 'transactionPayment', 'TransactionFeePaid')
  ) {
    return;
  }

  // An extrinsic with no event of its own in the block has nothing to settle a fee against.
  const closing = closingEventOf(extrinsic);

  if (!closing) {
    return;
  }

  const treasuryShare = treasuryShareAt(block, closing.idx - 1, closing.idx);
  const fee = await uneventedFee(extrinsic, closing, treasuryShare);

  if (fee === BigInt(0)) {
    return;
  }

  await indexClosingEvent(extrinsic);

  const args = extractArgs(closing);

  await postTransition(args, {
    from: { address: await resolveFeeAccount(extrinsic), pool: PolyxPool.Free },
    amount: fee,
    kind: MovementKind.Fee,
  });
  await creditBlockAuthor(args, fee, treasuryShare);
};

/**
 * The account a fee event's fee was taken from, when no withdrawal of it was recorded.
 *
 * From v5.4.1 (spec 5004001) both fee events name it, subsidiser included (`fee_key`), so it is
 * taken as is: applying a subsidy again charged a subsidised paying key's own subsidiser instead
 * (testnet block 14,872,581, where a two-level subsidy moved 25 POLYX on to the wrong account).
 * Checked on testnet at 5004001, 5004002, 6002010, 7000005 and 7003003, where the named account
 * fell by the fee and the signer did not; v8 names `fee_key` too.
 *
 * Before it, each named someone else:
 * - `protocolFee.FeeCharged` the payer, before its subsidy (`check_subsidy(account, fee, None)`
 *   then `FeeCharged(account, …)`), which covers any call.
 * - `transactionPayment.TransactionFeePaid`, only on v5.4.0 (spec 5004000), the signer, while the
 *   fee was charged as before v5.4 (see `resolveFeeAccount`). So a call someone else pays for,
 *   such as `relayer.accept_paying_key`, left its signer low and its payer high.
 *
 * Gated on `block.specVersion`, which `ensureTrueSpecVersion` has already set to the runtime that
 * executed the block. So the subsidy is looked up only on the runtimes whose events left it out.
 */
export const chargedFor = async (args: HandlerArgs, who: string): Promise<string> => {
  if (args.block.specVersion >= 5_004_001) {
    return who;
  }
  if (args.eventId === EventIdEnum.FeeCharged) {
    return (await activeSubsidiser(who)) ?? who;
  }

  return args.extrinsic ? resolveFeeAccount(args.extrinsic) : who;
};

/** The paying key of `user`'s accepted, unremoved subsidy, from the indexed `Subsidy` rows. */
export const activeSubsidiser = async (user: string): Promise<string | undefined> => {
  const subsidies = await Subsidy.getByBeneficiaryAccountId(user, { limit: 10 });

  return subsidies.find(subsidy => subsidy.isAccepted && !subsidy.isRemoved)?.payingAccountId;
};

/**
 * The account a transaction fee was taken from, up to v5.4.0, when the runtime announced no fee
 * or named the signer: the payer `get_valid_payer` chose (`resolveFeePayer`), or the paying key of
 * that payer's subsidy (`check_subsidy(&payer_key, …)`). A subsidy covers every call but the
 * relayer's own: a subsidised payer's call to any other unsubsidised pallet is rejected, so never
 * reaches the chain.
 */
export const resolveFeeAccount = async (extrinsic: SubstrateExtrinsic): Promise<string> => {
  const payer = await resolveFeePayer(extrinsic);
  const subsidiser = await activeSubsidiser(payer);

  return subsidiser && extrinsic.extrinsic.method.section.toLowerCase() !== 'relayer'
    ? subsidiser
    : payer;
};
