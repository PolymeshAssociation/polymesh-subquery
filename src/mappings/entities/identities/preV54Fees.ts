import { SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import { AnomalyKind, MovementKind, PolyxPool } from '../../../types';
import { recordAnomaly } from '../../../utils/anomaly';
import { closingEventOf, indexClosingEvent } from '../block/closingEvent';
import { extractArgs } from '../common';
import {
  creditBlockAuthor,
  extrinsicEmits,
  postTransition,
  resolveFeeAccount,
  treasuryShareAt,
} from './mapPolyxLedger';

/**
 * Transaction fees before v5.4.0 (spec 5004000), which the chain charged without announcing them.
 *
 * `transactionPayment.TransactionFeePaid` first appears at v5.4.0. Before it, every transaction
 * fee was taken with no event of its own: on testnet, every one in the first 8.48 million blocks.
 * This module reconstructs each one: how much was taken (computed as the runtime did, and checked
 * against the treasury's cut), who paid it (`feePayer.ts`),
 * and what reached the block author. From v5.4.0 the fee events say all of that, and the ledger's
 * own fee handlers take over.
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
    weight: { refTime?: unknown; toString(): string };
  };
  const used = BigInt(String(info.weight.refTime ?? info.weight));

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

  const treasuryShare = treasuryShareAt(block, closing.idx - 1, extrinsic.idx);
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
