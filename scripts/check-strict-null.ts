/**
 * The `strictNullChecks` ratchet.
 *
 * The project compiles non-strict, and turning `strictNullChecks` on at once is a few hundred errors
 * across dozens of files. So it lands one file at a time instead, and this keeps the count moving
 * one way: it compiles with the flag on, counts the errors in each file, and fails if any file has
 * more than `strict-null-baseline.json` records — or a file not listed there has any at all. A file
 * that now has fewer is reported so the baseline can be lowered to lock the improvement in; a file
 * that reaches zero drops out of the baseline and from then on may never regress.
 *
 * What this protects is the case the non-strict build cannot see: assigning `T | undefined` to a
 * non-null column compiles clean, and fails as a rejected insert that takes the block down.
 *
 * Usage:
 *
 *   yarn check-strict-null            fail on any increase
 *   yarn check-strict-null --update   rewrite the baseline to the current counts
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const BASELINE = join(ROOT, 'strict-null-baseline.json');

export const countErrors = (output: string): Record<string, number> => {
  const counts: Record<string, number> = {};

  for (const line of output.split('\n')) {
    const match = /^(.+?)\(\d+,\d+\): error TS\d+:/.exec(line.trim());

    if (match) {
      const file = relative(ROOT, join(ROOT, match[1])).split('\\').join('/');
      counts[file] = (counts[file] ?? 0) + 1;
    }
  }

  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
};

export const compare = (
  baseline: Record<string, number>,
  current: Record<string, number>
): { worse: string[]; better: string[] } => {
  const worse = Object.entries(current)
    .filter(([file, count]) => count > (baseline[file] ?? 0))
    .map(([file, count]) => `${file}: ${baseline[file] ?? 0} → ${count}`);
  const better = Object.entries(baseline)
    .filter(([file, count]) => (current[file] ?? 0) < count)
    .map(([file, count]) => `${file}: ${count} → ${current[file] ?? 0}`);

  return { worse, better };
};

const main = (): number => {
  const tsc = spawnSync(
    join(ROOT, 'node_modules', '.bin', 'tsc'),
    ['--noEmit', '-p', 'tsconfig.json', '--strictNullChecks'],
    { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }
  );
  const current = countErrors(`${tsc.stdout}\n${tsc.stderr}`);
  const total = Object.values(current).reduce((sum, count) => sum + count, 0);

  if (process.argv.includes('--update')) {
    writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`Baseline written: ${total} errors across ${Object.keys(current).length} files`);

    return 0;
  }

  const baseline = JSON.parse(readFileSync(BASELINE, 'utf-8')) as Record<string, number>;
  const { worse, better } = compare(baseline, current);

  console.log(`strictNullChecks: ${total} errors across ${Object.keys(current).length} files`);

  if (better.length) {
    console.log(
      `\nImproved — lower the baseline with --update to keep it:\n  ${better.join('\n  ')}`
    );
  }

  if (worse.length) {
    console.error(
      `\nMore strictNullChecks errors than the baseline allows:\n  ${worse.join('\n  ')}`
    );

    return 1;
  }

  return 0;
};

if (require.main === module) {
  process.exit(main());
}
