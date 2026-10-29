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
 *   5. each portfolio's `Holding.nftCount` equals its count in `portfolio.portfolioNFT`, and each
 *      account's (v8, and v7.4's `AccountId` portfolios) its entries in `nft.nftHolder`.
 *
 * Staking, for every stash:
 *   6. each `StakingPosition`'s `bonded` equals its `staking.ledger` `active`, its `unbonding`
 *      equals `total - active`, and its controller equals `staking.bonded`; every stash with a
 *      ledger has a position.
 *
 * Locks and holds, for every account:
 *   7. each lock in `AccountBalance.locks` equals `balances.locks` by id, each hold in `holds`
 *      equals `balances.holds` by reason (from v8, read raw, so testnet's undecodable `contracts`
 *      holds count as `Unknown`), and `otherReserved` is `reserved` less the `Staking` hold.
 *
 * Assets, for every asset:
 *   8. `Asset.totalSupply` equals the chain's (`asset.assets`, or `asset.tokens` before v7; an NFT
 *      collection's, the NFTs its holders hold); each identity's `AssetHolder.amount`
 *      equals `asset.balanceOf`; and `holderCount` equals the identities with a balance, or for a
 *      collection with any of its NFTs.
 *
 * Settlement, for every instruction still open on chain (created, locked or failed):
 *   9. the instruction is still open on chain; each holder's approval row is `Affirmed` exactly
 *      when `settlement.affirmsReceived` holds it as affirmed, and each mediator's when
 *      `settlement.instructionMediatorsAffirmations` does; and every holder the chain holds as
 *      affirmed has a row. And every instruction the index holds as executed or rejected is closed
 *      on chain too.
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
import { DataSource } from 'typeorm';
import { getPostgresDataSource } from '../db/utils';
import chainTypes from '../src/chainTypes';
import { chainHolds, chainLocks } from './lib/balanceParts';
import { chainApprovals, chainStatuses, compareApprovals, compareClosed } from './lib/approvals';
import { assetIdOf, chainSupplies, identitiesOf } from './lib/chainAssets';

const SEED_EVENT_ID = '0000000000/0000000000';
/** The staging chain migrated legacy tickers to asset ids without the RFC 4122 bits. */
const STAGING_GENESIS = '0x3c3183f6d701500766ff7d147b79c4f10014a095eaaa98e960dcef6b3ead50ee';

const padId = (n: number | string): string => String(n).padStart(10, '0');

/** Code-unit order, as a plain `sort()` gives */
const byCodeUnit = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

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

// The index, as it stood after the block

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
  const rows: { id: string; amount: string; nft_count: number; holder_kind: string }[] =
    await db.query(
      `SELECT id, amount, nft_count, holder_kind FROM holdings
         WHERE _block_range @> $1::int8 AND (amount <> 0 OR nft_count <> 0)`,
      [block]
    );

  return new Map(
    rows.map(row => [
      row.id,
      { amount: big(row.amount), nfts: row.nft_count, portfolio: row.holder_kind === 'Portfolio' },
    ])
  );
};

// The chain, at the block

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

/**
 * The holder part of a holding's id for a `PortfolioId`: `did/number`, or for v7.4's `AccountId`
 * kind the account, which the index holds as an account holding.
 */
const portfolioIdOf = (raw: Codec): string => {
  const { did, kind } = raw.toJSON() as {
    did: string;
    kind: string | { user?: number; accountId?: string };
  };
  if (typeof kind === 'object' && kind?.accountId) {
    return kind.accountId;
  }
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
      // `(portfolio, (asset, nftId))` before v8, `(portfolio, asset, nftId)` from it
      const [portfolio, second] = key.args;
      const asset = key.args.length === 3 ? second : (second as unknown as Codec[])[0];
      const id = `${assetIdOf(asset, staging)}/${portfolioIdOf(portfolio)}`;
      nfts.set(id, (nfts.get(id) ?? 0) + 1);
    });
  }

  // NFTs held by accounts (v8, and v7.4's `AccountId` portfolios), one `nft.nftHolder` entry each
  const holders = (
    at.query.nft as unknown as
      | Record<string, { entries?: () => Promise<[{ args: Codec[] }, Codec][]> }>
      | undefined
  )?.nftHolder;
  if (holders?.entries) {
    (await holders.entries()).forEach(([key, status]) => {
      if (status.toString() === 'NotOwned') {
        return;
      }
      // `(account, (asset, nftId))` on testnet's v7.4 and v8.0, `(account, asset, nftId)` in v8.1
      const [account, second] = key.args;
      const asset = key.args.length === 3 ? second : (second as unknown as Codec[])[0];
      const id = `${assetIdOf(asset, staging)}/${account.toString()}`;
      nfts.set(id, (nfts.get(id) ?? 0) + 1);
    });
  }

  return { amounts, nfts };
};

