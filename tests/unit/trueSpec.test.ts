import { SubstrateBlock } from '@subql/types';
import { __resetInitialSpec, ensureTrueSpecVersion } from '../../src/mappings/trueSpec';

/**
 * The node labels blocks near an upgrade with the neighbouring runtime's spec — on testnet, block
 * 10,035,141 ran under 5004002 and was labelled 6000001. The runtime that executed a block is the
 * one the index's own `ChainUpgrade` rows say was in force.
 */
describe('ensureTrueSpecVersion', () => {
  const block = (height: number, labelled: number) =>
    ({
      block: {
        header: {
          number: { toString: () => String(height) },
          parentHash: `0xparent${height}`,
          hash: { toHex: () => `0xhash${height}` },
        },
      },
      specVersion: labelled,
    } as unknown as SubstrateBlock);

  /** A `ChainUpgrade` as `mapChainUpgrade` writes it: keyed on the block carrying `CodeUpdated`. */
  const upgrade = (codeUpdatedAt: number, specVersionId: number) => ({
    id: String(specVersionId).padStart(10, '0'),
    specVersionId,
    transactionVersion: 1,
    firstBlockId: String(codeUpdatedAt).padStart(10, '0'),
  });

  let getRuntimeVersion: jest.Mock;
  let upgrades: ReturnType<typeof upgrade>[];

  beforeEach(() => {
    __resetInitialSpec();
    upgrades = [];
    getRuntimeVersion = jest.fn(async () => ({ specVersion: { toNumber: () => 3_000 } }));
    (globalThis as any).api.rpc = { state: { getRuntimeVersion } };
    ((globalThis as any).store.getByFields as jest.Mock).mockImplementation(
      (_entity: string, _filter: unknown, { offset = 0 }: { offset?: number } = {}) =>
        Promise.resolve(offset === 0 ? upgrades : [])
    );
  });

  it('takes the spec from the upgrades the index recorded, without asking the chain', async () => {
    // testnet: 6000001's `CodeUpdated` came in 10,036,147, so it ran from 10,036,148
    upgrades = [upgrade(9_830_207, 5_004_002), upgrade(10_036_147, 6_000_001)];
    const upgradeBlock = block(10_036_147, 6_000_001);
    const first = block(10_036_148, 5_004_002);

    await ensureTrueSpecVersion(upgradeBlock);
    await ensureTrueSpecVersion(first);

    // the block carrying `CodeUpdated` still ran the runtime it replaced
    expect(upgradeBlock.specVersion).toBe(5_004_002);
    expect(first.specVersion).toBe(6_000_001);
    expect(getRuntimeVersion).not.toHaveBeenCalled();
  });

  it('reads the chain once for blocks before the first recorded upgrade', async () => {
    const genesisEra = block(10, 9_999);
    const later = block(20, 9_999);

    await ensureTrueSpecVersion(genesisEra);
    await ensureTrueSpecVersion(later);

    expect(getRuntimeVersion).toHaveBeenCalledTimes(1);
    expect(getRuntimeVersion).toHaveBeenCalledWith('0xparent10');
    expect(genesisEra.specVersion).toBe(3_000);
    expect(later.specVersion).toBe(3_000);
  });

  it('checks once per block, however many handlers the block reaches', async () => {
    upgrades = [upgrade(100, 3_001)];
    const b = block(200, 3_000);

    await ensureTrueSpecVersion(b);
    await ensureTrueSpecVersion(b);

    expect((globalThis as any).store.getByFields).toHaveBeenCalledTimes(1);
    expect(b.specVersion).toBe(3_001);
  });
});

describe('the datasource that checks the spec', () => {
  it('is declared ahead of the specific handlers, so it runs first for every event', () => {
    let project: any;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      project = require('../../project').default;
    });
    const [, first, second] = project.dataSources;

    expect(
      first.mapping.handlers.every((h: { handler: string }) => h.handler === 'handleEvent')
    ).toBe(true);
    expect(
      second.mapping.handlers.some((h: { handler: string }) => h.handler !== 'handleEvent')
    ).toBe(true);
  });
});
