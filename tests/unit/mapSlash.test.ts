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

  it("places a nominator's share matching two validators' slashes under the one slashed just before", () => {
    const OTHER = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';
    const sameEra = [
      deferred(2159, BigInt(1000), [[NOMINATOR, BigInt(40)]]),
      { ...deferred(2159, BigInt(900), [[NOMINATOR, BigInt(40)]]), validator: OTHER },
    ];

    // `OTHER` was slashed after `VALIDATOR`, so it is the slash being applied
    expect(
      appliedDeferredSlash(sameEra, NOMINATOR, BigInt(40), [OTHER, VALIDATOR])?.slash.validator
    ).toBe(OTHER);
    expect(
      appliedDeferredSlash(sameEra, NOMINATOR, BigInt(40), [VALIDATOR, OTHER])?.slash.validator
    ).toBe(VALIDATOR);
  });

  describe('a validator whose own share was nothing, so it announced no slash', () => {
    const OTHER = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';

    it("places its nominator's slash by the nominator alone", () => {
      const noOwn = [
        deferred(2159, BigInt(0), [[NOMINATOR, BigInt(40)]]),
        { ...deferred(2159, BigInt(900), []), validator: OTHER },
      ];

      // nothing was slashed before it, or only a validator that does not nominate it
      expect(appliedDeferredSlash(noOwn, NOMINATOR, BigInt(40))).toEqual({
        slash: noOwn[0],
        asValidator: false,
      });
      expect(appliedDeferredSlash(noOwn, NOMINATOR, BigInt(40), [OTHER])?.slash).toBe(noOwn[0]);
    });

    it('prefers the exact share when several slashes name the nominator', () => {
      const several = [
        deferred(2159, BigInt(0), [[NOMINATOR, BigInt(40)]]),
        { ...deferred(2159, BigInt(0), [[NOMINATOR, BigInt(25)]]), validator: OTHER },
      ];

      expect(appliedDeferredSlash(several, NOMINATOR, BigInt(25))?.slash).toBe(several[1]);
    });

    it('leaves the nominator unplaced when it cannot tell which of several it came from', () => {
      const several = [
        deferred(2159, BigInt(0), [[NOMINATOR, BigInt(40)]]),
        { ...deferred(2159, BigInt(0), [[NOMINATOR, BigInt(40)]]), validator: OTHER },
      ];

      expect(appliedDeferredSlash(several, NOMINATOR, BigInt(40))).toBeUndefined();
    });
  });

  it('places nothing whose amount matches no slash', () => {
    expect(appliedDeferredSlash(waiting, NOMINATOR, BigInt(41))).toBeUndefined();
    expect(appliedDeferredSlash(waiting, VALIDATOR, BigInt(1001))).toBeUndefined();
  });

  it("places a validator's slash capped at what its ledger held", () => {
    expect(appliedDeferredSlash(waiting, VALIDATOR, BigInt(700))).toEqual({
      slash: waiting[1],
      asValidator: true,
    });
  });

  it("places a nominator's share capped at what its ledger held", () => {
    expect(appliedDeferredSlash(waiting, NOMINATOR, BigInt(25))).toEqual({
      slash: waiting[1],
      asValidator: false,
    });
  });

  it('prefers an exact match to a capped one within the era being applied, and ignores newer eras', () => {
    const mixed = [deferred(2159, BigInt(1000)), deferred(2160, BigInt(700))];

    // 2159 is the era applied: its figure caps the slash, and 2160's exact figure is not this slash
    expect(appliedDeferredSlash(mixed, VALIDATOR, BigInt(700))?.slash).toBe(mixed[0]);
    expect(appliedDeferredSlash(mixed, VALIDATOR, BigInt(600))?.slash).toBe(mixed[0]);

    const OTHER = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';
    const sameEra = [
      deferred(2159, BigInt(1000), [[NOMINATOR, BigInt(40)]]),
      { ...deferred(2159, BigInt(900), [[NOMINATOR, BigInt(25)]]), validator: OTHER },
    ];

    expect(appliedDeferredSlash(sameEra, NOMINATOR, BigInt(25))?.slash).toBe(sameEra[1]);
    // capped, and fitting two slashes with no validator slashed before it to tell them apart
    expect(appliedDeferredSlash(sameEra, NOMINATOR, BigInt(20))).toBeUndefined();

    const shares = [
      deferred(2159, BigInt(1000), [[NOMINATOR, BigInt(40)]]),
      deferred(2160, BigInt(1000), [[NOMINATOR, BigInt(25)]]),
    ];

    expect(appliedDeferredSlash(shares, NOMINATOR, BigInt(25))?.slash).toBe(shares[0]);
  });

  it("does not place a nominator's slash under its own future-era slash as a validator", () => {
    const OTHER = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';
    // NOMINATOR is a validator too, with a slash held for a later era; the one applied is OTHER's
    const waitingBoth = [
      { ...deferred(2160, BigInt(1000)), validator: NOMINATOR },
      { ...deferred(2159, BigInt(1000), [[NOMINATOR, BigInt(40)]]), validator: OTHER },
    ];

    expect(appliedDeferredSlash(waitingBoth, NOMINATOR, BigInt(40))).toEqual({
      slash: waitingBoth[1],
      asValidator: false,
    });
    // nothing of the era applied fits this stash: the future era's figure is no match
    expect(appliedDeferredSlash(waitingBoth, NOMINATOR, BigInt(41))).toBeUndefined();
  });
});

