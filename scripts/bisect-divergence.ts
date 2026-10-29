/**
 * Finds the first block where one value in the index stops matching the chain, by bisection, and
 * prints that block's events. The tool to reach for once `check-state.ts` reports a difference:
 * run it between a height where the value matched and one where it didn't.
 *
 * Kinds, with the `--id` each takes:
 *   free, reserved    an account's POLYX, against `system.account`
 *   holding, nft      a portfolio's (`did/number`) amount or NFT count of `--asset`, against
 *                     `portfolio.portfolioAssetBalances` or `portfolio.portfolioNFT`
 *   account-holding   an account's amount of `--asset` (v8), against `asset.assetBalance`
 *   bonded            a stash's `AccountBalance.bonded`, against its `staking.ledger` `total`
 *
 * With `--chain-only` it reads no index: it finds the first block where the chain's value differs
 * from its value at `--from`, which answers "what changed this?" for any account or portfolio.
 * Before v7 assets are keyed by ticker; give `--ticker`, or it is read from the index.
 *
 *   DB_HOST=h DB_PORT=p DB_USER=u DB_PASS=p DB_DATABASE=d \
 *     yarn ts-node scripts/bisect-divergence.ts --rpc <archive node> --kind K --id ID
 *       [--asset A] [--ticker T] --from LO --to HI [--chain-only] [--schema public]
 */
import { ApiPromise } from '@polkadot/api';
import type { ApiDecoration } from '@polkadot/api/types';
import { Codec } from '@polkadot/types/types';
import { stringToU8a, u8aToHex } from '@polkadot/util';
import { DataSource } from 'typeorm';
import { getPostgresDataSource } from '../db/utils';
import { argOf, atHeight, blockEvents, connect, hasFlag } from './lib/chain';

const KINDS = ['free', 'reserved', 'holding', 'nft', 'account-holding', 'bonded'] as const;
type Kind = (typeof KINDS)[number];

interface Target {
  kind: Kind;
  id: string;
  asset?: string;
  ticker?: string;
}

/** Before v7 the chain keys an asset by its ticker: 12 bytes, padded with NULs */
const TICKER_KEYED_BEFORE = 7_000_000;

const tickerKey = (ticker: string): string => {
  const bytes = new Uint8Array(12);
  bytes.set(stringToU8a(ticker).subarray(0, 12));
  return u8aToHex(bytes);
};

const portfolioOf = (id: string) => {
  const [did, number] = id.split('/');
  return { did, kind: number === '0' ? 'Default' : { User: Number(number) } };
};

const assetKey = (target: Target, spec: number): string => {
  if (spec >= TICKER_KEYED_BEFORE) {
    return target.asset as string;
  }
  if (!target.ticker) {
    throw new Error(`block runs spec ${spec}, where assets are keyed by ticker: give --ticker`);
  }
  return tickerKey(target.ticker);
};

type Query = Record<string, Record<string, (...args: unknown[]) => Promise<Codec>>>;

/** The chain's value for `target` at `height`, as a decimal string */
const chainValue = async (api: ApiPromise, target: Target, height: number): Promise<string> => {
  const { at, spec } = await atHeight(api, height);
  const query = at.query as unknown as Query;

  switch (target.kind) {
    case 'free':
    case 'reserved': {
      const { data } = await at.query.system.account(target.id);
      return data[target.kind].toString();
    }
    case 'holding':
      return (
        await query.portfolio.portfolioAssetBalances(portfolioOf(target.id), assetKey(target, spec))
      ).toString();
    case 'nft':
      return String(await nftCount(at, target, spec));
    case 'account-holding':
      return query.asset.assetBalance
        ? (await query.asset.assetBalance(target.id, target.asset)).toString()
        : '0';
    case 'bonded': {
      const controller = (await at.query.staking.bonded(target.id)).unwrapOr(undefined);
      const ledger = (await at.query.staking.ledger(controller ?? target.id)).toJSON() as {
        total?: string | number;
      } | null;
      return BigInt(ledger?.total ?? 0).toString();
    }
  }
};

const nftCount = async (
  at: ApiDecoration<'promise'>,
  target: Target,
  spec: number
): Promise<number> => {
  const keys = await (
    at.query.portfolio as unknown as Record<
      string,
      { keys: (p: unknown) => Promise<{ args: Codec[] }[]> }
    >
  ).portfolioNFT.keys(portfolioOf(target.id));
  const asset = assetKey(target, spec);

  // `(portfolio, (asset, nftId))` before v8, `(portfolio, asset, nftId)` from it
  return keys.filter(({ args }) => {
    const key = args.length === 3 ? args[1] : (args[1] as unknown as Codec[])[0];
    return key.toHex() === asset;
  }).length;
};

