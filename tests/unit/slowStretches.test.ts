import { parseSamples, slowStretches } from '../../scripts/lib/slowStretches';

/** One sample every 10 s, the height rising by each given step */
const samples = (steps: number[]) => {
  let height = 1000;
  return [
    { time: 0, height },
    ...steps.map((step, i) => ({ time: (i + 1) * 10, height: (height += step) })),
  ];
};

describe('slowStretches', () => {
  it('finds a stretch below the rate that lasts long enough', () => {
    // 100/s, then 2/s for 70 s, then 100/s again
    const run = samples([1000, 20, 20, 20, 20, 20, 20, 20, 1000]);

    expect(slowStretches(run, 50, 60)).toEqual([{ from: 2000, to: 2140, seconds: 70 }]);
  });

  it('ignores a slow stretch shorter than the minimum', () => {
    expect(slowStretches(samples([1000, 20, 20, 1000]), 50, 60)).toEqual([]);
  });

  it('closes a stretch still open at the last sample', () => {
    expect(slowStretches(samples([1000, 20, 20, 20, 20, 20, 20]), 50, 60)).toEqual([
      { from: 2000, to: 2120, seconds: 60 },
    ]);
  });

  it('counts a stall as slow', () => {
    expect(slowStretches(samples([0, 0, 0, 0, 0, 0]), 50, 60)).toEqual([
      { from: 1000, to: 1000, seconds: 60 },
    ]);
  });
});

describe('parseSamples', () => {
  it('reads time,height lines and skips anything else', () => {
    expect(parseSamples('time,height\n1700000000,25\n\n1700000010,525\nbad line\n')).toEqual([
      { time: 1700000000, height: 25 },
      { time: 1700000010, height: 525 },
    ]);
  });
});
