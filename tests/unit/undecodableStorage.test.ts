import { readOrAnomaly } from '../../src/utils/anomaly';
import { __resetStakingCaches, readStakingLedger } from '../../src/utils/staking';
import {
  isDecodeFailure,
  readStorage,
  UndecodableStateError,
} from '../../src/utils/storageAtParent';
import { IndexerAnomaly } from '../../src/types';
import { namedEvent } from './helpers';

const blockAt = (blockNumber: number) =>
  namedEvent({
    section: 'staking',
    method: 'Bonded',
    fields: { stash: STASH, amount: '1' },
    blockNumber: String(blockNumber),
  }).block;

const STASH = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

describe('isDecodeFailure', () => {
  it.each([
    'createType(Vec<FrameSupportTokensMiscIdAmount>):: Struct: failed on id: u8:: Unable to create Enum via index 9, in A, B',
    'Unable to decode storage balances.holds:0: createType(Vec<X>):: oops',
    'decodeU8a: failed at 0x0102… on id: Raw:: Source is too short',
    'Struct: failed on total: Compact<u128>:: Expected input with 16 bytes (128 bits), found 3 bytes',
    'createType(Foo):: DoNotConstruct: Cannot construct unknown type Foo',
  ])('classifies %p as a value that does not decode', message => {
    expect(isDecodeFailure(new Error(message))).toBe(true);
  });

  it.each([
    '1006: Abnormal Closure',
    '-32000: Client error: UnknownBlock: State already discarded',
    '-32603: Internal error',
    'WebSocket is not connected',
    'No response received from RPC endpoint in 60s',
    'ETIMEDOUT',
  ])('does not classify the provider error %p', message => {
    expect(isDecodeFailure(new Error(message))).toBe(false);
  });

  it('does not classify a non-error', () => {
    expect(isDecodeFailure('createType(X)::')).toBe(false);
  });
});

describe('readStorage', () => {
  it('turns a decode failure into an UndecodableStateError naming the item', async () => {
    const read = readStorage('balances.holds of X', () =>
      Promise.reject(new Error('createType(Vec<X>):: bad'))
    );

    await expect(read).rejects.toBeInstanceOf(UndecodableStateError);
    await expect(read).rejects.toThrow('could not decode balances.holds of X');
  });

  it('lets a provider error through unchanged', async () => {
    const error = new Error('1006: Abnormal Closure');

    await expect(readStorage('x', () => Promise.reject(error))).rejects.toBe(error);
  });
});

describe('readOrAnomaly', () => {
  beforeEach(() => {
    __resetStakingCaches();
    (globalThis as any).api.query = {
      staking: {
        bonded: jest.fn().mockResolvedValue({ toJSON: () => null }),
        ledger: jest.fn(),
      },
    };
  });

  it('records an anomaly and returns the fallback for an undecodable ledger', async () => {
    (globalThis as any).api.query.staking.ledger.mockRejectedValue(
      new Error('createType(StakingLedger):: Struct: failed on total')
    );
    const anomaly = jest.spyOn(IndexerAnomaly.prototype, 'save').mockResolvedValue(undefined);

    const result = await readOrAnomaly(
      { block: blockAt(100) },
      'the ledger was left as it was',
      () => readStakingLedger(STASH, '0000000100'),
      'unchanged' as never
    );

    expect(result).toBe('unchanged');
    expect(anomaly).toHaveBeenCalledTimes(1);
    anomaly.mockRestore();
  });

  it('lets an RPC error fail the block', async () => {
    (globalThis as any).api.query.staking.ledger.mockRejectedValue(new Error('-32000: busy'));

    await expect(
      readOrAnomaly({ block: blockAt(100) }, 'x', () => readStakingLedger(STASH, '0000000100'))
    ).rejects.toThrow('-32000: busy');
  });
});
