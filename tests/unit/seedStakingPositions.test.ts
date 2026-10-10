/**
 * Stashes bonded in a chain's genesis config emit no `Bonded`, so without a seed a stash that never
 * bonds or unbonds again has no `StakingPosition` at all.
 */
import { seedStakingPositions } from '../../src/seed/stakingPosition';
import { __resetStakingCaches } from '../../src/utils/staking';
import { mockLedgerAccountQuery, mockStore } from './helpers';

const STASH = '5EFbtStash';
const CONTROLLER = '5C7kNController';

/** `[storageKey, Option<StakingLedger>]` as `api.query.staking.ledger.entries()` yields them */
const ledgerEntry = (
  controller: string,
  ledger: {
    stash: string;
    total: string;
    active: string;
    unlocking?: { value: string; era: number }[];
  }
) => [{ args: [{ toString: () => controller }] }, { toJSON: () => ({ unlocking: [], ...ledger }) }];

beforeEach(() => {
  __resetStakingCaches();
});

describe('seedStakingPositions', () => {
  it('creates a position for every ledger, keyed by its stash, with its controller', async () => {
    const db = mockStore();
    (globalThis as any).api.query = {
      ...mockLedgerAccountQuery(),
      staking: {
        bonded: jest.fn().mockResolvedValue({ toJSON: () => CONTROLLER }),
        ledger: {
          entries: jest.fn().mockResolvedValue([
            ledgerEntry(CONTROLLER, {
              stash: STASH,
              total: '5000',
              active: '4000',
              unlocking: [{ value: '1000', era: 3 }],
            }),
          ]),
        },
      },
    };

    const { seeded } = await seedStakingPositions({
      blockId: '0000000000',
      datetime: new Date('2020-01-01T00:00:00Z'),
    });

    expect(seeded).toBe(1);
    expect(db.StakingPosition[STASH]).toMatchObject({
      stashId: STASH,
      controllerId: CONTROLLER,
      bonded: BigInt(4000),
      unbonding: BigInt(1000),
      unlocking: [{ amount: '1000', era: 3 }],
      createdEventId: '0000000000/0000000000',
    });
  });

  it('seeds nothing on a chain with no ledgers', async () => {
    const db = mockStore();
    (globalThis as any).api.query = {
      ...mockLedgerAccountQuery(),
      staking: { ledger: { entries: jest.fn().mockResolvedValue([]) } },
    };

    const { seeded } = await seedStakingPositions({ blockId: '0000000000', datetime: new Date() });

    expect(seeded).toBe(0);
    expect(db.StakingPosition).toBeUndefined();
  });
});
