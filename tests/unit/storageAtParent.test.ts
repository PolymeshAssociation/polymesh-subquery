import { SubstrateBlock } from '@subql/types';
import { storageAtParent, storageEntriesAtParent } from '../../src/utils/storageAtParent';

// a fresh block per test: whether a block's parent state is readable is remembered per block
let block: SubstrateBlock;

const getStorage = jest.fn();
const getKeysPaged = jest.fn();
const getHeader = jest.fn();
const getRuntimeVersion = jest.fn();
const spec = (specVersion: number) => ({ specVersion: { toNumber: () => specVersion } });
const createType = jest.fn();

/** `ChainUpgrade` rows, by the block carrying each one's `system.CodeUpdated` */
let upgrades: { firstBlockId: string; specVersionId: number }[];

beforeEach(() => {
  // the block's true spec, which `ensureTrueSpecVersion` has set before any handler reads state
  block = {
    block: { header: { number: { toString: () => '466634' }, parentHash: '0xparent' } },
    specVersion: 3000,
  } as unknown as SubstrateBlock;
  upgrades = [];
  ((globalThis as any).store.getByFields as jest.Mock).mockImplementation(
    (_entity: string, filter: [string, string, unknown][]) =>
      Promise.resolve(upgrades.filter(row => filter.every(([f, , v]) => (row as any)[f] === v)))
  );
  getStorage.mockReset();
  getKeysPaged.mockReset();
  getHeader.mockReset().mockResolvedValue({ parentHash: '0xgrandparent' });
  // the parent block ran under the same runtime this block's registry describes
  getRuntimeVersion.mockReset().mockResolvedValue(spec(3000));
  createType
    .mockReset()
    .mockImplementation((type: string, input: Uint8Array | string) =>
      type === 'StorageKey'
        ? { setMeta: (meta: unknown) => ({ args: [{ key: input, meta }] }) }
        : { type, bytes: Array.from(input as Uint8Array) }
    );
  (globalThis as any).api = {
    query: {
      multiSig: {
        multiSigToIdentity: {
          keyPrefix: () => '0xprefix',
          key: (...keys: unknown[]) => `0xkey:${JSON.stringify(keys)}`,
          creator: { meta: { type: { isMap: true, asMap: { value: 42 }, asPlain: undefined } } },
        },
      },
      bridge: {
        controller: {
          key: () => '0xcontroller',
          creator: { meta: { type: { isMap: false, asMap: undefined, asPlain: 7 } } },
        },
      },
    },
    runtimeVersion: spec(3000),
    rpc: { chain: { getHeader }, state: { getStorage, getKeysPaged, getRuntimeVersion } },
    registry: { createLookupType: (id: number) => `Lookup${id}`, createType },
  };
});

