/**
 * One start path. An index seeds itself from the state its start block began from, then handles
 * that block's events like any block's; genesis is the case where the start block is block 1.
 */
import { encodeAddress } from '@polkadot/util-crypto';
import { SEED_EVENT_ID, systematicIssuers } from '../../../src/mappings/consts';
import { SEEDERS } from '../../../src/seed/seeders';
import { startIndex } from '../../../src/seed/start';
import { fakeChain, genesisChain } from './fakeChain';
import { byId, golden } from './goldens';

type Row = Record<string, unknown>;
const SYSTEMATIC = new Set(Object.values(systematicIssuers).map(({ did }) => did));

/**
 * Today's genesis handler's rows with what the seed does differently by design: none of the 20
 * identities it invented (a missing 3.x record read as a default, the zero account its primary
 * key), and the fields it left out or got wrong set from the chain.
 */
const expected = (chainName: 'testnet' | 'mainnet', entity: string): Row[] => {
  const rows = golden(chainName);
  const zero = encodeAddress(new Uint8Array(32), chainName === 'mainnet' ? 12 : 42);
  const phantom = new Set(
    rows.Identity.filter(({ primaryAccountId }) => primaryAccountId === zero).map(({ id }) => id)
  );
  // the genesis handler left a genesis multisig's signers unlinked; `multiSig.keyToMultiSig` names them
  const signers = new Set(
    (rows.MultiSigSigner ?? []).map(({ signerAccountId }) => signerAccountId)
  );
  return (rows[entity] ?? [])
    .filter(
      row =>
        row.id !== zero &&
        ![row.id, row.identityId, String(row.id).split('/')[0]].some(id =>
          phantom.has(id as string)
        )
    )
    .map(row =>
      entity === 'Account' && signers.has(row.id) ? { ...row, keyRole: 'MultiSigSigner' } : row
    );
};

/** Which fields of an entity the seed sets differently from the genesis handler, by design */
const CHANGED: Record<string, string[]> = {
  // opened at the seed, with a secondary key's permissions
  IdentityKey: ['addedReason', 'permissions'],
  // the commission its prefs set
  Validator: ['commission'],
};

describe.each(['testnet', 'mainnet'] as const)('starting from the %s genesis', chainName => {
  let rowsOf: (entity: string) => Row[];

  beforeAll(async () => {
    const chain = genesisChain(chainName);
    const goldenBlock = golden(chainName).Block[0];
    (globalThis as any).chainId = goldenBlock.hash;
    await startIndex(chain.blockAt(1, new Date(goldenBlock.datetime as string)));
    rowsOf = entity => chain.rows(entity);
  });

  it('writes the genesis block and the seed Event every seeded row points at', () => {
    expect(byId(rowsOf('Block'))).toEqual(byId(golden(chainName).Block));
    expect(byId(rowsOf('Event'))).toEqual(byId(golden(chainName).Event));
  });

  it.each([
    'Identity',
    'Portfolio',
    'Claim',
    'MultiSig',
    'MultiSigSigner',
    'MultiSigAdmin',
    'Era',
    'ValidatorEra',
    'AccountBalance',
    'Validator',
  ])('writes the %s rows the genesis handler wrote', entity => {
    const changed = CHANGED[entity] ?? [];
    expect(byId(rowsOf(entity), changed)).toEqual(byId(expected(chainName, entity), changed));
  });

  it("writes the keys and accounts it wrote, and the systematic issuers' it left out", () => {
    for (const entity of ['IdentityKey', 'Account']) {
      const changed = CHANGED[entity] ?? [];
      const seeded = byId(rowsOf(entity), changed);
      const wrote = byId(expected(chainName, entity), changed);
      expect(Object.fromEntries(Object.keys(wrote).map(id => [id, seeded[id]]))).toEqual(wrote);
      const extra = Object.values(seeded).filter(({ id }) => !(String(id) in wrote));
      expect(extra.every(({ identityId }) => SYSTEMATIC.has(identityId as string))).toBe(true);
    }
  });

  it('reserves the 401 tickers the genesis config registers, which no event announces', () => {
    expect(rowsOf('TickerReservation')).toHaveLength(401);
  });

  it('writes nothing the genesis handler had no rows for, but the ticker reservations', () => {
    const entities = Object.keys(golden(chainName));
    const extra = ['TickerReservation', 'IndexOrigin'];
    const written = [
      'Block',
      'Event',
      'Identity',
      'Account',
      'IdentityKey',
      'Portfolio',
      'Claim',
      'MultiSig',
      'MultiSigSigner',
      'MultiSigAdmin',
      'Era',
      'ValidatorEra',
      'Validator',
      'AccountBalance',
      'TickerReservation',
      'IndexOrigin',
      'Asset',
      'Venue',
      'Instruction',
    ].filter(entity => rowsOf(entity).length);
    expect(written.filter(entity => !entities.includes(entity) && !extra.includes(entity))).toEqual(
      []
    );
  });

  it('records where it started, and the fields it counts from there', () => {
    expect(rowsOf('IndexOrigin')).toEqual([
      expect.objectContaining({
        id: 'origin',
        startBlock: 1,
        specVersion: 3000,
        relativeFields: expect.arrayContaining([
          'AccountBalance.totalReceived',
          'Asset.totalTransfers',
        ]),
      }),
    ]);
  });
});

