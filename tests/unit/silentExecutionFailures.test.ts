import {
  handleInstructionRescheduled,
  handleManualExecutionAttempt,
  handleScheduledExecutionResult,
} from '../../src/mappings/entities/settlements/silentExecutionFailures';
import { TypeRegistry } from '@polkadot/types';
import { __resetBlockContext } from '../../src/mappings/blockContext';
import { __resetInitialSpec } from '../../src/mappings/trueSpec';
import { codec, MockDb, mockStore, namedEvent, tupleEvent } from './helpers';

/**
 * Runtimes before 6.0 could set an instruction `Failed` with no settlement event: a scheduled
 * execution that failed before 5.2 (testnet 2781 at 5,107,100), and a failed
 * `execute_manual_instruction` whose status write was kept from 5.2 (testnet 4669 at 8,078,541).
 */
const SETTLEMENT_EXEC = '0x534554544c454d454e545f494e535452554354494f4e5f45584543';
const taskOf = (instruction: number) =>
  `${SETTLEMENT_EXEC}${Buffer.from(new BigUint64Array([BigInt(instruction)]).buffer).toString(
    'hex'
  )}`;
const INSTRUCTION_FAILED = { module: { index: 37, error: '0x0c000000' } };
const FAILURE = {
  errorType: 'settlement.InstructionFailed',
  details: 'Instruction failed to execute.',
};

const instruction = (id: string, status = 'Created') => ({
  id,
  status,
  legCount: 1,
  mediators: [],
});

beforeEach(() => {
  (globalThis as any).api.registry = {
    chainSS58: 42,
    findMetaError: () => ({
      section: 'settlement',
      name: 'InstructionFailed',
      docs: ['Instruction failed to execute.'],
    }),
  };
});

describe('a scheduled execution that failed before 5.2', () => {
  const dispatched = (id: string, result: unknown, specVersion = 5_000_003) =>
    namedEvent({
      section: 'scheduler',
      method: 'Dispatched',
      fields: { task: ['5107100', '0'], id, result },
      specVersion,
      blockNumber: '5107100',
      idx: 0,
    });
  let db: MockDb;

  beforeEach(() => {
    db = mockStore({ Instruction: { '0000002781': instruction('0000002781') } });
  });

  it('fails the instruction its task names, as the chain did', async () => {
    expect(taskOf(2781)).toBe(
      '0x534554544c454d454e545f494e535452554354494f4e5f45584543dd0a000000000000'
    );

    await handleScheduledExecutionResult(dispatched(taskOf(2781), { err: INSTRUCTION_FAILED }));

    expect(db.Instruction['0000002781']).toMatchObject({
      status: 'Failed',
      failureReason: FAILURE,
      updatedEventId: '0005107100/0000000000',
    });
    expect(db.InstructionEvent['0005107100/0000000000']).toMatchObject({
      instructionId: '0000002781',
      event: 'FailedToExecuteInstruction',
      failureReason: FAILURE,
      createdEventId: '0005107100/0000000000',
    });
  });

  it.each([
    ['a successful execution', taskOf(2781), { ok: null }, 5_000_003],
    [
      'another kind of task',
      '0x50495053457865637574696f6e',
      { err: INSTRUCTION_FAILED },
      5_000_003,
    ],
    [
      '5.2, which emits FailedToExecuteInstruction',
      taskOf(2781),
      { err: INSTRUCTION_FAILED },
      5_002_001,
    ],
  ])('leaves the instruction alone for %s', async (_case, id, result, specVersion) => {
    await handleScheduledExecutionResult(dispatched(id, result, specVersion));

    expect(db.Instruction['0000002781'].status).toBe('Created');
    expect(db.InstructionEvent).toBeUndefined();
  });

  it('records an anomaly for an instruction the index does not hold', async () => {
    db.Instruction = {};

    await handleScheduledExecutionResult(dispatched(taskOf(2781), { err: INSTRUCTION_FAILED }));

    expect(Object.values(db.IndexerAnomaly ?? {})).toEqual([
      expect.objectContaining({
        kind: 'MissingReferencedEntity',
        detail: expect.stringContaining('0000002781'),
      }),
    ]);
    expect(db.InstructionEvent).toBeUndefined();
  });
});

