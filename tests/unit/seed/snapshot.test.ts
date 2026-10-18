/**
 * `ChainSnapshot`: the state a seed reads, each storage item fetched at most once whichever seeders
 * ask, and an item whose shape no seeder knows refused rather than misread.
 */
import { findStorage } from '../../../src/utils/legacyQuery';
import { shapeOf } from '../../../src/seed/shapes';
import { snapshotAtParent, UnsupportedShapeError } from '../../../src/seed/snapshot';
import { fakeChain, FakeChain } from './fakeChain';

const STASH = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const OTHER = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

const ledger = (stash: string) => ({
  stash,
  total: 10,
  active: 10,
  unlocking: [],
  legacyClaimedRewards: [],
});

describe('ChainSnapshot', () => {
  let chain: FakeChain;
  let declared: Record<string, string[]>;

  beforeEach(() => {
    chain = fakeChain(8_000_020);
    chain.put('staking.ledger', [STASH], ledger(STASH));
    chain.put('staking.ledger', [OTHER], ledger(OTHER));
    declared = {
      'staking.ledger': [shapeOf(findStorage('staking', 'ledger') as never)],
      'staking.bonded': [shapeOf(findStorage('staking', 'bonded') as never)],
    };
  });

  it('reads an item once, whichever seeders ask for it', async () => {
    const keysPaged = jest.spyOn((globalThis as any).api.rpc.state, 'getKeysPaged');
    const snap = snapshotAtParent(chain.block, declared);

    const [first, second] = await Promise.all([
      snap.map('staking.ledger'),
      snap.map('staking.ledger'),
    ]);
    const pages = [];
    for await (const page of snap.pages('staking.ledger')) {
      pages.push(...page);
    }

    expect(first).toBe(second);
    expect([...first.keys()].sort()).toEqual([OTHER, STASH].sort());
    expect(pages.map(({ args }) => args[0].toString()).sort()).toEqual([OTHER, STASH].sort());
    // one page of keys, then the empty page that ends the item, fetched once between them
    expect(keysPaged).toHaveBeenCalledTimes(1);
  });

  it("decodes each entry with the block's registry", async () => {
    const entries = await snapshotAtParent(chain.block, declared).map('staking.ledger');

    expect(entries.get(STASH)?.value?.toJSON()).toMatchObject({ stash: STASH, active: 10 });
  });

  it('has no item the runtime lacks', () => {
    const snap = snapshotAtParent(chain.block, { ...declared, 'asset.tokens': [] });

    expect(snap.has('staking.ledger')).toBe(true);
    expect(snap.has('asset.tokens')).toBe(false);
  });

  it('refuses a populated item whose shape no seeder declares, naming it', async () => {
    const snap = snapshotAtParent(chain.block, { 'staking.ledger': ['some other shape'] });

    await expect(snap.map('staking.ledger')).rejects.toThrow(UnsupportedShapeError);
    await expect(snap.map('staking.ledger')).rejects.toThrow(/staking\.ledger.*8000020/);
  });

  it('reads an empty item whatever its shape', async () => {
    const snap = snapshotAtParent(chain.block, { 'staking.bonded': ['some other shape'] });

    expect((await snap.map('staking.bonded')).size).toBe(0);
  });

  it('refuses an item no seeder declares', async () => {
    const snap = snapshotAtParent(chain.block, declared);

    await expect(snap.map('staking.payee')).rejects.toThrow(/staking\.payee/);
  });
});
