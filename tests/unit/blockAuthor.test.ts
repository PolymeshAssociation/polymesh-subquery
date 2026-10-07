import { SubstrateBlock } from '@subql/types';
import { blockAuthor } from '../../src/utils/blockAuthor';

const VALIDATORS = ['5VALIDATOR_ZERO', '5VALIDATOR_ONE', '5VALIDATOR_TWO'];

const preRuntime = (engine: 'BABE' | 'aura', authorityIndex: number) => ({
  isPreRuntime: true,
  asPreRuntime: [{ isBabe: engine === 'BABE' }, { authorityIndex }],
});

const blockWith = (height: number, logs: unknown[]): SubstrateBlock =>
  ({
    block: { header: { number: { toString: () => String(height) }, digest: { logs } } },
    hash: { toHex: () => `0xhash${height}` },
  } as unknown as SubstrateBlock);

describe('blockAuthor', () => {
  let validators: jest.Mock;

  beforeEach(() => {
    validators = jest.fn().mockResolvedValue(VALIDATORS);
    (globalThis as any).api.query = { session: { validators } };
    (globalThis as any).api.registry = {
      // the decoded digest carries the authority index the slot was claimed with
      createType: jest.fn((_type: string, data: { authorityIndex: number }) => ({
        value: { authorityIndex: { toNumber: () => data.authorityIndex } },
      })),
    };
  });

  it("is the session validator the BABE digest's authority index points at", async () => {
    await expect(blockAuthor(blockWith(100, [preRuntime('BABE', 2)]))).resolves.toBe(
      '5VALIDATOR_TWO'
    );
  });

  it('reads the validator set once per block, however many fees ask', async () => {
    const block = blockWith(101, [preRuntime('BABE', 1)]);

    await blockAuthor(block);
    await blockAuthor(block);

    expect(validators).toHaveBeenCalledTimes(1);
  });

  it('is undefined for a block with no BABE digest — the fee then goes to no one', async () => {
    await expect(blockAuthor(blockWith(102, [preRuntime('aura', 0)]))).resolves.toBeUndefined();
    await expect(blockAuthor(blockWith(103, []))).resolves.toBeUndefined();
  });

  it('remembers that there was no author, rather than asking again', async () => {
    const block = blockWith(104, [preRuntime('BABE', 9)]);

    await expect(blockAuthor(block)).resolves.toBeUndefined();
    await expect(blockAuthor(block)).resolves.toBeUndefined();

    expect(validators).toHaveBeenCalledTimes(1);
  });
});
