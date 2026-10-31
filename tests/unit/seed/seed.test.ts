/**
 * `seed()`: every seeder's rows, written a page at a time, then an Account row for each address a
 * seeded row names that no Account row covers.
 */
import { SEED_EVENT_ID } from '../../../src/mappings/consts';
import { relativeFields, seed, SeedContext, Seeder } from '../../../src/seed/seeder';
import { snapshotAtParent } from '../../../src/seed/snapshot';
import { fakeChain, FakeChain } from './fakeChain';

const pagesOf = <T>(...pages: T[][]) =>
  async function* rows() {
    yield* pages;
  };

describe('seed', () => {
  let chain: FakeChain;
  let ctx: SeedContext;

  beforeEach(() => {
    chain = fakeChain(8_000_020);
    ctx = {
      block: chain.block,
      blockId: '0000001000',
      eventId: SEED_EVENT_ID,
      datetime: new Date(0),
      specVersion: 8_000_020,
    };
  });

  it('writes each page with bulkCreate and reports the rows of each entity', async () => {
    const bulkCreate = jest.spyOn((globalThis as any).store, 'bulkCreate');
    const seeders: Seeder[] = [
      { entity: 'Venue', reads: [], rows: pagesOf([{ id: '1' }, { id: '2' }], [{ id: '3' }]) },
      { entity: 'Era', reads: [], rows: pagesOf([{ id: '9' }]) },
    ];

    const report = await seed(snapshotAtParent(chain.block, {}), ctx, { seeders });

    expect(report.map(({ entity, rows }) => [entity, rows])).toEqual([
      ['Venue', 3],
      ['Era', 1],
    ]);
    expect(bulkCreate).toHaveBeenCalledTimes(3);
    expect(chain.rows('Venue').map(({ id }) => id)).toEqual(['1', '2', '3']);
  });

  it('gives an Account row to each address a seeded row names that no Account row covers', async () => {
    const accountRows = jest.fn(async (addresses: string[]) =>
      addresses.map(address => ({ id: address }))
    );
    const seeders: Seeder[] = [
      { entity: 'Account', reads: [], rows: pagesOf([{ id: 'A' }]) },
      {
        entity: 'Subsidy',
        reads: [],
        accounts: ['beneficiaryAccountId', 'payingAccountId'],
        rows: pagesOf([{ id: 's', beneficiaryAccountId: 'A', payingAccountId: 'B' }]),
      },
    ];

    await seed(snapshotAtParent(chain.block, {}), ctx, { seeders, accountRows });

    expect(accountRows).toHaveBeenCalledWith(['B'], expect.anything(), ctx);
    expect(
      chain
        .rows('Account')
        .map(({ id }) => id)
        .sort()
    ).toEqual(['A', 'B']);
  });

  it('counts the fields every seeder counts from the start block', () => {
    expect(
      relativeFields([
        { entity: 'Subsidy', reads: [], relative: ['totalDebited'], rows: pagesOf() },
        { entity: 'Asset', reads: [], relative: ['totalTransfers'], rows: pagesOf() },
      ])
    ).toEqual(['Asset.totalTransfers', 'Subsidy.totalDebited']);
  });

  it('counts the fields a seeder counts from the start block on some of its rows', () => {
    expect(
      relativeFields([
        {
          entity: 'Leg',
          reads: [],
          relativeFor: { fields: ['toPortfolioId', 'fromPortfolioId'], when: () => true },
          rows: pagesOf(),
        },
      ])
    ).toEqual(['Leg.fromPortfolioId', 'Leg.toPortfolioId']);
  });
});

/**
 * A value its type can't read is not a value the chain lacks: a seeder that skipped it would leave
 * a row out. The seed stops, unless the seeder reads that item's raw bytes itself.
 */
describe('a stored value that does not decode', () => {
  const DID = `0x${'01'.repeat(32)}`;
  const ctx = (chain: FakeChain): SeedContext => ({
    block: chain.block,
    blockId: '0000001000',
    eventId: SEED_EVENT_ID,
    datetime: new Date(0),
    specVersion: chain.specVersion,
  });
  const reader = (raw?: string[]): Seeder => ({
    entity: 'Identity',
    reads: ['identity.didRecords'],
    raw: raw as never,
    async *rows(snap) {
      for await (const page of snap.pages('identity.didRecords')) {
        yield page.flatMap(({ args, value }) => (value ? [{ id: args[0].toString() }] : []));
      }
    },
  });

  it('stops the seed, naming the item and how many', async () => {
    const chain = fakeChain(8_001_020);
    chain.putRaw('identity.didRecords', [DID], '0x07');

    await expect(
      seed(snapshotAtParent(chain.block), ctx(chain), { seeders: [reader()] })
    ).rejects.toThrow(/1 value of identity.didRecords doesn't decode/);
  });

  it('carries on for a seeder that reads those raw bytes itself', async () => {
    const chain = fakeChain(8_001_020);
    chain.putRaw('identity.didRecords', [DID], '0x07');

    await expect(
      seed(snapshotAtParent(chain.block), ctx(chain), {
        seeders: [reader(['identity.didRecords'])],
      })
    ).resolves.toBeDefined();
  });
});