describe('storageAtParent', () => {
  it('reads a map entry at the parent hash and decodes it with the value type', async () => {
    getStorage.mockResolvedValue({
      isNone: false,
      unwrap: () => ({ toU8a: () => Uint8Array.from([1, 2]) }),
    });

    const value = await storageAtParent(block, 'multiSig', 'multiSigToIdentity', '5Multisig');

    expect(getStorage).toHaveBeenCalledWith('0xkey:["5Multisig"]', '0xparent');
    expect(value).toEqual({ type: 'Lookup42', bytes: [1, 2] });
  });

  it('decodes a plain value with its plain type', async () => {
    getStorage.mockResolvedValue({
      isNone: false,
      unwrap: () => ({ toU8a: () => Uint8Array.from([9]) }),
    });

    expect(await storageAtParent(block, 'bridge', 'controller')).toEqual({
      type: 'Lookup7',
      bytes: [9],
    });
  });

  it('is undefined when nothing is stored', async () => {
    getStorage.mockResolvedValue({ isNone: true });

    expect(await storageAtParent(block, 'bridge', 'controller')).toBeUndefined();
  });

  it('is undefined when this runtime has no such storage item', async () => {
    expect(await storageAtParent(block, 'nft', 'collection', 1)).toBeUndefined();
    expect(getStorage).not.toHaveBeenCalled();
  });

  it("reads nothing when another runtime wrote the parent's state", async () => {
    // the first block after an upgrade: the parent carried it, so ran under the old runtime and
    // stored its layout, and decoding that with this block's registry can give a wrong account
    upgrades = [{ firstBlockId: '0000466633', specVersionId: 3000 }];
    getRuntimeVersion.mockResolvedValue(spec(2025));

    expect(await storageAtParent(block, 'bridge', 'controller')).toBeUndefined();
    expect(getRuntimeVersion).toHaveBeenCalledWith('0xgrandparent');
    expect(getStorage).not.toHaveBeenCalled();
  });

  it("reads nothing on a block whose registry is another runtime's", async () => {
    // the dictionary labelled the block, and so built its registry, for a neighbouring runtime
    (block as { specVersion: number }).specVersion = 2025;

    expect(await storageAtParent(block, 'bridge', 'controller')).toBeUndefined();
    expect(getStorage).not.toHaveBeenCalled();
  });

  it('asks the chain nothing about the parent unless an upgrade came in it', async () => {
    getStorage.mockResolvedValue({ isNone: true });

    await storageAtParent(block, 'bridge', 'controller');

    expect(getHeader).not.toHaveBeenCalled();
    expect(getRuntimeVersion).not.toHaveBeenCalled();
    expect(getStorage).toHaveBeenCalled();
  });

  it('asks which runtime wrote the parent once per block', async () => {
    getStorage.mockResolvedValue({ isNone: true });

    upgrades = [{ firstBlockId: '0000466633', specVersionId: 3000 }];

    await storageAtParent(block, 'bridge', 'controller');
    await storageAtParent(block, 'multiSig', 'multiSigToIdentity', '5Multisig');

    expect((globalThis as any).store.getByFields).toHaveBeenCalledTimes(1);
    expect(getRuntimeVersion).toHaveBeenCalledTimes(1);
  });

  describe('storageEntriesAtParent', () => {
    const key = (byte: number) => ({
      toU8a: () => Uint8Array.from([byte]),
      toHex: () => `0x0${byte}`,
    });
    const stored = (byte: number) => ({
      isNone: false,
      unwrap: () => ({ toU8a: () => Uint8Array.from([byte, byte]) }),
    });

    it("reads every entry of a map at the parent hash, with each key's decoded arguments", async () => {
      getKeysPaged.mockResolvedValue([key(1), key(2)]);
      getStorage.mockImplementation((k: { toU8a: () => Uint8Array }) =>
        Promise.resolve(stored(k.toU8a()[0]))
      );

      const entries = await storageEntriesAtParent(block, 'multiSig', 'multiSigToIdentity');

      expect(getKeysPaged).toHaveBeenCalledWith('0xprefix', 1000, '0xprefix', '0xparent');
      // the key decoded by this block's registry, against the map's own metadata, from its hex: a
      // mapping slicing the bytes itself meets the sandbox's proxied buffer
      const { meta } = (globalThis as any).api.query.multiSig.multiSigToIdentity.creator;
      expect(entries).toEqual([
        { args: [{ key: '0x01', meta }], value: { type: 'Lookup42', bytes: [1, 1] } },
        { args: [{ key: '0x02', meta }], value: { type: 'Lookup42', bytes: [2, 2] } },
      ]);
    });

    it('pages through a map larger than one page', async () => {
      const page = Array.from({ length: 1000 }, (_, i) => key(i % 256));
      getKeysPaged.mockResolvedValueOnce(page).mockResolvedValueOnce([key(7)]);
      getStorage.mockResolvedValue({ isNone: true });

      await storageEntriesAtParent(block, 'multiSig', 'multiSigToIdentity');

      expect(getKeysPaged).toHaveBeenCalledTimes(2);
      expect(getKeysPaged.mock.calls[1][2]).toBe(page[999]);
    });

    it("reads nothing when another runtime wrote the parent's state", async () => {
      upgrades = [{ firstBlockId: '0000466633', specVersionId: 3000 }];
      getRuntimeVersion.mockResolvedValue(spec(2025));

      // unreadable, which is not the same as empty
      expect(await storageEntriesAtParent(block, 'multiSig', 'multiSigToIdentity')).toBeUndefined();
      expect(getKeysPaged).not.toHaveBeenCalled();
    });

    it('is empty, not unreadable, when the map holds nothing', async () => {
      getKeysPaged.mockResolvedValue([]);

      expect(await storageEntriesAtParent(block, 'multiSig', 'multiSigToIdentity')).toEqual([]);
    });
  });
});
