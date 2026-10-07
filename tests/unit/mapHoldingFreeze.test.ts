import {
  handleFrozenBalanceSet,
  handleSetAccountFreeze,
} from '../../src/mappings/entities/assets/mapAsset';
import { meshPortfolioHolderCodec, mockStore, namedEvent } from './helpers';

const SPEC = 8_001_020;
const ASSET_ID = '0xabc123def456';
const ACCOUNT = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const PORTFOLIO_HOLDING = `${ASSET_ID}/${TEST_DID}/0`;
const ACCOUNT_HOLDING = `${ASSET_ID}/${ACCOUNT}`;

const frozenBalanceSet = (holder: unknown, frozen: number, idx = 0) =>
  namedEvent({
    section: 'asset',
    method: 'FrozenBalanceSet',
    fields: {
      caller_did: TEST_DID,
      asset_holder: holder,
      asset_id: ASSET_ID,
      frozen_balance: frozen,
    },
    specVersion: SPEC,
    idx,
  });

const setAccountFreeze = (holder: unknown, freeze: boolean, blockNumber = '1000') =>
  namedEvent({
    section: 'asset',
    method: 'SetAccountFreeze',
    fields: { caller_did: TEST_DID, holder, asset_id: ASSET_ID, freeze },
    specVersion: SPEC,
    blockNumber,
  });

const portfolioHolder = () => meshPortfolioHolderCodec(TEST_DID).toJSON();

/**
 * Freezing acts on a holder — an account or a portfolio — which is the grain a `Holding` row is keyed
 * on, so each event is an upsert onto that row. The frozen balance arrives as the chain's resulting
 * absolute value, whichever of the three freezing calls produced it.
 */
describe('handleFrozenBalanceSet', () => {
  it('assigns the absolute frozen balance to the holder, rather than adding to it', async () => {
    const db = mockStore({
      Holding: {
        [PORTFOLIO_HOLDING]: {
          id: PORTFOLIO_HOLDING,
          assetId: ASSET_ID,
          amount: BigInt(500),
          frozen: BigInt(40),
        },
      },
    });

    await handleFrozenBalanceSet(frozenBalanceSet(portfolioHolder(), 100));

    expect(db.Holding[PORTFOLIO_HOLDING].frozen).toBe(BigInt(100));
    // the balance itself is untouched — frozen is a part of it, not a movement out of it
    expect(db.Holding[PORTFOLIO_HOLDING].amount).toBe(BigInt(500));
  });

  it('clears it when the chain reports zero', async () => {
    const db = mockStore({
      Holding: {
        [PORTFOLIO_HOLDING]: {
          id: PORTFOLIO_HOLDING,
          assetId: ASSET_ID,
          amount: BigInt(500),
          frozen: BigInt(40),
        },
      },
    });

    await handleFrozenBalanceSet(frozenBalanceSet(portfolioHolder(), 0));

    expect(db.Holding[PORTFOLIO_HOLDING].frozen).toBe(BigInt(0));
  });

  it('opens a row for an account holder it has not seen yet, starting from nothing frozen', async () => {
    const db = mockStore({ Account: { [ACCOUNT]: { id: ACCOUNT, identityId: TEST_DID } } });

    await handleFrozenBalanceSet(frozenBalanceSet({ account: ACCOUNT }, 25));

    expect(db.Holding[ACCOUNT_HOLDING]).toMatchObject({
      accountId: ACCOUNT,
      amount: BigInt(0),
      frozen: BigInt(25),
    });
  });
});

describe('handleSetAccountFreeze', () => {
  it('marks the whole holder frozen from the block that froze it, and clears it on unfreeze', async () => {
    const db = mockStore({
      Holding: {
        [PORTFOLIO_HOLDING]: { id: PORTFOLIO_HOLDING, assetId: ASSET_ID, amount: BigInt(1) },
      },
    });

    await handleSetAccountFreeze(setAccountFreeze(portfolioHolder(), true));

    expect(db.Holding[PORTFOLIO_HOLDING].frozenSince).toEqual(new Date('2026-01-01T00:00:00Z'));

    await handleSetAccountFreeze(setAccountFreeze(portfolioHolder(), false));

    expect(db.Holding[PORTFOLIO_HOLDING].frozenSince).toBeUndefined();
  });

  it('keeps the original moment when an already-frozen holder is frozen again', async () => {
    const since = new Date('2025-06-01T00:00:00Z');
    const db = mockStore({
      Holding: {
        [PORTFOLIO_HOLDING]: {
          id: PORTFOLIO_HOLDING,
          assetId: ASSET_ID,
          amount: BigInt(1),
          frozenSince: since,
        },
      },
    });

    await handleSetAccountFreeze(setAccountFreeze(portfolioHolder(), true));

    expect(db.Holding[PORTFOLIO_HOLDING].frozenSince).toEqual(since);
  });
});
