/**
 * The POLYX reconciliation harness (decision D11) — the acceptance gate for the POLYX ledger.
 *
 * The in-flight reconciliation in `src/mappings/entities/identities/reconcilePolyx.ts` only ever
 * compares at the block being indexed, so it cannot answer "is the history right". This script
 * does, offline, against a synced local database and a public archive RPC.
 *
 * Method (docs/implementation/02-polyx-ledger.md §"The reconciliation harness"):
 *
 *   1. Sample accounts, stratified by activity, oversampling every account that appears in a
 *      `BalanceSet`, `DustLost`, `Slashed` or pre-v8 `StakingReward` entry — that is where the
 *      known accounting gaps live.
 *   2. Compare at spec-version boundary blocks: one before and one after each of 5_000_000,
 *      6_000_000, 7_000_000, 7_003_000, 7_004_001 and 8_000_000. A drift that appears on only one
 *      side of a boundary names the runtime that caused it.
 *   3. Compare `free`, `reserved` and `frozen` INDEPENDENTLY — comparing only the total lets a
 *      pair of offsetting pool-mapping errors cancel out and pass.
 *   4. Classify every mismatch. A drift constant from a block is one missed event; a drift that
 *      grows is a systematically mis-signed one; a drift confined to `reserved` is a pool-mapping
 *      error. The taxonomy is the output — a count is not actionable.
 *
 * Resumable: progress is checkpointed to `.reconcile-polyx.checkpoint.json`, so a rate-limited
 * public endpoint can be worked through across several runs.
 *
 * Usage (from the repo root, against a synced DB):
 *
 *   DB_HOST=h DB_PORT=p DB_USER=u DB_PASS=p DB_DATABASE=d \
 *     yarn ts-node scripts/reconcile-polyx.ts \
 *       --rpc wss://mainnet-rpc.polymesh.network \
 *       [--sample 80] [--high 30] [--typical 30] [--reset]
 */
import { ApiPromise, WsProvider } from '@polkadot/api';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { getPostgresDataSource } from '../db/utils';

const CHECKPOINT = join(__dirname, '..', '.reconcile-polyx.checkpoint.json');
const PAD = 10;
const padId = (n: number | string): string => String(n).padStart(PAD, '0');

/** Spec-version boundaries on the public chain's scale, one comparison block on each side. */
const BOUNDARIES = [5_000_000, 6_000_000, 7_000_000, 7_003_000, 7_004_001, 8_000_000];

const argOf = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);

  return i >= 0 ? process.argv[i + 1] : fallback;
};

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

// ---------------------------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------------------------

interface Sample {
  address: string;
  reason: 'high-traffic' | 'typical' | 'balance-set' | 'dust-lost' | 'slashed' | 'legacy-reward';
}

const oversampledKinds: Array<[Sample['reason'], string]> = [
  ['balance-set', 'BalanceSetAdjustment'],
  ['dust-lost', 'DustLost'],
  ['slashed', 'Slash'],
];

const sampleAccounts = async (
  db: DataSource,
  { high, typical }: { high: number; typical: number }
): Promise<Sample[]> => {
  const byReason = new Map<string, Sample>();
  const add = (address: string, reason: Sample['reason']) => {
    if (!byReason.has(address)) {
      byReason.set(address, { address, reason });
    }
  };

  const ranked: Array<{ account_id: string; n: string }> = await db.query(
    `SELECT account_id, count(*) AS n FROM polyx_entries GROUP BY account_id ORDER BY n DESC LIMIT $1`,
    [high + typical * 4]
  );

  ranked.slice(0, high).forEach(r => add(r.account_id, 'high-traffic'));
  ranked
    .slice(high)
    .filter((_, i) => i % 4 === 0)
    .slice(0, typical)
    .forEach(r => add(r.account_id, 'typical'));

  for (const [reason, kind] of oversampledKinds) {
    const rows: Array<{ account_id: string }> = await db.query(
      `SELECT DISTINCT account_id FROM polyx_entries WHERE kind = $1 LIMIT 200`,
      [kind]
    );
    rows.forEach(r => add(r.account_id, reason));
  }

  const legacyRewards: Array<{ account_id: string }> = await db.query(
    `SELECT DISTINCT account_id FROM polyx_entries
       WHERE kind = 'StakingReward' AND spec_version_id < 8000000 LIMIT 200`
  );
  legacyRewards.forEach(r => add(r.account_id, 'legacy-reward'));

  return [...byReason.values()];
};

