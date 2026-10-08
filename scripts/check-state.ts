/**
 * Compares the whole index with chain state at one block: every POLYX balance and every asset
 * holding, not a sample. A sync is signed off when this reports nothing.
 *
 * POLYX, for every account:
 *   1. `AccountBalance` `free`, `reserved` and `frozen` equal `system.account`;
 *   2. the seeded opening balance plus `SUM(PolyxEntry.amount)` per pool equals `free` and
 *      `reserved`, so the entries account for the balance;
 *   3. every account the chain holds a balance for has a row.
 *
 * Holdings, for every holder:
 *   4. each portfolio's fungible `Holding.amount` equals `portfolio.portfolioAssetBalances`, and
 *      from v8 each account's equals `asset.assetBalance`;
 *   5. each portfolio's `Holding.nftCount` equals its count in `portfolio.portfolioNFT`.
 *
 * The index is read as it stood after `--block` (its historical rows), and the chain at that block,
 * so it can be run against a database still syncing. The block defaults to the last one the index
 * processed.
 *
 *   DB_HOST=h DB_PORT=p DB_USER=u DB_PASS=p DB_DATABASE=d \
 *     yarn ts-node scripts/check-state.ts --rpc <archive node> [--block N] [--schema public] [--show 20]
 *
 * Exits non-zero when anything differs.
 */
import '@polkadot/types-augment';
import '@polymeshassociation/polymesh-types/polkadot/types-lookup';
import '@polymeshassociation/polymesh-types/polkadot/augment-api';
import { ApiPromise, WsProvider } from '@polkadot/api';
import type { ApiDecoration } from '@polkadot/api/types';
import { Codec } from '@polkadot/types/types';
import { hexStripPrefix, stringToHex, u8aToHex } from '@polkadot/util';
import { blake2AsU8a } from '@polkadot/util-crypto';
import { DataSource } from 'typeorm';
import { getPostgresDataSource } from '../db/utils';
import chainTypes from '../src/chainTypes';

const SEED_EVENT_ID = '0000000000/0000000000';
/** The staging chain migrated legacy tickers to asset ids without the RFC 4122 bits. */
const STAGING_GENESIS = '0x3c3183f6d701500766ff7d147b79c4f10014a095eaaa98e960dcef6b3ead50ee';

const padId = (n: number | string): string => String(n).padStart(10, '0');

const argOf = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const big = (value?: { toString(): string } | string | number | null): bigint =>
  BigInt(value?.toString() ?? '0');

interface Difference {
  check: string;
  id: string;
  index: string;
  chain: string;
}

/** Records a difference, if there is one, under `check`. */
const differ = (
  out: Difference[],
  check: string,
  id: string,
  index: bigint | number | undefined,
  chain: bigint | number | undefined
): void => {
  if (String(index ?? 0) !== String(chain ?? 0)) {
    out.push({ check, id, index: String(index ?? 'none'), chain: String(chain ?? 'none') });
  }
};

// ---------------------------------------------------------------------------------------------
// The index, as it stood after the block
// ---------------------------------------------------------------------------------------------

const lastProcessedHeight = async (db: DataSource): Promise<number> => {
  const [row]: { value: unknown }[] = await db.query(
    `SELECT value FROM _metadata WHERE key = 'lastProcessedHeight'`
  );

  if (!row) {
    throw new Error('the index has no lastProcessedHeight; pass --block');
  }

  return Number(row.value);
};

interface IndexedBalance {
  free: bigint;
  reserved: bigint;
  frozen: bigint;
}

const indexedBalances = async (db: DataSource, block: number) => {
  const rows: { id: string; free: string; reserved: string; frozen: string }[] = await db.query(
    `SELECT id, free, reserved, frozen FROM account_balances WHERE _block_range @> $1::int8`,
    [block]
  );

  return new Map<string, IndexedBalance>(
    rows.map(row => [
      row.id,
      { free: big(row.free), reserved: big(row.reserved), frozen: big(row.frozen) },
    ])
  );
};

