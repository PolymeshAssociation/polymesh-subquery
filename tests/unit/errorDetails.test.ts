import { Codec, Registry } from '@polkadot/types/types';
import { getErrorDetails } from '../../src/utils/common';

/** a registry whose error table names settlement error `0x22` `name` */
const registryNaming = (name: string) =>
  ({
    findMetaError: ({
      index,
      error,
    }: {
      index: { toNumber(): number };
      error: { toNumber(): number };
    }) =>
      index.toNumber() === 37 && error.toNumber() === 0x22
        ? { section: 'settlement', name, docs: [`${name} docs`] }
        : { section: 'unknown', name: 'Unknown', docs: [] },
  } as unknown as Registry);

const dispatchError = (registry: Registry) =>
  ({
    registry,
    toString: () => JSON.stringify({ module: { index: 37, error: '0x22000000' } }),
  } as unknown as Codec);

describe('getErrorDetails', () => {
  /**
   * testnet 10,036,148, the first block on 6.0: the node can label it 5.4, and its `api` then
   * decodes with 5.4's metadata, while the event was decoded with 6.0's
   */
  it('names a module error from the error table of the runtime that decoded it', () => {
    (globalThis as any).api.registry = registryNaming('DeprecatedCallOnV2Instruction');

    expect(
      getErrorDetails(dispatchError(registryNaming('FailedToReleaseLockOrTransferAssets')))
    ).toEqual({
      errorType: 'settlement.FailedToReleaseLockOrTransferAssets',
      details: 'FailedToReleaseLockOrTransferAssets docs',
    });
  });
});
