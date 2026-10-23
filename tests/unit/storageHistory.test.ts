/**
 * `storage-history.json` records, per storage item, the spec versions over which its key and value
 * types stayed the same, read from each runtime's metadata by `scripts/survey-storage-history.ts`.
 * A seeder reads an item through the block's own registry, so it can only read an item some
 * runtime has, and needs to know where its shape changed.
 */
import history from '../fixtures/storage-history.json';

type Range = { from: number; to: number | null; keys: string[]; value: string; hashers: string[] };
const items = history as unknown as Record<string, { ranges: Range[]; pruned?: string }>;

describe('the storage history fixture', () => {
  it('keeps each item to ordered ranges that do not overlap', () => {
    const disordered = Object.entries(items).filter(([, { ranges }]) =>
      ranges.some(
        (range, i) =>
          (range.to !== null && range.to < range.from) ||
          (i > 0 && (ranges[i - 1].to === null || (ranges[i - 1].to as number) >= range.from))
      )
    );
    expect(disordered.map(([name]) => name)).toEqual([]);
  });

  it('records the confidential asset pallet testnet runs from 8.0', () => {
    expect(items['confidentialAssets.details'].ranges).toEqual([
      expect.objectContaining({ from: 8_000_000, to: null, chains: ['testnet'] }),
    ]);
  });

  it('records the ticker-keyed assets before v7 and the asset-id-keyed ones from it', () => {
    const tokens = items['asset.tokens'].ranges;
    const assets = items['asset.assets'].ranges;

    expect(tokens[tokens.length - 1].to).toBeLessThan(7_000_000);
    expect(assets[0].from).toBeGreaterThanOrEqual(7_000_000);
  });

  it('says when the chain prunes the instructions, multisig proposals, PIPs, authorizations, ballots and confidential settlements it removes', () => {
    const terminal = [
      'settlement.instructionDetails',
      'settlement.instructionLegs',
      'settlement.affirmsReceived',
      'settlement.userAffirmations',
      'multiSig.proposals',
      'pips.proposals',
      'pips.proposalMetadata',
      'identity.authorizations',
      'corporateBallot.metas',
      'confidentialAssets.settlementLegs',
    ];

    expect(terminal.filter(item => !items[item]?.pruned)).toEqual([]);
  });
});
