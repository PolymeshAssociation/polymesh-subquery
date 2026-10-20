/**
 * 7.0's migration (`identity::ticker_migrations`, `primitives::v6`, and the compliance, external
 * agents and statistics `migrate_to_v1`s) rewrote stored state with no event: tickers became asset
 * ids, and a key's extrinsic permissions became a map by pallet. Rows the index wrote before it are
 * rewritten the same way at the upgrade, into the form 7.0's own events give.
 */
import {
  assetPermissionsToV7,
  complianceToV7,
  extrinsicPermissionsToV7,
  migrateToAssetIds,
} from '../../src/mappings/migrations/assetIdMigration';
import { EXPLICIT_NULL } from '../../src/utils';
import { mockStore } from './helpers';

/** Tickers and the asset ids 7.0 gave them on testnet */
const MTICKER03 = '0x4d5449434b45523033000000';
const MTICKER03_ID = '0x006ff39477cf86a794d1be1fe233f68a';
const CSB0313 = '0x435342303331330000000000';
const CSB0313_ID = '0x00cfa7188fed818e8d33c667c3ff44e6';

const ASSET = '0x4173736574';
const ADD_DOCUMENTS = '0x6164645f646f63756d656e7473';
const FREEZE = '0x667265657a65';

describe('extrinsicPermissionsToV7', () => {
  it('turns the list of pallets into a map by pallet name, names as text', () => {
    expect(
      extrinsicPermissionsToV7({
        these: [
          { palletName: ASSET, dispatchableNames: { these: [FREEZE, ADD_DOCUMENTS] } },
          { palletName: '0x5574696c697479', dispatchableNames: { whole: null } },
        ],
      })
    ).toEqual({
      these: {
        Asset: { extrinsics: { these: ['add_documents', 'freeze'] } },
        Utility: { extrinsics: { whole: null } },
      },
    });
  });

  it('reads the snake_cased, already decoded list older metadata gave', () => {
    expect(
      extrinsicPermissionsToV7({
        except: [{ pallet_name: 'Asset', dispatchable_names: { except: ['issue'] } }],
      })
    ).toEqual({ except: { Asset: { extrinsics: { except: ['issue'] } } } });
  });

  it('leaves whole permissions, and permissions already in the 7.0 form', () => {
    expect(extrinsicPermissionsToV7({ whole: null })).toEqual({ whole: null });

    const v7 = { these: { Asset: { extrinsics: { whole: null } } } };
    expect(extrinsicPermissionsToV7(v7)).toEqual(v7);
  });

  it('turns an empty list into an empty map', () => {
    expect(extrinsicPermissionsToV7({ these: [] })).toEqual({ these: {} });
  });
});

describe('assetPermissionsToV7', () => {
  it('names each asset by the id 7.0 gave its ticker', async () => {
    expect(await assetPermissionsToV7({ these: [MTICKER03, CSB0313] })).toEqual({
      these: [MTICKER03_ID, CSB0313_ID].sort(),
    });
  });

  it('leaves whole permissions and asset ids alone', async () => {
    expect(await assetPermissionsToV7({ whole: null })).toEqual({ whole: null });
    expect(await assetPermissionsToV7({ except: [MTICKER03_ID] })).toEqual({
      except: [MTICKER03_ID],
    });
  });
});

describe('complianceToV7', () => {
  it("scopes a claim to the ticker's asset id, in the 7.0 field names", async () => {
    const v6 = JSON.stringify({
      sender_conditions: [],
      receiver_conditions: [
        {
          condition_type: { isPresent: { knowYourCustomer: { ticker: MTICKER03 } } },
          issuers: [{ issuer: '0x01', trusted_for: { any: null } }],
        },
      ],
    });

    expect(JSON.parse(await complianceToV7(v6))).toEqual({
      senderConditions: [],
      receiverConditions: [
        {
          conditionType: { isPresent: { knowYourCustomer: { asset: MTICKER03_ID } } },
          issuers: [{ issuer: '0x01', trustedFor: { any: null } }],
        },
      ],
    });
  });

  it('rewrites every scope in a condition, and leaves identity scopes', async () => {
    const v6 = JSON.stringify({
      senderConditions: [
        {
          conditionType: {
            isAnyOf: [
              { jurisdiction: ['CA', { ticker: CSB0313 }] },
              { accredited: { identity: '0x02' } },
            ],
          },
          issuers: [],
        },
      ],
      receiverConditions: [],
    });

    expect(JSON.parse(await complianceToV7(v6)).senderConditions[0].conditionType).toEqual({
      isAnyOf: [
        { jurisdiction: ['CA', { asset: CSB0313_ID }] },
        { accredited: { identity: '0x02' } },
      ],
    });
  });
});

