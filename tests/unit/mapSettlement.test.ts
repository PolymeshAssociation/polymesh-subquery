import '@subql/types-core/dist/global';
import '@subql/types/dist/global';
import { shouldRescanAutomaticAffirmations } from '../../src/mappings/entities/settlements/mapSettlement';

/**
 * Regression tests: the guard around the `InstructionAutomaticallyAffirmed`
 * re-scan folded its two conditions into a single `||`, so it evaluated true for every
 * non-private chain at any spec version and the re-scan ran on every mainnet/testnet block
 * instead of only on the 6.1.0–6.3.1 window it exists for.
 */
describe('shouldRescanAutomaticAffirmations', () => {
  it('runs only within the 6.1.0–6.3.1 window on public chains', () => {
    expect(shouldRescanAutomaticAffirmations('polymesh', 6001000)).toBe(true);
    expect(shouldRescanAutomaticAffirmations('polymesh', 6003001)).toBe(true);
    expect(shouldRescanAutomaticAffirmations('polymesh', 6002000)).toBe(true);
  });

  it('does not run before 6.1.0 or after 6.3.1', () => {
    expect(shouldRescanAutomaticAffirmations('polymesh', 6000999)).toBe(false);
    expect(shouldRescanAutomaticAffirmations('polymesh', 6003002)).toBe(false);
    expect(shouldRescanAutomaticAffirmations('polymesh', 7000000)).toBe(false);
  });

  it('does not run at spec 8_000_000', () => {
    expect(shouldRescanAutomaticAffirmations('polymesh', 8000000)).toBe(false);
  });

  it('never runs on polymesh_private_dev, whatever its spec version', () => {
    expect(shouldRescanAutomaticAffirmations('polymesh_private_dev', 6002000)).toBe(false);
    expect(shouldRescanAutomaticAffirmations('polymesh_private_dev', 1000000)).toBe(false);
  });
});

/**
 * An instruction created by v5.3's `add_instruction_with_memo_v2` announces itself with
 * `InstructionV2Created`. Unrouted, the instruction never reaches the index, and rejecting or
 * executing it later stops the indexer at `getInstruction`. `handlerShapeFields.test.ts` checks
 * the handler's fields against the event's shape once it is routed.
 */
describe('instruction creation routing', () => {
  it('routes both forms of the created event to handleInstructionCreated', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const project = require('../../project').default;
    const routed = (project.dataSources as Array<{ mapping: { handlers: any[] } }>)
      .flatMap(source => source.mapping.handlers)
      .filter(({ handler }) => handler === 'handleInstructionCreated')
      .map(({ filter }) => `${filter.module}.${filter.method}`);

    expect(routed).toEqual(
      expect.arrayContaining(['settlement.InstructionCreated', 'settlement.InstructionV2Created'])
    );
  });
});
