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

beforeEach(() => {
  block = {
    block: { header: { number: { toString: () => '466634' }, parentHash: '0xparent' } },
  } as unknown as SubstrateBlock;
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
    // the first block after an upgrade: the parent ran under 3000 and stored 3000's layout, but this
    // block's registry is 3010's, and decoding the one with the other can give a wrong account
    getRuntimeVersion.mockResolvedValue(spec(2025));

    expect(await storageAtParent(block, 'bridge', 'controller')).toBeUndefined();
    expect(getRuntimeVersion).toHaveBeenCalledWith('0xgrandparent');
    expect(getStorage).not.toHaveBeenCalled();
  });

  it('asks which runtime wrote the parent once per block', async () => {
    getStorage.mockResolvedValue({ isNone: true });

    await storageAtParent(block, 'bridge', 'controller');
    await storageAtParent(block, 'multiSig', 'multiSigToIdentity', '5Multisig');

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
