/**
 * Defect A15 — measures the share of pre-v8 staking rewards paid somewhere other than the stash.
 *
 * Pre-8.x `staking.Reward`/`Rewarded` carries only the stash, so where a staker set a payee of
 * `Controller` or an explicit `Account` the index cannot say which account received the POLYX
 * (`rewardDestination: 'LegacyUnknown'`). Whether that gap is worth closing with a
 * `staking.payee(stash)` read during the genesis replay is a measurement question, not a
 * principle one — this is the measurement.
 *
 * Method: for a spread of pre-v8 blocks (anchored across the chain's history), take the stashes
 * that received a reward in that block and read `staking.payee(stash)` **at that block** (chain
 * storage, historical). Classify `Staked`/`Stash` as "went to the stash" and `Controller`/
 * `Account` as "went elsewhere".
 *
 * Usage (from the repo root, no database needed):
 *
 *   yarn ts-node scripts/measure-a15-payees.ts \
 *     --rpc wss://mainnet-rpc.polymesh.network \
 *     --dictionary https://mainnet-subql-dictionary.polymesh.network/ \
 *     [--anchors 4000000,8000000,12000000,16000000,20000000,23000000] [--per-anchor 5]
 */
import { ApiPromise, WsProvider } from '@polkadot/api';
import chainTypes from '../src/chainTypes';

const { types, typesBundle } = chainTypes;

const V8 = 8_000_000;

const argOf = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);

  return i >= 0 ? process.argv[i + 1] : fallback;
};

interface DictEvent {
  blockHeight: string;
}

const dictionaryQuery = async (url: string, query: string): Promise<{ nodes: DictEvent[] }> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  return ((await res.json()) as { data: { events: { nodes: DictEvent[] } } }).data.events;
};

const rewardBlocksAfter = async (
  dictionary: string,
  anchor: number,
  limit: number
): Promise<number[]> => {
  const { nodes } = await dictionaryQuery(
    dictionary,
    `{ events(filter: {
         module: { equalTo: "staking" },
         event: { in: ["Reward", "Rewarded"] },
         blockHeight: { greaterThan: "${anchor}" }
       }, orderBy: BLOCK_HEIGHT_ASC, first: ${limit * 6}) { nodes { blockHeight } } }`
  );

  return [...new Set(nodes.map(n => Number(n.blockHeight)))].slice(0, limit);
};

interface Tally {
  toStash: number;
  elsewhere: number;
  none: number;
  errors: number;
  nonStash: string[];
  seen: Set<string>;
}

/** Stashes named by the `staking.Reward`/`Rewarded` events in a block. */
const rewardedStashes = (
  events: { event: { section: string; method: string; data: unknown[] } }[]
) =>
  events
    .filter(
      record =>
        record.event.section === 'staking' && ['Reward', 'Rewarded'].includes(record.event.method)
    )
    .map(record => {
      const data = record.event.data;
      return (data.length >= 3 ? data[1] : data[0])?.toString();
    });

/** Reads one block's reward payees and folds them into the running tally. */
const tallyBlock = async (api: ApiPromise, block: number, tally: Tally): Promise<void> => {
  const hash = await api.rpc.chain.getBlockHash(block);
  const specVersion = (await api.rpc.state.getRuntimeVersion(hash)).specVersion.toNumber();

  if (specVersion >= V8) {
    return;
  }

  let events;
  try {
    events = await api.query.system.events.at(hash);
  } catch {
    tally.errors += 1;
    return;
  }

  const at = await api.at(hash);

  for (const stash of rewardedStashes(events as never)) {
    if (!stash || tally.seen.has(stash)) {
      continue;
    }
    tally.seen.add(stash);

    try {
      const payee = (await at.query.staking.payee(stash)).toString();

      if (payee === 'Staked' || payee === 'Stash') {
        tally.toStash += 1;
      } else if (payee === 'None') {
        tally.none += 1;
      } else {
        tally.elsewhere += 1;
        tally.nonStash.push(`  block ${block} (spec ${specVersion}) ${stash} -> ${payee}`);
      }
    } catch {
      tally.errors += 1;
    }
  }
};

const main = async (): Promise<void> => {
  const rpc = argOf('rpc');
  const dictionary = argOf('dictionary');

  if (!rpc || !dictionary) {
    console.error('Pass --rpc <ws url> and --dictionary <url>');
    process.exit(1);
  }

  const anchors = (
    argOf('anchors', '4000000,8000000,12000000,16000000,20000000,23000000') as string
  )
    .split(',')
    .map(Number);
  const perAnchor = Number(argOf('per-anchor', '5'));

  const api = await ApiPromise.create({
    provider: new WsProvider(rpc),
    noInitWarn: true,
    types: types as never,
    typesBundle: typesBundle as never,
  });

  const tally: Tally = {
    toStash: 0,
    elsewhere: 0,
    none: 0,
    errors: 0,
    nonStash: [],
    seen: new Set<string>(),
  };

  for (const anchor of anchors) {
    for (const block of await rewardBlocksAfter(dictionary, anchor, perAnchor)) {
      await tallyBlock(api, block, tally);
    }
  }

  const { toStash, elsewhere, none, errors, nonStash } = tally;

  await api.disconnect();

  const total = toStash + elsewhere + none;
  const pct = (n: number) => (total ? ((100 * n) / total).toFixed(1) : '0.0');

  console.log(`\n=== A15 payee measurement (${rpc}) ===`);
  console.log(
    `distinct pre-v8 reward stashes sampled: ${total} across ${anchors.length} anchors (errors ${errors})`
  );
  console.log(
    `  payee = Stash/Staked  (reward went to the stash):     ${toStash}  (${pct(toStash)}%)`
  );
  console.log(
    `  payee = Controller/Account (went elsewhere):          ${elsewhere}  (${pct(elsewhere)}%)`
  );
  console.log(`  payee = None:                                         ${none}`);

  if (nonStash.length) {
    console.log('\nnon-stash payees:');
    nonStash.forEach(line => console.log(line));
  }

  console.log(
    `\nverdict: ${
      total > 0 && elsewhere / total < 0.01
        ? 'near-zero — LegacyUnknown documented in the schema is defensible; no storage-read backfill needed'
        : 'material — add a staking.payee(stash) read at the reward block during the genesis replay'
    }`
  );
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
