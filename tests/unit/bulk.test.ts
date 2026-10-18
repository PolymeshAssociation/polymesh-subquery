import { SubstrateBlock } from '@subql/types';
import { mapAtParent, readManyAtParent, scanAtParent, __limiter } from '../../src/seed/bulk';
import * as storage from '../../src/utils/storageAtParent';
import { UndecodableStateError } from '../../src/utils/storageAtParent';

jest.mock('../../src/utils/storageAtParent', () => ({
  ...jest.requireActual('../../src/utils/storageAtParent'),
  parentStateReadable: jest.fn(),
  decodeStored: jest.fn(),
  keyArgs: jest.fn(),
}));

const block = {
  block: { header: { number: { toString: () => '500' }, parentHash: '0xparent' } },
  specVersion: 8_000_000,
} as unknown as SubstrateBlock;

/** A storage map of `size` entries, `key-0`…, each stored as its index, read as the node pages it */
const chainWith = (size: number, undecodable: number[] = []) => {
  const keys = Array.from({ length: size }, (_, i) => `key-${String(i).padStart(5, '0')}`);
  const inFlight = { now: 0, max: 0 };
  const hexOf = (key: unknown): string =>
    typeof key === 'string' ? key : (key as { toHex(): string }).toHex();
  const track = async <T>(run: () => T): Promise<T> => {
    inFlight.now += 1;
    inFlight.max = Math.max(inFlight.max, inFlight.now);
    await new Promise(resolve => setTimeout(resolve, 1));
    inFlight.now -= 1;
    return run();
  };
  const rpc = {
    getKeysPaged: jest.fn((_prefix: string, count: number, after: unknown, hash: string) =>
      track(() => {
        expect(hash).toBe('0xparent');
        const from = after === 'prefix' ? 0 : keys.indexOf(hexOf(after)) + 1;
        return keys.slice(from, from + count).map(key => ({ toHex: () => key }));
      })
    ),
    queryStorageAt: jest.fn((asked: unknown[], hash: string) =>
      track(() => {
        expect(hash).toBe('0xparent');
        return asked.map(key => ({ value: keys.indexOf(hexOf(key)) }));
      })
    ),
  };
  (globalThis as any).api.rpc = { state: rpc };
  (globalThis as any).api.query = {
    things: {
      stored: { keyPrefix: () => 'prefix', key: (id: string) => id },
    },
  };
  (storage.parentStateReadable as jest.Mock).mockResolvedValue(true);
  (storage.keyArgs as jest.Mock).mockImplementation((_item, key) => [
    { toString: () => key.toHex() },
  ]);
  (storage.decodeStored as jest.Mock).mockImplementation((_item, raw: { value: number }) => {
    if (undecodable.includes(raw.value)) {
      throw new UndecodableStateError('could not decode things.stored', new Error('bad bytes'));
    }
    return { toJSON: () => raw.value };
  });
  return { rpc, inFlight };
};

const collect = async <T>(pages: AsyncIterable<T[]>): Promise<T[][]> => {
  const out: T[][] = [];
  for await (const page of pages) {
    out.push(page);
  }
  return out;
};

describe('scanAtParent', () => {
  it('reads a map a page of 1,000 keys at a time, with one value request a page, at the parent', async () => {
    const { rpc } = chainWith(2500);

    const pages = await collect(scanAtParent(block, 'things', 'stored'));

    expect(pages.map(page => page.length)).toEqual([1000, 1000, 500]);
    expect(rpc.getKeysPaged).toHaveBeenCalledTimes(3);
    expect(rpc.queryStorageAt).toHaveBeenCalledTimes(3);
    const values = pages.flat().map(({ value }) => value?.toJSON());
    expect(new Set(values).size).toBe(2500);
  });

  it('reads only the entries under leading key arguments, when given them', async () => {
    const { rpc } = chainWith(3);
    const keyPrefix = jest.fn((...args: unknown[]) => (args.length ? 'prefix' : 'whole'));
    (globalThis as any).api.query.things.stored.keyPrefix = keyPrefix;

    const pages = await collect(scanAtParent(block, 'things', 'stored', 'first'));

    expect(keyPrefix).toHaveBeenCalledWith('first');
    expect(rpc.getKeysPaged.mock.calls[0][0]).toBe('prefix');
    expect(pages.flat()).toHaveLength(3);
  });

  it("halves a page whose values the node won't return in one response, until each part fits", async () => {
    const { rpc } = chainWith(1000);
    const query = rpc.queryStorageAt.getMockImplementation() as (...args: unknown[]) => unknown;
    rpc.queryStorageAt.mockImplementation(((asked: unknown[], hash: string) => {
      if (asked.length > 300) {
        return Promise.reject(
          new Error('-32008: Response is too big: Exceeded max limit of 15728640')
        );
      }
      return query(asked, hash);
    }) as never);

    const [page] = await collect(scanAtParent(block, 'things', 'stored'));

    expect(page).toHaveLength(1000);
    expect(page.map(({ value }) => value?.toJSON())).toEqual([...Array(1000).keys()]);
  });

  it('fails on any other error from the node', async () => {
    const { rpc } = chainWith(10);
    rpc.queryStorageAt.mockImplementation(() => Promise.reject(new Error('connection lost')));

    await expect(collect(scanAtParent(block, 'things', 'stored'))).rejects.toThrow(
      /connection lost/
    );
  });

  it('gives an entry the runtime cannot decode its raw bytes, rather than failing the scan', async () => {
    chainWith(3, [1]);

    const [page] = await collect(scanAtParent(block, 'things', 'stored'));

    expect(page.map(({ value }) => value?.toJSON())).toEqual([0, undefined, 2]);
    expect(page[1].raw).toEqual({ value: 1 });
  });

  it('scans nothing for an item the runtime lacks', async () => {
    chainWith(3);

    expect(await collect(scanAtParent(block, 'things', 'absent'))).toEqual([]);
  });

  it('refuses a block whose parent another runtime wrote', async () => {
    chainWith(3);
    (storage.parentStateReadable as jest.Mock).mockResolvedValue(false);

    await expect(collect(scanAtParent(block, 'things', 'stored'))).rejects.toThrow(
      /written by another runtime/
    );
  });
});

describe('mapAtParent', () => {
  it('holds a whole map, keyed by its key arguments', async () => {
    chainWith(1200);

    const map = await mapAtParent(block, 'things', 'stored');

    expect(map.size).toBe(1200);
    expect(map.get('key-00007')?.value?.toJSON()).toBe(7);
  });
});

describe('readManyAtParent', () => {
  it('reads known keys in batches of 1,000', async () => {
    const { rpc } = chainWith(2500);

    const values = await readManyAtParent(
      block,
      'things',
      'stored',
      Array.from({ length: 2500 }, (_, i) => [`key-${String(i).padStart(5, '0')}`])
    );

    expect(rpc.queryStorageAt).toHaveBeenCalledTimes(3);
    expect(values.map(value => value?.toJSON())).toEqual(Array.from({ length: 2500 }, (_, i) => i));
  });
});

describe('the request limiter', () => {
  it('never has more than 4 requests in flight to the endpoint', async () => {
    const { inFlight } = chainWith(9000);

    await Promise.all([
      collect(scanAtParent(block, 'things', 'stored')),
      readManyAtParent(
        block,
        'things',
        'stored',
        Array.from({ length: 9000 }, (_, i) => [`key-${String(i).padStart(5, '0')}`])
      ),
      mapAtParent(block, 'things', 'stored'),
    ]);

    expect(inFlight.max).toBeLessThanOrEqual(4);
    expect(__limiter.max).toBe(4);
  });
});
