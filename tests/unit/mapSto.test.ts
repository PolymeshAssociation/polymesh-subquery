import '@subql/types-core/dist/global';
import '@subql/types/dist/global';
import { handleFundraiserOffchainFundingEnabled } from '../../src/mappings/entities/stos/mapSto';
import { StoStatus } from '../../src/types';
import { MockDb, mockStore, namedEvent } from './helpers';

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