/** Each account's seeded opening balance plus its entries, per pool, up to the block. */
const entrySums = async (db: DataSource, block: number) => {
  // a relabelled entry has several versions; only the one live at the block counts
  const sums: { account_id: string; pool: string; s: string }[] = await db.query(
    `SELECT account_id, pool, sum(amount) AS s FROM polyx_entries
       WHERE block_id <= $1 AND _block_range @> $2::int8
       GROUP BY account_id, pool`,
    [padId(block), block]
  );
  const seeds: { id: string; free: string; reserved: string }[] = await db.query(
    `SELECT DISTINCT ON (id) id, free, reserved FROM account_balances
       WHERE updated_event_id = $1 AND lower(_block_range) <= $2
       ORDER BY id, lower(_block_range)`,
    [SEED_EVENT_ID, block]
  );

  const totals = new Map<string, { free: bigint; reserved: bigint }>();
  const of = (id: string) => {
    const total = totals.get(id) ?? { free: BigInt(0), reserved: BigInt(0) };
    totals.set(id, total);
    return total;
  };

  seeds.forEach(seed => {
    of(seed.id).free += big(seed.free);
    of(seed.id).reserved += big(seed.reserved);
  });
  sums.forEach(sum => {
    if (sum.pool === 'Free') {
      of(sum.account_id).free += big(sum.s);
    } else {
      of(sum.account_id).reserved += big(sum.s);
    }
  });

  return totals;
};

const indexedHoldings = async (db: DataSource, block: number) => {
  const rows: { id: string; amount: string; nft_count: number }[] = await db.query(
    `SELECT id, amount, nft_count FROM holdings
       WHERE _block_range @> $1::int8 AND (amount <> 0 OR nft_count <> 0)`,
    [block]
  );

  return new Map(rows.map(row => [row.id, { amount: big(row.amount), nfts: row.nft_count }]));
};

// ---------------------------------------------------------------------------------------------
// The chain, at the block
// ---------------------------------------------------------------------------------------------

/** `frozen` from an `AccountData`: `frozen` from v8, the larger of `miscFrozen`/`feeFrozen` before. */
const chainFrozen = (data: Record<string, Codec>): bigint => {
  if (data.frozen !== undefined) {
    return big(data.frozen);
  }

  const misc = big(data.miscFrozen);
  const fee = big(data.feeFrozen);
  return misc > fee ? misc : fee;
};

const chainBalances = async (at: ApiDecoration<'promise'>) => {
  const entries = await at.query.system.account.entries();

  return new Map<string, IndexedBalance>(
    entries.map(([key, info]) => {
      const data = info.data as unknown as Record<string, Codec>;
      return [
        key.args[0].toString(),
        { free: big(data.free), reserved: big(data.reserved), frozen: chainFrozen(data) },
      ];
    })
  );
};

/** The index's asset id for a storage key: an `AssetId` from v7, a `Ticker` before. */
const assetIdOf = (raw: Codec, staging: boolean): string => {
  const hex = raw.toHex();

  if (hexStripPrefix(hex).length === 32) {
    return hex;
  }

  // the same derivation as `getAssetIdForLegacyTicker`
  const bytes = blake2AsU8a(
    `0x${hexStripPrefix(stringToHex('legacy_ticker'))}${hexStripPrefix(hex)}`,
    128
  );
  if (!staging) {
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
  }
  return u8aToHex(bytes);
};

/** `did/number` for a `PortfolioId`, as the index ids a portfolio. */
const portfolioIdOf = (raw: Codec): string => {
  const { did, kind } = raw.toJSON() as { did: string; kind: string | { user?: number } };
  const number = typeof kind === 'object' && kind?.user !== undefined ? kind.user : 0;

  return `${did}/${number}`;
};

const chainHoldings = async (at: ApiDecoration<'promise'>, staging: boolean) => {
  const amounts = new Map<string, bigint>();
  const nfts = new Map<string, number>();

  // `.entries()` is typed to want the first key of a double map; none scans the whole map
  const fungible = await (
    at.query.portfolio.portfolioAssetBalances.entries as unknown as () => Promise<
      [{ args: Codec[] }, Codec][]
    >
  )();
  fungible.forEach(([key, value]) => {
    const [portfolio, asset] = key.args;
    if (big(value) !== BigInt(0)) {
      amounts.set(`${assetIdOf(asset, staging)}/${portfolioIdOf(portfolio)}`, big(value));
    }
  });

  // v8 holds assets in accounts too
  const assetBalance = (
    at.query.asset as unknown as Record<
      string,
      { entries?: () => Promise<[{ args: Codec[] }, Codec][]> }
    >
  ).assetBalance;
  if (assetBalance?.entries) {
    (await assetBalance.entries()).forEach(([key, value]) => {
      const [account, asset] = key.args;
      if (big(value) !== BigInt(0)) {
        amounts.set(`${assetIdOf(asset, staging)}/${account.toString()}`, big(value));
      }
    });
  }

  const portfolioNft = (
    at.query.portfolio as unknown as Record<
      string,
      { entries?: () => Promise<[{ args: Codec[] }, Codec][]> }
    >
  ).portfolioNFT;
  if (portfolioNft?.entries) {
    (await portfolioNft.entries()).forEach(([key]) => {
      const [portfolio, assetAndNft] = key.args;
      const [asset] = assetAndNft as unknown as Codec[];
      const id = `${assetIdOf(asset, staging)}/${portfolioIdOf(portfolio)}`;
      nfts.set(id, (nfts.get(id) ?? 0) + 1);
    });
  }

  return { amounts, nfts };
};

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