// ---------------------------------------------------------------------------------------------
// Derived vs on-chain
// ---------------------------------------------------------------------------------------------

interface Triple {
  free: bigint;
  reserved: bigint;
  frozen: bigint;
}

const zero: Triple = { free: BigInt(0), reserved: BigInt(0), frozen: BigInt(0) };

/** Derived balance at block N: the historical `account_balance` row whose range covers N. */
const derivedAt = async (db: DataSource, address: string, block: number): Promise<Triple> => {
  const [row]: Array<{ free: string; reserved: string; frozen: string }> = await db.query(
    `SELECT free, reserved, frozen FROM account_balance
       WHERE id = $1 AND _block_range @> $2::int8 LIMIT 1`,
    [address, block]
  );

  if (!row) {
    return zero;
  }

  return { free: BigInt(row.free), reserved: BigInt(row.reserved), frozen: BigInt(row.frozen) };
};

/** The independent second mechanism: SUM(PolyxEntry.amount) by pool up to block N. */
const summedAt = async (
  db: DataSource,
  address: string,
  block: number
): Promise<{ free: bigint; reserved: bigint }> => {
  const rows: Array<{ pool: string; s: string }> = await db.query(
    `SELECT pool, COALESCE(sum(amount), 0) AS s FROM polyx_entries
       WHERE account_id = $1 AND created_block_id <= $2 GROUP BY pool`,
    [address, padId(block)]
  );

  const map = new Map(rows.map(r => [r.pool, BigInt(r.s)]));

  return { free: map.get('Free') ?? BigInt(0), reserved: map.get('Reserved') ?? BigInt(0) };
};

const chainAt = async (api: ApiPromise, address: string, block: number): Promise<Triple> => {
  const hash = await api.rpc.chain.getBlockHash(block);
  const at = await api.at(hash);
  const info = (await at.query.system.account(address)) as unknown as {
    data: Record<string, { toString(): string }>;
  };
  const d = info.data;
  const big = (v?: { toString(): string }) => BigInt(v?.toString() ?? '0');
  const misc = big(d.miscFrozen);
  const fee = big(d.feeFrozen);

  return {
    free: big(d.free),
    reserved: big(d.reserved),
    frozen: d.frozen !== undefined ? big(d.frozen) : misc > fee ? misc : fee,
  };
};

// ---------------------------------------------------------------------------------------------
// Comparison and taxonomy
// ---------------------------------------------------------------------------------------------

type Field = 'free' | 'reserved' | 'frozen';

interface Mismatch {
  address: string;
  reason: Sample['reason'];
  block: number;
  boundary: number;
  side: 'before' | 'after';
  field: Field;
  derived: bigint;
  onChain: bigint;
  delta: bigint;
  summedDisagreesWithBalance: boolean;
}

const compare = (
  sample: Sample,
  boundary: number,
  side: 'before' | 'after',
  block: number,
  derived: Triple,
  onChain: Triple,
  summed: { free: bigint; reserved: bigint }
): Mismatch[] => {
  const out: Mismatch[] = [];

  (['free', 'reserved', 'frozen'] as Field[]).forEach(field => {
    if (derived[field] === onChain[field]) {
      return;
    }

    out.push({
      address: sample.address,
      reason: sample.reason,
      block,
      boundary,
      side,
      field,
      derived: derived[field],
      onChain: onChain[field],
      delta: derived[field] - onChain[field],
      summedDisagreesWithBalance:
        field !== 'frozen' && summed[field as 'free' | 'reserved'] !== derived[field],
    });
  });

  return out;
};

