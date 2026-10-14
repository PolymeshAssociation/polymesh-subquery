import { blockEvents, eventParams, substrateEventAt } from '../../src/utils/blockEvents';

const record = (method: string, data: unknown[]) => ({
  phase: { toString: () => 'ApplyExtrinsic' },
  event: { section: 'asset', method, data },
  topics: [],
});

describe('blockEvents helpers', () => {
  const block: any = { events: [record('Issued', ['a']), record('Transfer', ['b', 'c'])] };

  it('reads the block event records, or none when the block carries no list', () => {
    expect(blockEvents(block)).toHaveLength(2);
    expect(blockEvents({} as any)).toEqual([]);
  });

  it('presents a record as the event a handler receives', () => {
    const extrinsic: any = { idx: 3 };
    const event = substrateEventAt(block, 1, extrinsic);

    expect(event.idx).toBe(1);
    expect(event.block).toBe(block);
    expect(event.extrinsic).toBe(extrinsic);
    expect(event.event.method).toBe('Transfer');
    expect(event.phase).toBe(block.events[1].phase);
  });

  it("returns an event's data untouched", () => {
    const event = substrateEventAt(block, 1);

    expect(eventParams(event)).toBe(block.events[1].event.data);
  });
});