describe('starting after genesis', () => {
  it('writes the start block, the seed Event at it, and the seed', async () => {
    const chain = fakeChain(8_001_020);
    const DID = `0x${'01'.repeat(32)}`;
    chain.put('identity.didRecords', [DID], {
      primaryKey: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    });
    const block = chain.blockAt(26_326_409);
    (globalThis as any).api.rpc.chain.getBlockHash = jest.fn();

    await startIndex(block);

    expect(chain.rows('Event')).toEqual([
      expect.objectContaining({
        id: SEED_EVENT_ID,
        blockId: '0026326409',
        specVersionId: 8_001_020,
      }),
    ]);
    expect(chain.rows('Block').map(({ id }) => id)).toEqual(['0026326409']);
    expect(byId(chain.rows('Identity'))[DID]).toMatchObject({ createdEventId: SEED_EVENT_ID });
    expect(chain.rows('IndexOrigin')).toEqual([
      expect.objectContaining({ startBlock: 26_326_409 }),
    ]);
  });

  // a fresh index has no ChainUpgrade row: only the chain can say an upgrade preceded the block
  it("refuses the first block after an upgrade, whose parent's state the previous runtime wrote", async () => {
    const chain = fakeChain(8_001_020);
    const block = chain.blockAt(500);
    const getRuntimeVersion = jest.fn(async () => ({
      specVersion: { toNumber: () => 8_001_010 },
    }));
    (globalThis as any).api.rpc.state.getRuntimeVersion = getRuntimeVersion;

    await expect(startIndex(block)).rejects.toThrow(/first after a runtime upgrade/);
    // the runtime that executed the parent is the one the grandparent's state names
    expect(getRuntimeVersion).toHaveBeenCalledWith('0xgrandparent');
    expect(chain.rows('Event')).toEqual([]);
  });
});

/**
 * A seed runs inside its start block, which the node commits whole or not at all; a retry after a
 * failure re-runs the block over whatever a store that kept partial writes holds, and must end the
 * same as a clean start.
 */
describe('a seed that fails part-way', () => {
  it('ends, when retried, exactly as a clean start does', async () => {
    const entities = ['Identity', 'Account', 'Portfolio', 'Claim', 'Validator', 'IndexOrigin'];
    const clean = genesisChain('testnet');
    await startIndex(clean.blockAt(1, new Date(0)));
    const expected = Object.fromEntries(entities.map(entity => [entity, byId(clean.rows(entity))]));

    const chain = genesisChain('testnet');
    const failing = SEEDERS.find(({ entity }) => entity === 'Claim');
    if (!failing) {
      throw new Error('no seeder writes Claim');
    }
    const rows = failing.rows;
    failing.rows = () => {
      throw new Error('the node went away');
    };
    await expect(startIndex(chain.blockAt(1, new Date(0)))).rejects.toThrow('the node went away');
    failing.rows = rows;
    expect(chain.rows('Claim')).toEqual([]);

    await startIndex(chain.blockAt(1, new Date(0)));

    expect(Object.fromEntries(entities.map(entity => [entity, byId(chain.rows(entity))]))).toEqual(
      expected
    );
  });
});