const classify = (mismatches: Mismatch[]): string => {
  if (mismatches.length === 0) {
    return 'no unexplained mismatches across the sample';
  }

  const byAccountField = new Map<string, Mismatch[]>();
  mismatches.forEach(m => {
    const key = `${m.address}|${m.field}`;
    const group = byAccountField.get(key) ?? [];
    group.push(m);
    byAccountField.set(key, group);
  });

  const lines: string[] = [];

  for (const [key, group] of byAccountField) {
    const sorted = [...group].sort((a, b) => a.block - b.block);
    const deltas = sorted.map(m => m.delta);
    const constant = deltas.every(d => d === deltas[0]);
    const growing =
      deltas.length > 1 &&
      deltas.every((d, i) => i === 0 || d > deltas[i - 1] === deltas[1] > deltas[0]);
    const [address, field] = key.split('|');
    const firstDrift = sorted[0];

    let verdict: string;
    if (constant) {
      verdict = `constant drift of ${deltas[0]} from block ${firstDrift.block} — one missed event`;
    } else if (growing) {
      verdict = `growing drift (${deltas[0]} → ${
        deltas[deltas.length - 1]
      }) — a systematically mis-signed event`;
    } else {
      verdict = `irregular drift — needs manual inspection`;
    }

    if (field === 'reserved' && !sorted.some(m => m.field !== 'reserved')) {
      verdict += '; confined to `reserved` — a pool-mapping error';
    }
    if (sorted.some(m => m.summedDisagreesWithBalance)) {
      verdict += '; SUM(entries) also disagrees with AccountBalance — the two mechanisms diverged';
    }

    lines.push(`  ${address} [${field}] (${firstDrift.reason}): ${verdict}`);
  }

  return `${mismatches.length} field-mismatches:\n${lines.join('\n')}`;
};

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

interface Checkpoint {
  rpc: string;
  done: string[];
  mismatches: Mismatch[];
}

const loadCheckpoint = (rpc: string): Checkpoint => {
  if (hasFlag('reset') || !existsSync(CHECKPOINT)) {
    return { rpc, done: [], mismatches: [] };
  }

  const cp = JSON.parse(readFileSync(CHECKPOINT, 'utf-8'), (_k, v) =>
    typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v
  ) as Checkpoint;

  return cp.rpc === rpc ? cp : { rpc, done: [], mismatches: [] };
};

const saveCheckpoint = (cp: Checkpoint): void =>
  writeFileSync(
    CHECKPOINT,
    JSON.stringify(cp, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v), 2)
  );

const main = async (): Promise<void> => {
  const rpc = argOf('rpc');
  if (!rpc) {
    console.error('Pass --rpc <ws url> (public archive endpoint)');
    process.exit(1);
  }

  const high = Number(argOf('high', '30'));
  const typical = Number(argOf('typical', '30'));

  const db = await getPostgresDataSource();
  const api = await ApiPromise.create({ provider: new WsProvider(rpc), noInitWarn: true });
  const head = (await api.rpc.chain.getHeader()).number.toNumber();

  const checkpoint = loadCheckpoint(rpc);
  const done = new Set(checkpoint.done);

  const samples = await sampleAccounts(db, { high, typical });
  console.log(
    `Sampled ${samples.length} accounts; comparing at ${BOUNDARIES.length * 2} boundary blocks each`
  );

  for (const sample of samples) {
    for (const boundary of BOUNDARIES) {
      for (const [side, block] of [
        ['before', boundary - 1],
        ['after', boundary + 1],
      ] as const) {
        if (block > head) {
          continue;
        }

        const key = `${sample.address}|${boundary}|${side}`;
        if (done.has(key)) {
          continue;
        }

        try {
          const [derived, summed, onChain] = await Promise.all([
            derivedAt(db, sample.address, block),
            summedAt(db, sample.address, block),
            chainAt(api, sample.address, block),
          ]);

          checkpoint.mismatches.push(
            ...compare(sample, boundary, side, block, derived, onChain, summed)
          );
        } catch (e) {
          console.warn(`skip ${key}: ${(e as Error).message}`);
        }

        done.add(key);
        checkpoint.done = [...done];
        saveCheckpoint(checkpoint);
      }
    }
  }

  await api.disconnect();
  await db.destroy();

  console.log('\n=== POLYX reconciliation taxonomy ===');
  console.log(classify(checkpoint.mismatches));
};

main().catch(e => {
  console.error(e);
  process.exit(1);
});