describe('handleSlash', () => {
  /** The active era at the slash's block, and the runtime's `SlashDeferDuration` (14 on testnet). */
  const chainEras = (activeEra: number) => {
    (globalThis as any).api.query = {
      staking: {
        activeEra: jest.fn().mockResolvedValue({ toJSON: () => ({ index: activeEra }) }),
      },
    };
    (globalThis as any).api.consts = {
      staking: { slashDeferDuration: { toNumber: () => 14 } },
    };
  };

  beforeEach(() => {
    jest.mocked(deferredSlashesBefore).mockReset();
    jest
      .mocked(ledgerAccount)
      .mockImplementation(address => Promise.resolve({ id: address } as never));
  });

  it("records a v8 nominator's slash with its validator, applied era and offence era", async () => {
    const db = mockStore();
    // testnet block 25,176,378: held under 7029, the era it is applied in, for an offence in 7014
    jest
      .mocked(deferredSlashesBefore)
      .mockResolvedValue([deferred(7029, BigInt(1000), [[NOMINATOR, BigInt(40)]])]);
    chainEras(7029);

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
        eraIndex: 7029,
        offenceEraIndex: 7014,
        amount: BigInt(40),
      }),
    ]);
  });

  it("records a pre-v7 validator's own slash with its applied era and no offence era", async () => {
    const db = mockStore();
    // testnet block 7,751,343: before v7.0 the slash is held under 2159, the era it was reported
    // in, and applied once the active era passes it by more than 14
    jest.mocked(deferredSlashesBefore).mockResolvedValue([deferred(2159, BigInt(1000))]);
    chainEras(2174);

    await handleSlash(
      tupleEvent({
        section: 'staking',
        method: 'Slash',
        data: [VALIDATOR, '1000'],
        specVersion: 5003001,
      })
    );

    expect(Object.values(db.Slash)).toEqual([
      expect.objectContaining({
        accountId: VALIDATOR,
        validatorId: VALIDATOR,
        eraIndex: 2174,
        offenceEraIndex: undefined,
      }),
    ]);
  });

  it('keeps the slash and reports it when the deferred slashes cannot be read', async () => {
    const db = mockStore();
    jest.mocked(deferredSlashesBefore).mockResolvedValue(undefined);
    chainEras(7029);
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
        eraIndex: 7029,
        offenceEraIndex: undefined,
      }),
    ]);
    expect(anomaly).toHaveBeenCalledTimes(1);
  });

  it("records a v8 validator's slash capped below its deferred figure, with no anomaly", async () => {
    const db = mockStore();
    jest.mocked(deferredSlashesBefore).mockResolvedValue([deferred(7029, BigInt(1000))]);
    chainEras(7029);
    const anomaly = jest.spyOn(IndexerAnomaly.prototype, 'save').mockResolvedValue(undefined);

    await handleSlash(
      namedEvent({
        section: 'staking',
        method: 'Slashed',
        fields: { staker: VALIDATOR, amount: '600' },
      })
    );

    expect(Object.values(db.Slash)).toEqual([
      expect.objectContaining({
        accountId: VALIDATOR,
        validatorId: VALIDATOR,
        offenceEraIndex: 7014,
        amount: BigInt(600),
      }),
    ]);
    expect(anomaly).not.toHaveBeenCalled();
  });

  it("records a v8 nominator's slash capped below its deferred share, with no anomaly", async () => {
    const db = mockStore();
    jest
      .mocked(deferredSlashesBefore)
      .mockResolvedValue([deferred(7029, BigInt(1000), [[NOMINATOR, BigInt(40)]])]);
    chainEras(7029);
    const anomaly = jest.spyOn(IndexerAnomaly.prototype, 'save').mockResolvedValue(undefined);
    anomaly.mockClear();

    await handleSlash(
      namedEvent({
        section: 'staking',
        method: 'Slashed',
        fields: { staker: NOMINATOR, amount: '25' },
      })
    );

    expect(Object.values(db.Slash)).toEqual([
      expect.objectContaining({
        accountId: NOMINATOR,
        validatorId: VALIDATOR,
        offenceEraIndex: 7014,
        amount: BigInt(25),
      }),
    ]);
    expect(anomaly).not.toHaveBeenCalled();
  });
});
