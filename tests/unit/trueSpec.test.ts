import { SubstrateBlock } from '@subql/types';
import { ensureTrueSpecVersion } from '../../src/mappings/trueSpec';

/**
 * The node labels blocks near an upgrade with the neighbouring runtime's spec — on testnet, block
 * 10,035,141 ran under 5004002 and was labelled 6000001. The runtime that executed a block is the
 * one its parent's state holds.
 */
describe('ensureTrueSpecVersion', () => {
  const block = (height: number, labelled: number) =>
    ({
      block: {
        header: {
          number: { toString: () => String(height) },
          parentHash: `0xparent${height}`,
        },
      },
      hash: { toHex: () => `0xhash${height}` },
      specVersion: labelled,
    } as unknown as SubstrateBlock);

  let getRuntimeVersion: jest.Mock;

  beforeEach(() => {
    getRuntimeVersion = jest.fn(async () => ({ specVersion: { toNumber: () => 5_004_002 } }));
    (globalThis as any).api.rpc = { state: { getRuntimeVersion } };
  });

  it('replaces a wrong label with the runtime that executed the block', async () => {
    const mislabelled = block(10_035_141, 6_000_001);

    await ensureTrueSpecVersion(mislabelled);

    expect(getRuntimeVersion).toHaveBeenCalledWith('0xparent10035141');
    expect(mislabelled.specVersion).toBe(5_004_002);
  });

  it('asks once per block, however many handlers the block reaches', async () => {
    const b = block(10_035_142, 5_004_002);

    await ensureTrueSpecVersion(b);
    await ensureTrueSpecVersion(b);

    expect(getRuntimeVersion).toHaveBeenCalledTimes(1);
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