interface Position {
  bonded: bigint;
  unbonding: bigint;
  controller?: string;
}

const indexedPositions = async (db: DataSource, block: number) => {
  const rows: { id: string; bonded: string; unbonding: string; controller_id: string | null }[] =
    await db.query(
      `SELECT id, bonded, unbonding, controller_id FROM staking_positions
        WHERE _block_range @> $1::int8`,
      [block]
    );

  return new Map<string, Position>(
    rows.map(row => [
      row.id,
      {
        bonded: big(row.bonded),
        unbonding: big(row.unbonding),
        controller: row.controller_id ?? undefined,
      },
    ])
  );
};

/** Every stash's ledger, keyed by the stash it names, and every stash's controller. */
const chainPositions = async (at: ApiDecoration<'promise'>) => {
  const [ledgers, bonded] = await Promise.all([
    at.query.staking.ledger.entries(),
    at.query.staking.bonded.entries(),
  ]);

  const positions = new Map<string, Position>();
  ledgers.forEach(([, raw]) => {
    const ledger = raw.toJSON() as {
      stash?: string;
      total?: string | number;
      active?: string | number;
    } | null;
    if (ledger?.stash) {
      const active = big(ledger.active);
      positions.set(ledger.stash, { bonded: active, unbonding: big(ledger.total) - active });
    }
  });

  const controllers = new Map<string, string>(
    bonded.map(([key, controller]) => [key.args[0].toString(), controller.toString()])
  );

  return { positions, controllers };
};

// Runner

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

  return { out, accounts: indexed.size, chain };
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

  return { out, holdings: indexed.size, chain };
};

const checkStaking = async (db: DataSource, at: ApiDecoration<'promise'>, block: number) => {
  const out: Difference[] = [];
  const [indexed, chain] = await Promise.all([indexedPositions(db, block), chainPositions(at)]);

  indexed.forEach((position, stash) => {
    const onChain = chain.positions.get(stash);
    differ(out, '6 position bonded', stash, position.bonded, onChain?.bonded);
    differ(out, '6 position unbonding', stash, position.unbonding, onChain?.unbonding);

    const controller = chain.controllers.get(stash);
    if (controller && position.controller !== controller) {
      out.push({
        check: '6 position controller',
        id: stash,
        index: position.controller ?? 'none',
        chain: controller,
      });
    }
  });

  chain.positions.forEach((position, stash) => {
    if (!indexed.has(stash) && position.bonded + position.unbonding > BigInt(0)) {
      differ(out, '6 bonded stash has no position', stash, undefined, position.bonded);
    }
  });

  return { out, positions: indexed.size };
};

/** Each account's staking lock and `Staking` hold in the index, as of `block` */
interface IndexedParts {
  locks: Map<string, bigint>;
  holds: Map<string, bigint>;
  otherReserved: bigint;
}

/** Each account's locks by id and holds by reason in the index, and its `otherReserved` */
const indexedParts = async (db: DataSource, block: number) => {
  const rows: {
    id: string;
    locks: { lockId: string; amount: string }[] | null;
    holds: { reason: string; amount: string }[] | null;
    other_reserved: string;
  }[] = await db.query(
    `SELECT id, locks, holds, other_reserved FROM account_balances WHERE _block_range @> $1::int8`,
    [block]
  );
  const amount = (value: string): bigint => BigInt(String(value).replace(/n$/, ''));

  return new Map<string, IndexedParts>(
    rows.map(row => [
      row.id,
      {
        locks: new Map((row.locks ?? []).map(lock => [lock.lockId, amount(lock.amount)])),
        holds: new Map((row.holds ?? []).map(hold => [hold.reason, amount(hold.amount)])),
        otherReserved: big(row.other_reserved),
      },
    ])
  );
};

