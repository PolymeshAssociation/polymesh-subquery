export interface HeightSample {
  /** seconds since the epoch */
  time: number;
  /** the indexer's height at that time */
  height: number;
}

export interface SlowStretch {
  from: number;
  to: number;
  seconds: number;
}

/**
 * The stretches where the height rose slower than `maxRate` blocks a second, lasting at least
 * `minSeconds`. Each stretch runs from the height where the slow intervals started to the height
 * where they ended.
 */
export const slowStretches = (
  samples: HeightSample[],
  maxRate: number,
  minSeconds: number
): SlowStretch[] => {
  const stretches: SlowStretch[] = [];
  let open: { from: number; start: number; to: number; end: number } | undefined;

  const close = () => {
    if (open && open.end - open.start >= minSeconds) {
      stretches.push({ from: open.from, to: open.to, seconds: open.end - open.start });
    }
    open = undefined;
  };

  samples.slice(1).forEach((sample, index) => {
    const previous = samples[index];
    const elapsed = Math.max(sample.time - previous.time, 1);
    const rate = (sample.height - previous.height) / elapsed;

    if (rate >= maxRate) {
      close();
      return;
    }
    open ??= { from: previous.height, start: previous.time, to: sample.height, end: sample.time };
    open.to = sample.height;
    open.end = sample.time;
  });
  close();

  return stretches;
};

/** `time,height` lines, as the dev server's height sampler writes them */
export const parseSamples = (text: string): HeightSample[] =>
  text
    .split('\n')
    .map(line => line.trim().split(','))
    .filter(([time, height]) => /^\d+$/.test(time ?? '') && /^\d+$/.test(height ?? ''))
    .map(([time, height]) => ({ time: Number(time), height: Number(height) }));
