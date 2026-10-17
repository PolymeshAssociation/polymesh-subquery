import { hexToU8a, u8aToHex } from '@polkadot/util';
import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import { decodeEvent } from '../../../decode';
import {
  AnomalyKind,
  ErrorJson,
  Instruction,
  InstructionEvent,
  InstructionEventEnum,
  InstructionStatusEnum,
} from '../../../types';
import {
  getErrorDetails,
  getSignerAddress,
  getTextValue,
  padNumericId,
  specVersionOf,
} from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';
import { ensureTrueSpecVersion } from '../../trueSpec';
import { indexClosingEvent } from '../block/closingEvent';
import { extractArgs } from '../common';

/**
 * Runtimes before 6.0 could set an instruction `Failed` and emit no settlement event for it:
 *
 * - Before 5.2, a scheduled execution that failed. Only the scheduler's `Dispatched` reports it,
 *   with the task named `(b"SETTLEMENT_INSTRUCTION_EXEC", instruction_id)`. From 5.2
 *   `FailedToExecuteInstruction` does, and `handleFailedToExecuteInstruction` records it.
 * - Before 6.0, a failed `execute_manual_instruction`. The runtime writes `Failed` when the
 *   execution itself fails, before returning its error, and a failed call kept its writes until
 *   6.0. The checks ahead of the execution raise other errors and write nothing.
 *
 * Each failed attempt, a retry included, is recorded as `FailedToExecuteInstruction`, as the
 * runtimes that emit it would have. A failed instruction was retried after
 * `reschedule_instruction`, which before 6.0 returned it to pending.
 *
 * Only a top-level manual execution is covered, deliberately: neither public chain has a failed one
 * inside a batch or multisig call. Were another chain to have one, check-state's check 9 would
 * report the instruction it left pending.
 */

const SCHEDULED_EXECUTION = hexToU8a(
  '0x534554544c454d454e545f494e535452554354494f4e5f45584543' // b"SETTLEMENT_INSTRUCTION_EXEC"
);

const scheduledFailuresAreSilent = (block: SubstrateBlock): boolean =>
  specVersionOf(block) < 5_002_000;

const failedCallsKeepWrites = (block: SubstrateBlock): boolean => specVersionOf(block) < 6_000_000;

/** The instruction a scheduler task's name names, when it is a settlement execution. */
const scheduledInstructionId = (rawName: Codec): string | undefined => {
  const name = getTextValue(rawName);
  const bytes = name ? hexToU8a(name) : new Uint8Array();
  const prefix = bytes.subarray(0, SCHEDULED_EXECUTION.length);

  if (
    bytes.length !== SCHEDULED_EXECUTION.length + 8 ||
    u8aToHex(prefix) !== u8aToHex(SCHEDULED_EXECUTION)
  ) {
    return undefined;
  }
  const id = new DataView(bytes.buffer, bytes.byteOffset + SCHEDULED_EXECUTION.length, 8);
  return padNumericId(id.getBigUint64(0, true).toString());
};

/** A dispatch error as `getErrorDetails` reads one, from its JSON. */
const errorDetailsOf = (dispatchError: unknown): ErrorJson =>
  getErrorDetails({ toString: () => JSON.stringify(dispatchError) } as Codec);

interface Failure {
  instruction: Instruction;
  failureReason: ErrorJson;
  /** the event that reports it, which the instruction event is created by */
  blockEventId: string;
  instructionEventId: string;
}

const recordFailure = async ({
  instruction,
  failureReason,
  blockEventId,
  instructionEventId,
}: Failure): Promise<void> => {
  instruction.status = InstructionStatusEnum.Failed;
  instruction.failureReason = failureReason;
  instruction.updatedEventId = blockEventId;

  await Promise.all([
    instruction.save(),
    InstructionEvent.create({
      id: instructionEventId,
      instructionId: instruction.id,
      event: InstructionEventEnum.FailedToExecuteInstruction,
      failureReason,
      createdEventId: blockEventId,
    }).save(),
  ]);
};

/** Maps the event `scheduler.Dispatched`, subscribed only on runtimes before 6.0. */
export const handleScheduledExecutionResult = async (event: SubstrateEvent): Promise<void> => {
  const { block, eventIdx, blockEventId } = extractArgs(event);
  if (!scheduledFailuresAreSilent(block)) {
    return;
  }

  const { id: rawName, result: rawResult } = decodeEvent(event);
  const instructionId = scheduledInstructionId(rawName);
  const result = rawResult.toJSON() as { err?: unknown };
  if (!instructionId || !result || !('err' in result)) {
    return;
  }

  const instruction = await Instruction.get(instructionId);
  if (!instruction) {
    await recordAnomaly({
      kind: AnomalyKind.MissingReferencedEntity,
      detail: `the scheduled execution of instruction ${instructionId} failed, but the index does not hold the instruction`,
      block,
      eventIdx,
    });
    return;
  }

  await recordFailure({
    instruction,
    failureReason: errorDetailsOf(result.err),
    blockEventId,
    instructionEventId: blockEventId,
  });
};

/** The errors the execution itself fails with, after which the runtime has written `Failed`. */
const EXECUTION_ERRORS = new Set([
  'settlement.InstructionFailed',
  'settlement.InstructionNotPending',
  'settlement.UnauthorizedVenue',
]);

/** Handles a failed `settlement.execute_manual_instruction`, subscribed only before 6.0. */
export const handleManualExecutionAttempt = async (
  extrinsic: SubstrateExtrinsic
): Promise<void> => {
  // a call can be the first thing the node hands over for a block, ahead of any event
  await ensureTrueSpecVersion(extrinsic.block);
  if (!failedCallsKeepWrites(extrinsic.block)) {
    return;
  }

  const failed = extrinsic.events.find(
    ({ event }) => event.section === 'system' && event.method === 'ExtrinsicFailed'
  );
  const failureReason = failed && errorDetailsOf(failed.event.data[0].toJSON());
  if (!failureReason || !EXECUTION_ERRORS.has(failureReason.errorType ?? '')) {
    return;
  }

  const instructionId = padNumericId(extrinsic.extrinsic.method.args[0].toString());
  const instruction = await Instruction.get(instructionId);
  if (!instruction) {
    return;
  }

  const closing = await indexClosingEvent(extrinsic);
  if (!closing) {
    return;
  }
  const { blockEventId } = extractArgs(closing);

  await recordFailure({
    instruction,
    failureReason,
    blockEventId,
    instructionEventId: blockEventId,
  });
};

/**
 * Maps the event `settlement.InstructionRescheduled`, which before 6.0 returned a failed instruction
 * to pending to be executed again.
 */
export const handleInstructionRescheduled = async (event: SubstrateEvent): Promise<void> => {
  const { extrinsic, blockEventId } = extractArgs(event);
  const { callerDid: rawCaller, instructionId: rawInstructionId } = decodeEvent(event);
  const instructionId = padNumericId(rawInstructionId.toString());

  const instruction = await Instruction.get(instructionId);
  if (!instruction) {
    return;
  }
  instruction.status = InstructionStatusEnum.Created;
  instruction.updatedEventId = blockEventId;

  await Promise.all([
    instruction.save(),
    InstructionEvent.create({
      id: blockEventId,
      instructionId,
      event: InstructionEventEnum.InstructionRescheduled,
      identityId: getTextValue(rawCaller),
      signerId: getSignerAddress(extrinsic),
      createdEventId: blockEventId,
    }).save(),
  ]);
};
