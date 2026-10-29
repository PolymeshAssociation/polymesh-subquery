import { writeIndexOrigin } from '../../src/mappings/indexOrigin';
import { mockStore } from './helpers';

/**
 * The first block of an index seeds it, from genesis or a later start block, and the index records
 * where it started.
 */
describe('the first datasource', () => {
  const firstDatasource = (startBlock?: string) => {
    let project: any;
    jest.isolateModules(() => {
      const previous = process.env.START_BLOCK;
      if (startBlock === undefined) delete process.env.START_BLOCK;
      else process.env.START_BLOCK = startBlock;
      // project.ts reads START_BLOCK when it loads, so each case needs its own copy of the module
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      project = require('../../project').default;
      if (previous === undefined) delete process.env.START_BLOCK;
      else process.env.START_BLOCK = previous;
    });

    return project.dataSources[0];
  };

  it('is the genesis handler over the first block, from genesis', () => {
    expect(firstDatasource()).toMatchObject({
      startBlock: 1,
      endBlock: 1,
      mapping: { handlers: [{ handler: 'handleGenesis' }] },
    });
  });

  /** A `[1, 1]` range beside `[startBlock, ∞)` is two disjoint ranges the node never bridges. */
  it('is the seeder over the start block itself, from a later block, with no genesis range left', () => {
    expect(firstDatasource('500')).toMatchObject({
      startBlock: 500,
      endBlock: 500,
      mapping: { handlers: [{ handler: 'handleSeed' }] },
    });
  });
});

describe('IndexOrigin', () => {
  it('records where the index started, and the fields it counts from there', async () => {
    const db = mockStore();
    const block = {
      block: {
        header: { number: { toString: () => '500' }, hash: { toHex: () => '0xabc' } },
      },
      specVersion: 8_001_020,
      timestamp: new Date('2026-01-01T00:00:00Z'),
    } as never;

    await writeIndexOrigin(block, ['Asset.totalTransfers']);

    expect(db.IndexOrigin.origin).toMatchObject({
      startBlock: 500,
      startBlockHash: '0xabc',
      specVersion: 8_001_020,
      relativeFields: ['Asset.totalTransfers'],
    });
  });
});