const checkBalanceParts = async (
  db: DataSource,
  api: ApiPromise,
  at: ApiDecoration<'promise'>,
  hash: string,
  block: number,
  balances: Map<string, IndexedBalance>
) => {
  const out: Difference[] = [];
  const [indexed, locks, holds] = await Promise.all([
    indexedParts(db, block),
    chainLocks(at),
    chainHolds(api, at, hash),
  ]);
  const compare = (
    label: string,
    id: string,
    index?: Map<string, bigint>,
    chain?: Map<string, bigint>
  ) =>
    new Set([...(index?.keys() ?? []), ...(chain?.keys() ?? [])]).forEach(part =>
      differ(out, `7 ${label} ${part.trim()}`, id, index?.get(part), chain?.get(part))
    );

  new Set([...indexed.keys(), ...locks.keys(), ...holds.keys()]).forEach(id => {
    const row = indexed.get(id);
    compare('lock', id, row?.locks, locks.get(id));
    compare('hold', id, row?.holds, holds.get(id));
  });

  // what is reserved for anything other than staking
  indexed.forEach((row, id) => {
    const reserved = balances.get(id)?.reserved ?? BigInt(0);
    const staking = holds.get(id)?.get('Staking') ?? BigInt(0);
    differ(out, '7 otherReserved', id, row.otherReserved, reserved - staking);
  });

  return { out, accounts: indexed.size };
};

interface IndexedAsset {
  totalSupply: bigint;
  holderCount: number;
}

const indexedAssets = async (db: DataSource, block: number) => {
  const [assets, holders]: [
    { id: string; total_supply: string; holder_count: number }[],
    { id: string; amount: string }[]
  ] = await Promise.all([
    db.query(`SELECT id, total_supply, holder_count FROM assets WHERE _block_range @> $1::int8`, [
      block,
    ]),
    db.query(
      `SELECT id, amount FROM asset_holders WHERE _block_range @> $1::int8 AND amount <> 0`,
      [block]
    ),
  ]);

  return {
    assets: new Map<string, IndexedAsset>(
      assets.map(row => [
        row.id,
        { totalSupply: big(row.total_supply), holderCount: Number(row.holder_count) },
      ])
    ),
    holders: new Map(holders.map(row => [row.id, big(row.amount)])),
  };
};

/**
 * Each asset's holder identities and each identity's amount, as the chain keeps them.
 *
 * A fungible asset's are `asset.balanceOf(asset, did)`: the identity's portfolios, and from v8 its
 * accounts, which `AssetHolder` mirrors. It is the chain's own figure rather than a sum of
 * holdings, because the two differ where the chain let them: before v6.0 a portfolio move that
 * listed an asset twice credited more than it debited (testnet block 6,599,003), and `balanceOf`,
 * like `AssetHolder`, never took the surplus.
 *
 * An NFT collection's holders are the identities holding any of its NFTs, rolled up from the
 * chain's NFT counts: a portfolio's identity is its `did`, an account's the identity it is a key of.
 */
const chainRollups = async (
  at: ApiDecoration<'promise'>,
  staging: boolean,
  nfts: Map<string, number>,
  collections: Set<string>
) => {
  const amounts = new Map<string, bigint>();
  const holders = new Map<string, Set<string>>();
  const hold = (asset: string, did: string) =>
    holders.set(asset, (holders.get(asset) ?? new Set()).add(did));

  const balances = (
    at.query.asset as unknown as Record<
      string,
      { entries?: () => Promise<[{ args: Codec[] }, Codec][]> } | undefined
    >
  ).balanceOf;
  (await balances?.entries?.())?.forEach(([key, value]) => {
    const asset = assetIdOf(key.args[0], staging);
    const amount = big(value.toString());
    if (amount > BigInt(0) && !collections.has(asset)) {
      const did = key.args[1].toString();
      amounts.set(`${asset}/${did}`, amount);
      hold(asset, did);
    }
  });

  const split = (id: string) => {
    const [asset, ...rest] = id.split('/');
    return { asset, holder: rest.join('/'), portfolio: rest.length > 1 };
  };
  const nftAccounts = [...nfts.keys()].map(split).filter(({ portfolio }) => !portfolio);
  const identities = await identitiesOf(at, [...new Set(nftAccounts.map(({ holder }) => holder))]);
  nfts.forEach((count, id) => {
    const { asset, holder, portfolio } = split(id);
    const did = portfolio ? holder.split('/')[0] : identities.get(holder);
    if (did && count > 0) {
      hold(asset, did);
    }
  });

  return { amounts, holders };
};

