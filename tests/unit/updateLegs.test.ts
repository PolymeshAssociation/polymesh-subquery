import { SubstrateBlock } from '@subql/types';
import { updateLegs } from '../../src/mappings/entities/settlements/mapSettlement';
import { mockStore } from './helpers';

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const at = {
  blockEventId: '0000000100/0000000003',
  block: {
    block: { header: { number: { toString: () => '100' } } },
    timestamp: new Date(0),
  } as unknown as SubstrateBlock,
  eventIdx: 3,
};

describe('updateLegs', () => {
  const legsOf = (instructionId: string, count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, legIndex) => [
        `${instructionId}/${legIndex}`,
        { id: `${instructionId}/${legIndex}`, instructionId, addresses: [ALICE] },
      ])
    );

  let bulkUpdate: jest.Mock;

  beforeEach(() => {
    bulkUpdate = (globalThis as any).store.bulkUpdate as jest.Mock;
    bulkUpdate.mockResolvedValue(undefined);
  });

  it('adds the signer to every leg of the instruction, read by id', async () => {
    mockStore({ Leg: { ...legsOf('0000000007', 2), ...legsOf('0000000008', 1) } });

    await updateLegs(at, BOB, { id: '0000000007', legCount: 2 });

    const [entity, legs] = bulkUpdate.mock.calls[0];
    expect(entity).toBe('Leg');
    expect(legs.map((leg: { id: string }) => leg.id)).toEqual(['0000000007/0', '0000000007/1']);
    expect(legs.every((leg: { addresses: string[] }) => leg.addresses.includes(BOB))).toBe(true);
    // no search, which a block of affirmations made quadratic, and no read past the last leg,
    // which no cache holds and so cost a Postgres query each time
    expect((globalThis as any).store.getByFields).not.toHaveBeenCalled();
    expect((globalThis as any).store.get).toHaveBeenCalledTimes(2);
  });

  it("records it when the index is missing some of the instruction's legs", async () => {
    // every instruction has its legs, written when it was created: fewer means the index lost some
    const db = mockStore({ Leg: legsOf('0000000007', 1) });

    await updateLegs(at, BOB, { id: '0000000007', legCount: 2 });

    // the leg it does hold still gets the signer
    expect(bulkUpdate.mock.calls[0][1].map((leg: { id: string }) => leg.id)).toEqual([
      '0000000007/0',
    ]);
    expect(Object.values(db.IndexerAnomaly ?? {})).toEqual([
      expect.objectContaining({ kind: 'MissingReferencedEntity' }),
    ]);
  });

  it('reads nothing on a path with no signer', async () => {
    mockStore({ Leg: legsOf('0000000007', 2) });

    await updateLegs(at, undefined, { id: '0000000007', legCount: 2 });

    expect((globalThis as any).store.get).not.toHaveBeenCalled();
    expect(bulkUpdate).not.toHaveBeenCalled();
  });
});
