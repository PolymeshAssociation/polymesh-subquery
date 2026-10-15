import '@subql/types-core/dist/global';
import '@subql/types/dist/global';
import {
  handleFundraiserOffchainFundingEnabled,
  handleInvested,
} from '../../src/mappings/entities/stos/mapSto';
import { StoStatus } from '../../src/types';
import { codec, MockDb, mockStore, namedEvent, tupleEvent } from './helpers';

const AGENT = '0x0100000000000000000000000000000000000000000000000000000000000000';
const OFFERING_ASSET = '0x1234567890abcdef1234567890abcdef';
const STO_ID = `${OFFERING_ASSET}/4`;

/** A `Ticker` as the chain's `[u8; 12]` presents it: hex, zero-padded to twelve bytes. */
const padded = (text: string): string =>
  `0x${Buffer.from(text.padEnd(12, '\0'), 'utf8').toString('hex')}`;

/**
 * v8 declares `FundraiserOffchainFundingEnabled { agent_did, offering_asset, fundraiser_id, ticker }`.
 */
const enabled = (ticker: string, fundraiserId = 4) =>
  namedEvent({
    section: 'sto',
    method: 'FundraiserOffchainFundingEnabled',
    fields: {
      agentDid: AGENT,
      offeringAsset: OFFERING_ASSET,
      fundraiserId: fundraiserId,
      ticker: ticker,
    },
    idx: 6,
  });

describe('handleFundraiserOffchainFundingEnabled', () => {
  let db: MockDb;

  beforeEach(() => {
    db = mockStore({
      Sto: {
        [STO_ID]: {
          id: STO_ID,
          stoId: 4,
          status: StoStatus.Live,
          offChainFundingEnabled: false,
          createdEventId: 'created',
          updatedEventId: 'created',
        },
        [`${OFFERING_ASSET}/5`]: {
          id: `${OFFERING_ASSET}/5`,
          stoId: 5,
          offChainFundingEnabled: false,
          updatedEventId: 'created',
        },
      },
    });
  });

  it('flags the fundraiser and records the ticker it accepts off chain', async () => {
    await handleFundraiserOffchainFundingEnabled(enabled(padded('USD')));

    expect(db.Sto[STO_ID]).toMatchObject({
      status: StoStatus.Live,
      offChainFundingEnabled: true,
      offChainFundingToken: 'USD',
      createdEventId: 'created',
      updatedEventId: '0000001000/0000000006',
    });
  });

  it('leaves the other fundraisers of the asset alone', async () => {
    await handleFundraiserOffchainFundingEnabled(enabled(padded('USD')));

    expect(db.Sto[`${OFFERING_ASSET}/5`]).toMatchObject({
      offChainFundingEnabled: false,
      updatedEventId: 'created',
    });
  });

  it('writes nothing for a fundraiser the index does not hold', async () => {
    await handleFundraiserOffchainFundingEnabled(enabled(padded('USD'), 9));

    expect(Object.keys(db.Sto).sort()).toEqual([STO_ID, `${OFFERING_ASSET}/5`].sort());
    expect(db.Sto[STO_ID].offChainFundingEnabled).toBe(false);
  });
});

const OFFERING = '0x0000000000000000000000000000aaaa';
const RAISING = '0x0000000000000000000000000000bbbb';
const DID = '0x0a'.padEnd(66, '0');

const invested = (raisingAsset: unknown) =>
  tupleEvent({
    section: 'sto',
    method: 'Invested',
    specVersion: 7_003_000,
    data: [codec(DID), codec(OFFERING), codec(4), codec(raisingAsset), codec('100'), codec('50')],
  });

describe('handleInvested', () => {
  it('links the investment to its offering and leaves an off-chain raising asset null', async () => {
    const db = mockStore({ Asset: { [OFFERING]: { id: OFFERING, ticker: 'OFFER' } } });

    await handleInvested(invested({ offChain: '0x5449434b4552' }));

    expect(Object.values(db.Investment)[0]).toMatchObject({
      stoId: `${OFFERING}/4`,
      offeringAssetId: OFFERING,
      raisingAssetId: undefined,
      raiseToken: 'TICKER',
    });
  });

  it('links an on-chain raising asset', async () => {
    const db = mockStore({
      Asset: {
        [OFFERING]: { id: OFFERING, ticker: 'OFFER' },
        [RAISING]: { id: RAISING, ticker: 'RAISE' },
      },
    });

    await handleInvested(invested({ onChain: RAISING }));

    expect(Object.values(db.Investment)[0]).toMatchObject({
      stoId: `${OFFERING}/4`,
      raisingAssetId: RAISING,
      raiseToken: 'RAISE',
    });
  });
});