/** The index's value for `target` as it stood after `height`, as a decimal string */
const indexValue = async (db: DataSource, target: Target, height: number): Promise<string> => {
  const read = async (sql: string, id: string): Promise<string> => {
    const [row]: { value: string | number | bigint | null }[] = await db.query(sql, [id, height]);
    return BigInt(String(row?.value ?? 0).replace(/n$/, '')).toString();
  };
  const at = '_block_range @> $2::int8';

  switch (target.kind) {
    case 'free':
    case 'reserved':
      return read(
        `SELECT ${target.kind} AS value FROM account_balances WHERE id = $1 AND ${at}`,
        target.id
      );
    case 'holding':
    case 'account-holding':
      return read(
        `SELECT amount AS value FROM holdings WHERE id = $1 AND ${at}`,
        `${target.asset}/${target.id}`
      );
    case 'nft':
      return read(
        `SELECT nft_count AS value FROM holdings WHERE id = $1 AND ${at}`,
        `${target.asset}/${target.id}`
      );
    case 'bonded':
      return read(
        `SELECT bonded AS value FROM account_balances WHERE id = $1 AND ${at}`,
        target.id
      );
  }
};

const usage = (): never => {
  console.error(
    `usage: bisect-divergence.ts --rpc <archive node> --kind ${KINDS.join('|')} --id ID ` +
      '[--asset A] [--ticker T] --from LO --to HI [--chain-only] [--schema s]'
  );
  return process.exit(2);
};

const targetOf = (): Target => {
  const kind = argOf('kind') as Kind | undefined;
  const id = argOf('id');
  if (!kind || !KINDS.includes(kind) || !id) {
    return usage();
  }
  const target: Target = { kind, id, asset: argOf('asset'), ticker: argOf('ticker') };
  if (['holding', 'nft', 'account-holding'].includes(kind) && !target.asset) {
    console.error(`--kind ${kind} needs --asset`);
    process.exit(2);
  }
  return target;
};

/** The index, with the target's ticker read from it when the target names an asset but no ticker */
const openIndex = async (target: Target): Promise<DataSource> => {
  const db = await getPostgresDataSource();
  await db.query(`SET search_path TO ${argOf('schema') ?? 'public'}`);
  if (target.asset && !target.ticker) {
    const [row]: { ticker: string | null }[] = await db.query(
      'SELECT ticker FROM assets WHERE id = $1 AND upper_inf(_block_range)',
      [target.asset]
    );
    target.ticker = row?.ticker ?? undefined;
  }
  return db;
};

/** The first height in `(lo, hi]` where `holds` stops, given it holds at `lo` and not at `hi` */
const bisect = async (
  lo: number,
  hi: number,
  holds: (height: number) => Promise<boolean>
): Promise<number> => {
  if (hi - lo <= 1) {
    return hi;
  }
  const mid = Math.floor((lo + hi) / 2);
  return (await holds(mid)) ? bisect(mid, hi, holds) : bisect(lo, mid, holds);
};

const main = async (): Promise<void> => {
  const rpc = argOf('rpc');
  const lo = Number(argOf('from'));
  const hi = Number(argOf('to'));
  if (!rpc || [lo, hi].some(Number.isNaN) || lo >= hi) {
    usage();
    return;
  }
  const target = targetOf();
  const chainOnly = hasFlag('chain-only');

  const api = await connect(rpc);
  const db = chainOnly ? undefined : await openIndex(target);
  const chainAt = (height: number) => chainValue(api, target, height);
  const indexAt = (height: number) => (db ? indexValue(db, target, height) : Promise.resolve('-'));

  const start = await chainAt(lo);
  /** Whether the value at `height` is still as it was: matching the index, or unchanged on chain */
  const holds = async (height: number): Promise<boolean> => {
    const chain = await chainAt(height);
    return db ? chain === (await indexAt(height)) : chain === start;
  };

  if (!(await holds(lo))) {
    console.log(`already differs at ${lo}: index ${await indexAt(lo)}, chain ${start}`);
    process.exit(1);
  }
  if (await holds(hi)) {
    console.log(chainOnly ? `unchanged through ${hi}: ${start}` : `matches at ${hi} too`);
    process.exit(0);
  }

  const found = await bisect(lo, hi, holds);
  const [before, after] = await Promise.all([chainAt(found - 1), chainAt(found)]);
  const indexed = db ? `index ${await indexAt(found - 1)} -> ${await indexAt(found)}, ` : '';
  console.log(
    `first ${
      chainOnly ? 'change' : 'divergence'
    } at block ${found}: ${indexed}chain ${before} -> ${after}`
  );
  (await blockEvents(api, found)).forEach(line => console.log(line));

  await api.disconnect();
  await db?.destroy();
};

main().catch(e => {
  console.error(e);
  process.exit(2);
});
