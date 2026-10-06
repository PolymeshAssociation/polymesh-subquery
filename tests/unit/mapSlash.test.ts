/**
 * A slash names only the stash and the amount; the validator and era come from the deferred slash
 * it was applied from, read at the parent block (`deferredSlashesBefore`, mocked here).
 */
jest.mock('../../src/utils/deferredSlashes', () => ({
  ...jest.requireActual('../../src/utils/deferredSlashes'),
  deferredSlashesBefore: jest.fn(),
}));
jest.mock('../../src/utils/accounts', () => ({
  ...jest.requireActual('../../src/utils/accounts'),
  ledgerAccount: jest.fn(),
}));

import { handleSlash } from '../../src/mappings/entities/events/mapSlash';
import { ledgerAccount } from '../../src/utils/accounts';
import { IndexerAnomaly } from '../../src/types';
import {
  appliedDeferredSlash,
  DeferredSlash,
  deferredSlashesBefore,
} from '../../src/utils/deferredSlashes';
import { mockStore, namedEvent, tupleEvent } from './helpers';

const VALIDATOR = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const NOMINATOR = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

const deferred = (era: number, own: bigint, others: [string, bigint][] = []): DeferredSlash => ({
  era,
  validator: VALIDATOR,
  own,
  others,
  reporters: [],
  payout: BigInt(0),
});

describe('appliedDeferredSlash', () => {
  const waiting = [
    deferred(2160, BigInt(1000), [[NOMINATOR, BigInt(40)]]),
    deferred(2159, BigInt(1000), [[NOMINATOR, BigInt(40)]]),
  ];

  it("places a validator's own slash, oldest era first", () => {
    expect(appliedDeferredSlash(waiting, VALIDATOR, BigInt(1000))).toEqual({
      slash: waiting[1],
      asValidator: true,
    });
  });

  it("places a nominator's share under the validator it nominated", () => {
    expect(appliedDeferredSlash(waiting, NOMINATOR, BigInt(40))).toEqual({
      slash: waiting[1],
      asValidator: false,
    });
  });

  it('places nothing whose amount matches no slash', () => {
    expect(appliedDeferredSlash(waiting, NOMINATOR, BigInt(41))).toBeUndefined();
  });
});

describe('handleSlash', () => {
  beforeEach(() => {
    jest.mocked(deferredSlashesBefore).mockReset();
    jest
      .mocked(ledgerAccount)
      .mockImplementation(address => Promise.resolve({ id: address } as never));
  });

  it("records a v8 nominator's slash against its validator and the era it was applied in", async () => {
    const db = mockStore();
    jest
      .mocked(deferredSlashesBefore)
      .mockResolvedValue([deferred(2159, BigInt(1000), [[NOMINATOR, BigInt(40)]])]);

    await handleSlash(
      namedEvent({
        section: 'staking',
        method: 'Slashed',
        fields: { staker: NOMINATOR, amount: '40' },
      })
    );

    expect(Object.values(db.Slash)).toEqual([
      expect.objectContaining({
        accountId: NOMINATOR,
        validatorId: VALIDATOR,
        eraIndex: 2159,
        amount: BigInt(40),
      }),
    ]);
  });

  it("records a pre-v8 validator's own slash", async () => {
    const db = mockStore();
    jest.mocked(deferredSlashesBefore).mockResolvedValue([deferred(2159, BigInt(1000))]);

    await handleSlash(
      tupleEvent({
        section: 'staking',
        method: 'Slash',
        data: [VALIDATOR, '1000'],
        specVersion: 5003001,
      })
    );

    expect(Object.values(db.Slash)).toEqual([
      expect.objectContaining({ accountId: VALIDATOR, validatorId: VALIDATOR, eraIndex: 2159 }),
    ]);
  });

  it('keeps the slash and reports it when the deferred slashes cannot be read', async () => {
    const db = mockStore();
    jest.mocked(deferredSlashesBefore).mockResolvedValue(undefined);
    const anomaly = jest.spyOn(IndexerAnomaly.prototype, 'save').mockResolvedValue(undefined);

    await handleSlash(
      namedEvent({
        section: 'staking',
        method: 'Slashed',
        fields: { staker: NOMINATOR, amount: '40' },
      })
    );

    expect(Object.values(db.Slash)).toEqual([
      expect.objectContaining({
        accountId: NOMINATOR,
        validatorId: undefined,
        eraIndex: undefined,
      }),
    ]);
    expect(anomaly).toHaveBeenCalledTimes(1);
  });
});