const checkPolyx = async (db: DataSource, at: ApiDecoration<'promise'>, block: number) => {
  const out: Difference[] = [];
  const [indexed, sums, chain] = await Promise.all([
    indexedBalances(db, block),
    entrySums(db, block),
    chainBalances(at),
  ]);

  indexed.forEach((balance, id) => {
    const onChain = chain.get(id);
    differ(out, '1 free', id, balance.free, onChain?.free);
    differ(out, '1 reserved', id, balance.reserved, onChain?.reserved);
    differ(out, '1 frozen', id, balance.frozen, onChain?.frozen);

    const sum = sums.get(id);
    differ(out, '2 free = seed + entries', id, balance.free, sum?.free);
    differ(out, '2 reserved = seed + entries', id, balance.reserved, sum?.reserved);
  });

  chain.forEach((balance, id) => {
    if (!indexed.has(id) && balance.free + balance.reserved > BigInt(0)) {
      differ(out, '3 funded account has no row', id, undefined, balance.free + balance.reserved);
    }
  });

  return { out, accounts: indexed.size };
};

const checkHoldings = async (
  db: DataSource,
  at: ApiDecoration<'promise'>,
  block: number,
  staging: boolean
) => {
  const out: Difference[] = [];
  const [indexed, chain] = await Promise.all([
    indexedHoldings(db, block),
    chainHoldings(at, staging),
  ]);

  new Set([...indexed.keys(), ...chain.amounts.keys()]).forEach(id =>
    differ(out, '4 holding amount', id, indexed.get(id)?.amount, chain.amounts.get(id))
  );
  new Set([
    ...chain.nfts.keys(),
    ...[...indexed].filter(([, row]) => row.nfts).map(([id]) => id),
  ]).forEach(id =>
    differ(out, '5 holding nftCount', id, indexed.get(id)?.nfts, chain.nfts.get(id))
  );

  return { out, holdings: indexed.size };
};

const main = async (): Promise<void> => {
  const rpc = argOf('rpc');
  if (!rpc) {
    console.error('usage: check-state.ts --rpc <archive node> [--block N] [--schema s] [--show n]');
    process.exit(2);
  }

  const db = await getPostgresDataSource();
  await db.query(`SET search_path TO ${argOf('schema') ?? 'public'}`);
  const block = Number(argOf('block') ?? (await lastProcessedHeight(db)));
  const show = Number(argOf('show') ?? 20);

  // the chain types the indexer is built with, for blocks before metadata v14
  const api = await ApiPromise.create({
    provider: new WsProvider(rpc),
    noInitWarn: true,
    types: chainTypes.types as never,
  });
  const at = await api.at(await api.rpc.chain.getBlockHash(block));
  const staging = api.genesisHash.toHex() === STAGING_GENESIS;

  console.log(`Comparing the index with chain state at block ${block}`);

  const polyx = await checkPolyx(db, at, block);
  const holdings = await checkHoldings(db, at, block, staging);
  const differences = [...polyx.out, ...holdings.out];

  console.log(`${polyx.accounts} balances and ${holdings.holdings} holdings checked`);

  const byCheck = new Map<string, Difference[]>();
  differences.forEach(d => byCheck.set(d.check, [...(byCheck.get(d.check) ?? []), d]));
  [...byCheck].sort().forEach(([check, rows]) => {
    console.log(`\n${check}: ${rows.length}`);
    rows.slice(0, show).forEach(d => console.log(`  ${d.id}  index ${d.index}  chain ${d.chain}`));
  });

  console.log(
    differences.length === 0 ? '\nNo differences.' : `\n${differences.length} differences.`
  );

  await api.disconnect();
  await db.destroy();
  process.exit(differences.length === 0 ? 0 : 1);
};

main().catch(e => {
  console.error(e);
  process.exit(2);
});
