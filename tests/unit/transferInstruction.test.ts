import { SubstrateBlock } from '@subql/types';
import { transferInstruction } from '../../src/mappings/entities/assets/mapAsset';
import { processInstructionId } from '../../src/mappings/entities/settlements/mapSettlement';

/** One event record, in the phase named (`Initialization`, or an extrinsic index). */
const record = (phase: string, section: string, method: string, data: unknown[] = []) => ({
  phase: { toString: () => phase },
  event: { section, method, data: data.map(value => ({ toString: () => String(value) })) },
});
const INIT = 'Initialization';
const EXT = '{"applyExtrinsic":1}';
const transfer = (phase = INIT) => record(phase, 'asset', 'Transfer');
const executed = (instruction: number, phase = INIT) =>
  record(phase, 'settlement', 'InstructionExecuted', ['0xsettlement', instruction]);

const blockOf = (...records: ReturnType<typeof record>[]) =>
  ({ events: records } as unknown as SubstrateBlock);

const instruction = (id: number) => processInstructionId({ toString: () => String(id) } as never);

describe('transferInstruction', () => {
  it("files each scheduled execution's transfers under their own instruction", () => {
    // testnet block 5,091,763: 27 instructions executed as the block initialised
    const block = blockOf(transfer(), transfer(), executed(41), transfer(), executed(42));

    expect(transferInstruction(block, 0)).toEqual({ instructionId: instruction(41) });
    expect(transferInstruction(block, 1)).toEqual({ instructionId: instruction(41) });
    expect(transferInstruction(block, 3)).toEqual({ instructionId: instruction(42) });
  });

  it('reaches past a checkpoint a leg advanced', () => {
    const block = blockOf(
      transfer(),
      record(INIT, 'checkpoint', 'CheckpointCreated'),
      transfer(),
      executed(7)
    );

    expect(transferInstruction(block, 0)).toEqual({ instructionId: instruction(7) });
  });

  it('gives a controller transfer no instruction, as expected', () => {
    // batched ahead of an affirmation that executes an instruction in the same extrinsic
    const block = blockOf(
      transfer(EXT),
      record(EXT, 'asset', 'ControllerTransfer'),
      transfer(EXT),
      executed(9, EXT)
    );

    expect(transferInstruction(block, 0)).toEqual({});
    expect(transferInstruction(block, 2)).toEqual({ instructionId: instruction(9) });
  });

  it('gives a distribution claim no instruction, as expected', () => {
    const block = blockOf(transfer(EXT), record(EXT, 'capitalDistribution', 'BenefitClaimed'));

    expect(transferInstruction(block, 0)).toEqual({});
  });

  it('says what it found when the transfer fits none of them', () => {
    const block = blockOf(
      transfer(EXT),
      record(EXT, 'settlement', 'InstructionAffirmed'),
      executed(3, EXT)
    );

    expect(transferInstruction(block, 0)).toEqual({
      unexplained: 'settlement.InstructionAffirmed',
    });
  });

  it('does not look past its own phase, and says so', () => {
    const block = blockOf(transfer(EXT), executed(3, '{"applyExtrinsic":2}'));

    expect(transferInstruction(block, 0)).toEqual({ unexplained: 'the end of its phase' });
  });
});