describe('migrateToAssetIds', () => {
  const EVENT = '0015978579/0000000004';
  const KEY_PERMISSIONS = {
    assets: { type: 'these', values: [MTICKER03] },
    portfolios: { type: 'whole', values: null },
    transactions: {
      type: 'these',
      values: [{ palletName: ASSET, dispatchableNames: { these: [FREEZE] } }],
    },
    transactionGroups: [],
  };

  it('rewrites the keys still open, and leaves closed ones as they were', async () => {
    const db = mockStore({
      IdentityKey: {
        open: { id: 'open', validToBlockId: EXPLICIT_NULL, permissions: KEY_PERMISSIONS },
        closed: { id: 'closed', validToBlockId: '0000000009', permissions: KEY_PERMISSIONS },
      },
    });

    await migrateToAssetIds(EVENT);

    expect(db.IdentityKey.open).toMatchObject({
      permissions: {
        assets: { type: 'these', values: [MTICKER03_ID] },
        transactions: { type: 'these', values: { Asset: { extrinsics: { these: ['freeze'] } } } },
      },
      updatedEventId: EVENT,
    });
    expect(db.IdentityKey.closed.permissions).toEqual(KEY_PERMISSIONS);
  });

  it("rewrites an agent group's permissions", async () => {
    const db = mockStore({
      AgentGroup: {
        g: {
          id: 'g',
          permissions: JSON.stringify({
            these: [{ palletName: ASSET, dispatchableNames: { whole: null } }],
          }),
        },
      },
    });

    await migrateToAssetIds(EVENT);

    expect(JSON.parse(db.AgentGroup.g.permissions)).toEqual({
      these: { Asset: { extrinsics: { whole: null } } },
    });
  });

  it("rewrites a pending authorization's permissions and its ticker, and no other", async () => {
    const permissions = {
      asset: { these: [MTICKER03] },
      extrinsic: { these: [{ palletName: ASSET, dispatchableNames: { whole: null } }] },
      portfolio: { whole: null },
    };
    const db = mockStore({
      Authorization: {
        join: {
          id: 'join',
          type: 'JoinIdentity',
          status: 'Pending',
          data: JSON.stringify(permissions),
        },
        owner: {
          id: 'owner',
          type: 'TransferAssetOwnership',
          status: 'Pending',
          data: JSON.stringify(CSB0313),
        },
        agent: {
          id: 'agent',
          type: 'BecomeAgent',
          status: 'Pending',
          data: JSON.stringify([CSB0313, { full: null }]),
        },
        consumed: {
          id: 'consumed',
          type: 'JoinIdentity',
          status: 'Consumed',
          data: JSON.stringify(permissions),
        },
      },
    });

    await migrateToAssetIds(EVENT);

    expect(JSON.parse(db.Authorization.join.data)).toEqual({
      asset: { these: [MTICKER03_ID] },
      extrinsic: { these: { Asset: { extrinsics: { whole: null } } } },
      portfolio: { whole: null },
    });
    // in the field order 7.0's events give, which the stored text keeps
    expect(Object.keys(JSON.parse(db.Authorization.join.data))).toEqual([
      'asset',
      'extrinsic',
      'portfolio',
    ]);
    expect(JSON.parse(db.Authorization.owner.data)).toBe(CSB0313_ID);
    expect(JSON.parse(db.Authorization.agent.data)).toEqual([CSB0313_ID, { full: null }]);
    expect(JSON.parse(db.Authorization.consumed.data)).toEqual(permissions);
  });

  it('rewrites compliance requirements', async () => {
    const db = mockStore({
      Compliance: {
        c: {
          id: 'c',
          data: JSON.stringify({
            senderConditions: [],
            receiverConditions: [
              { conditionType: { isAbsent: { blocked: { ticker: CSB0313 } } }, issuers: [] },
            ],
          }),
        },
      },
    });

    await migrateToAssetIds(EVENT);

    expect(JSON.parse(db.Compliance.c.data).receiverConditions[0].conditionType).toEqual({
      isAbsent: { blocked: { asset: CSB0313_ID } },
    });
  });

  /**
   * From 7.0 a claim's scope is an asset id, and the handlers name it by the asset's ticker beside the
   * id, as a ticker's claims before it already are: so only a held claim of a ticker that is no
   * asset changes, its value becoming the id, as a 7.x event names it.
   */
  it("names a held claim's scope as a 7.x event would: by the asset's ticker, or its id", async () => {
    const scope = { type: 'Asset', value: 'MTICKER03', assetId: MTICKER03_ID };
    const orphan = { type: 'Asset', value: 'NOASSET', assetId: '0x' + 'ab'.repeat(16) };
    const db = mockStore({
      Asset: { [MTICKER03_ID]: { id: MTICKER03_ID, ticker: 'MTICKER03' } },
      Claim: {
        held: { id: 'held', scope },
        orphan: { id: 'orphan', scope: orphan },
        revoked: { id: 'revoked', scope: orphan, revokeDate: BigInt(1) },
        identity: { id: 'identity', scope: { type: 'Identity', value: '0x01' } },
      },
    });

    await migrateToAssetIds(EVENT);

    expect(db.Claim.held.scope).toEqual(scope);
    expect(db.Claim.orphan.scope).toEqual({ ...orphan, value: orphan.assetId });
    expect(db.Claim.revoked.scope).toEqual(orphan);
    expect(db.Claim.identity.scope).toEqual({ type: 'Identity', value: '0x01' });
  });

  /**
   * 7.0 linked every ticker it held a registration of to `AssetId::from(ticker)`, whether or not an
   * asset was created under it (`migrate_to_v5`, `TickerAssetId`), as the chain has held it since.
   */
  it('links every ticker registration to its asset id, an asset created under it or not', async () => {
    const db = mockStore({
      TickerReservation: {
        MTICKER03: { id: 'MTICKER03', ticker: 'MTICKER03' },
        LINKED: { id: 'LINKED', ticker: 'LINKED', assetId: MTICKER03_ID },
      },
    });

    await migrateToAssetIds(EVENT);

    expect(db.TickerReservation.MTICKER03).toMatchObject({
      assetId: MTICKER03_ID,
      updatedEventId: EVENT,
    });
    expect(db.TickerReservation.LINKED.updatedEventId).toBeUndefined();
  });

  it('writes nothing when every row is already in the 7.0 form', async () => {
    const db = mockStore({
      Compliance: {
        c: {
          id: 'c',
          updatedEventId: 'before',
          data: JSON.stringify({ senderConditions: [], receiverConditions: [] }),
        },
      },
    });

    await migrateToAssetIds(EVENT);

    expect(db.Compliance.c.updatedEventId).toBe('before');
  });
});
