import { readOrAnomaly } from '../../src/utils/anomaly';
import { __resetStakingCaches, readStakingLedger } from '../../src/utils/staking';
import {
  isDecodeFailure,
  readStorage,
  UndecodableStateError,
} from '../../src/utils/storageAtParent';
import { IndexerAnomaly } from '../../src/types';
import { handleStakersElected } from '../../src/mappings/entities/events/mapEra';
import { handleChilled, handleNominated } from '../../src/mappings/entities/events/mapNomination';
import { handleValidatorPrefsSet } from '../../src/mappings/entities/events/mapValidator';
import { resolveLegacyRewardDestination } from '../../src/utils/staking';
import { mockLedgerAccountQuery, mockStore, namedEvent } from './helpers';

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

/**
 * A value that can't be decoded fails identically on every retry, so no handler may let it halt
 * the block: each records it against the event that read it.
 */
describe('handlers reading state that does not decode', () => {
  const undecodable = () => Promise.reject(new Error('createType(Foo):: Struct: failed on total'));
  const IDX = 7;

  const anomalies = (db: Record<string, Record<string, any>>) =>
    Object.values(db['IndexerAnomaly'] ?? {});

  /** `bonded` can't be decoded; everything else on chain reads as absent. */
  const withUndecodableBonded = () => {
    (globalThis as any).api.query = {
      ...mockLedgerAccountQuery(),
      staking: {
        bonded: jest.fn().mockImplementation(undecodable),
        activeEra: jest.fn().mockResolvedValue({ toJSON: () => ({ index: 5 }) }),
      },
    };
  };

  const eventOf = (method: string, fields: Record<string, unknown>) =>
    namedEvent({ section: 'staking', method, fields, idx: IDX });

  beforeEach(() => {
    __resetStakingCaches();
  });

  it('Nominated: records an undecodable controller against the event, and carries on', async () => {
    const db = mockStore();
    withUndecodableBonded();

    await handleNominated(eventOf('Nominated', { stash: STASH, targets: [] }));

    expect(db['StakingPosition'][STASH].controllerId).toBe(STASH);
    expect(anomalies(db)).toHaveLength(1);
    expect(anomalies(db)[0].id).toMatch(/^0000001000\/0000000007\//);
  });

  it('Nominated: records an undecodable activeEra, and leaves the era unrecorded', async () => {
    const db = mockStore();
    (globalThis as any).api.query = {
      ...mockLedgerAccountQuery(),
      staking: {
        bonded: jest.fn().mockResolvedValue({ toJSON: () => null }),
        activeEra: jest.fn().mockImplementation(undecodable),
      },
    };
    const OTHER = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

    await handleNominated(eventOf('Nominated', { stash: STASH, targets: [OTHER] }));

    expect(anomalies(db)).toHaveLength(1);
    expect(anomalies(db)[0].id).toMatch(/^0000001000\/0000000007\//);
    expect(Object.values(db['Nomination'])[0].eraIndex).toBeUndefined();
  });

  it('Chilled: records an undecodable controller against the event, and carries on', async () => {
    const db = mockStore();
    withUndecodableBonded();

    await handleChilled(eventOf('Chilled', { stash: STASH }));

    expect(db['StakingPosition'][STASH].isChilled).toBe(true);
    expect(anomalies(db)).toHaveLength(1);
    expect(anomalies(db)[0].id).toMatch(/^0000001000\/0000000007\//);
  });

  it('ValidatorPrefsSet: records an undecodable controller against the event, and carries on', async () => {
    const db = mockStore();
    withUndecodableBonded();
    (globalThis as any).api.query.identity.keyRecords = jest
      .fn()
      .mockResolvedValue({ isEmpty: true });

    await handleValidatorPrefsSet(
      eventOf('ValidatorPrefsSet', { stash: STASH, prefs: { commission: 1, blocked: false } })
    );

    expect(db['StakingPosition'][STASH].isValidator).toBe(true);
    expect(anomalies(db)).toHaveLength(1);
    expect(anomalies(db)[0].id).toMatch(/^0000001000\/0000000007\//);
  });

  it('StakersElected: records one anomaly for a currentEra that does not decode', async () => {
    const db = mockStore();
    (globalThis as any).api.query = {
      staking: { currentEra: jest.fn().mockImplementation(undecodable) },
    };

    await handleStakersElected(eventOf('StakersElected', {}));

    expect(anomalies(db)).toHaveLength(1);
    expect(anomalies(db)[0].detail).not.toContain('is not set');
  });

  it('StakersElected: records one anomaly for a currentEra that is not set', async () => {
    const db = mockStore();
    (globalThis as any).api.query = {
      staking: { currentEra: jest.fn().mockResolvedValue({ toJSON: () => null }) },
    };

    await handleStakersElected(eventOf('StakersElected', {}));

    expect(anomalies(db)).toHaveLength(1);
    expect(anomalies(db)[0].detail).toContain('is not set');
  });

  it('files a reward destination that does not decode under the reward event', async () => {
    const db = mockStore();
    (globalThis as any).api.query = {
      staking: { payee: jest.fn().mockImplementation(undecodable) },
    };

    const result = await resolveLegacyRewardDestination(STASH, '0000001000', blockAt(1000), IDX);

    expect(result).toEqual({ rewardDestination: 'LegacyUnknown' });
    expect(anomalies(db)[0].id).toMatch(/^0000001000\/0000000007\//);
  });
});