const checkAssets = async (
  db: DataSource,
  at: ApiDecoration<'promise'>,
  block: number,
  staging: boolean,
  holdings: { amounts: Map<string, bigint>; nfts: Map<string, number> }
) => {
  const out: Difference[] = [];
  const [indexed, supplies] = await Promise.all([
    indexedAssets(db, block),
    chainSupplies(at, staging),
  ]);
  // a collection's supply is its NFTs, all of which someone holds; before v7 its asset record says 0
  const collections = new Map<string, number>();
  holdings.nfts.forEach((count, id) => {
    const asset = id.split('/')[0];
    collections.set(asset, (collections.get(asset) ?? 0) + count);
  });
  const rollups = await chainRollups(at, staging, holdings.nfts, new Set(collections.keys()));
  collections.forEach((count, asset) => supplies.set(asset, BigInt(count)));

  new Set([...indexed.assets.keys(), ...supplies.keys()]).forEach(id => {
    const asset = indexed.assets.get(id);
    differ(out, '8 asset totalSupply', id, asset?.totalSupply, supplies.get(id));
    differ(out, '8 asset holderCount', id, asset?.holderCount, rollups.holders.get(id)?.size ?? 0);
  });
  new Set([...indexed.holders.keys(), ...rollups.amounts.keys()]).forEach(id =>
    differ(out, '8 asset holder amount', id, indexed.holders.get(id), rollups.amounts.get(id))
  );

  return { out, assets: indexed.assets.size };
};

/**
 * Each open instruction's approval rows, and each closed one's status, in the index as of `block`,
 * against the chain's.
 */
const checkApprovals = async (db: DataSource, at: ApiDecoration<'promise'>, block: number) => {
  const instructions: { id: string; status: string }[] = await db.query(
    `SELECT id, status FROM instructions
     WHERE _block_range @> $1::int8 AND status IN ('Created', 'Locked', 'Failed')`,
    [block]
  );
  const rows: { instruction_id: string; holder: string; is_mediator: boolean; status: string }[] =
    await db.query(
      `SELECT a.instruction_id, coalesce(a.account_id, a.portfolio_id, a.identity_id) AS holder,
              a.is_mediator, a.status
       FROM instruction_affirmations a
       JOIN instructions i ON i.id = a.instruction_id AND i._block_range @> $1::int8
       WHERE a._block_range @> $1::int8 AND a.off_chain_receipt_id IS NULL
         AND i.status IN ('Created', 'Locked', 'Failed')`,
      [block]
    );
  const chain = await chainApprovals(
    at,
    instructions.map(({ id }) => id)
  );
  const out: Difference[] = compareApprovals(
    instructions,
    rows.map(row => ({
      instructionId: row.instruction_id,
      holder: row.holder,
      isMediator: row.is_mediator,
      status: row.status,
    })),
    chain
  );

  const closed: { id: string; status: string }[] = await db.query(
    `SELECT id, status FROM instructions
     WHERE _block_range @> $1::int8 AND status IN ('Executed', 'Rejected')`,
    [block]
  );
  out.push(
    ...compareClosed(
      closed,
      await chainStatuses(
        at,
        closed.map(({ id }) => id)
      )
    )
  );

  return { out, instructions: instructions.length, closed: closed.length };
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

  // the chain types the indexer is built with, for blocks before metadata v14: without the bundle,
  // no storage key's arguments decode there
  const api = await ApiPromise.create({
    provider: new WsProvider(rpc),
    noInitWarn: true,
    types: chainTypes.types as never,
    typesBundle: chainTypes.typesBundle as never,
  });
  const hash = (await api.rpc.chain.getBlockHash(block)).toHex();
  const at = await api.at(hash);
  const staging = api.genesisHash.toHex() === STAGING_GENESIS;

  console.log(`Comparing the index with chain state at block ${block}`);

  const polyx = await checkPolyx(db, at, block);
  const holdings = await checkHoldings(db, at, block, staging);
  const staking = await checkStaking(db, at, block);
  const parts = await checkBalanceParts(db, api, at, hash, block, polyx.chain);
  const assets = await checkAssets(db, at, block, staging, holdings.chain);
  const approvals = await checkApprovals(db, at, block);
  const differences = [
    ...polyx.out,
    ...holdings.out,
    ...staking.out,
    ...parts.out,
    ...assets.out,
    ...approvals.out,
  ];

  console.log(
    `${polyx.accounts} balances with their locks and holds, ${holdings.holdings} holdings, ` +
      `${staking.positions} staking positions, ${assets.assets} assets and ` +
      `${approvals.instructions} open and ${approvals.closed} closed instructions checked`
  );

  const byCheck = new Map<string, Difference[]>();
  differences.forEach(d => byCheck.set(d.check, [...(byCheck.get(d.check) ?? []), d]));
  [...byCheck]
    .sort(([a], [b]) => byCodeUnit(a, b))
    .forEach(([check, rows]) => {
      console.log(`\n${check}: ${rows.length}`);
      rows
        .slice(0, show)
        .forEach(d => console.log(`  ${d.id}  index ${d.index}  chain ${d.chain}`));
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