describe('a failed manual execution before 6.0', () => {
  // real codecs, as the closing event the failure is recorded under is indexed in full
  const registry = new TypeRegistry();
  const dispatchError = (error: string) =>
    registry.createType('DispatchError', { Module: { index: 37, error } });
  const dispatchInfo = () => registry.createType('DispatchInfo');
  const SIGNER = '5DnuhGGm5PVgSWasCbUo3xknTDEeYjdEUAHEzgd93YohhjrQ';
  const record = (section: string, method: string, data: unknown[] = []) => ({
    phase: {
      isApplyExtrinsic: true,
      asApplyExtrinsic: { toNumber: () => 1 },
      toString: () => '{"applyExtrinsic":1}',
    },
    event: { section, method, data, meta: { fields: [] } },
  });
  // settlement's errors by index in 5.3: 4 InstructionNotPending, 10 UnauthorizedVenue,
  // 12 InstructionFailed, 15 LegCountTooSmall
  const ERRORS: Record<string, string> = {
    '0x04000000': 'InstructionNotPending',
    '0x0a000000': 'UnauthorizedVenue',
    '0x0c000000': 'InstructionFailed',
    '0x0f000000': 'LegCountTooSmall',
  };
  let specOf = 5_003_001;
  const failedExecution = (instruction: number, error: string, specVersion = 5_003_001) => {
    specOf = specVersion;
    const events = [record('system', 'ExtrinsicFailed', [dispatchError(error), dispatchInfo()])];
    const block = {
      block: {
        header: {
          number: { toString: () => '8078541' },
          parentHash: '0xparent',
          hash: { toHex: () => `0xhash${specVersion}${error}` },
        },
      },
      timestamp: new Date('2024-01-01T00:00:00Z'),
      specVersion,
      events,
    };
    return {
      idx: 1,
      success: false,
      block,
      events,
      extrinsic: {
        signer: { toString: () => SIGNER },
        method: {
          section: 'settlement',
          method: 'executeManualInstruction',
          args: [codec(instruction), codec(1), codec(null)],
        },
      },
    } as never;
  };
  let db: MockDb;

  beforeEach(() => {
    __resetInitialSpec();
    __resetBlockContext();
    (globalThis as any).api.rpc = {
      state: {
        getRuntimeVersion: jest.fn(async () => ({ specVersion: { toNumber: () => specOf } })),
      },
    };
    // 5.3's error table, in the registry that decoded the event
    jest.spyOn(registry, 'findMetaError').mockImplementation((({
      error,
    }: {
      error: { toNumber(): number };
    }) => ({
      section: 'settlement',
      name: ERRORS[`0x${error.toNumber().toString(16).padStart(2, '0')}000000`],
      docs: ['Instruction failed to execute.'],
    })) as never);
    db = mockStore({
      Instruction: {
        '0000004669': instruction('0000004669'),
        '0000004665': instruction('0000004665', 'Failed'),
      },
    });
  });

  it.each([
    ['failed executing', '0x0c000000'],
    ['was not pending when executed', '0x04000000'],
    ["hit a venue its asset doesn't allow", '0x0a000000'],
  ])('fails an instruction that %s, as the runtime kept that write', async (_case, error) => {
    await handleManualExecutionAttempt(failedExecution(4669, error));

    expect(db.Instruction['0000004669']).toMatchObject({
      status: 'Failed',
      updatedEventId: '0008078541/0000000000',
    });
    expect(db.InstructionEvent['0008078541/0000000000']).toMatchObject({
      instructionId: '0000004669',
      event: 'FailedToExecuteInstruction',
    });
    // the closing event the instruction event points at is indexed
    expect(db.Event['0008078541/0000000000']).toBeDefined();
  });

  it('records the error the execution failed with', async () => {
    await handleManualExecutionAttempt(failedExecution(4669, '0x0c000000'));

    expect(db.Instruction['0000004669'].failureReason).toEqual(FAILURE);
  });

  it('leaves the instruction alone when a check failed before the execution', async () => {
    await handleManualExecutionAttempt(failedExecution(4669, '0x0f000000'));

    expect(db.Instruction['0000004669'].status).toBe('Created');
    expect(db.InstructionEvent).toBeUndefined();
  });

  it('records a retry that failed again', async () => {
    await handleManualExecutionAttempt(failedExecution(4665, '0x0c000000'));

    expect(db.Instruction['0000004665']).toMatchObject({
      status: 'Failed',
      updatedEventId: '0008078541/0000000000',
    });
    expect(db.InstructionEvent['0008078541/0000000000']).toMatchObject({
      instructionId: '0000004665',
      event: 'FailedToExecuteInstruction',
    });
  });

  it('reads nothing from 6.0, which reverts a failed call', async () => {
    await handleManualExecutionAttempt(failedExecution(4669, '0x0c000000', 6_000_004));

    expect(db.Instruction['0000004669'].status).toBe('Created');
    expect(db.InstructionEvent).toBeUndefined();
  });
});

describe('a rescheduled instruction', () => {
  it('returns to pending, ready to be executed again', async () => {
    const db = mockStore({ Instruction: { '0000004624': instruction('0000004624', 'Failed') } });

    await handleInstructionRescheduled(
      tupleEvent({
        section: 'settlement',
        method: 'InstructionRescheduled',
        data: [codec('0x52d7'.padEnd(66, '0')), codec(4624)],
        specVersion: 5_003_001,
        blockNumber: '8001128',
        idx: 2,
        extrinsic: { idx: 1, extrinsic: { signer: { toString: () => '5Signer' } } },
      })
    );

    expect(db.Instruction['0000004624']).toMatchObject({
      status: 'Created',
      updatedEventId: '0008001128/0000000002',
    });
    expect(db.InstructionEvent['0008001128/0000000002']).toMatchObject({
      event: 'InstructionRescheduled',
      identityId: '0x52d7'.padEnd(66, '0'),
      signerId: '5Signer',
    });
  });
});
