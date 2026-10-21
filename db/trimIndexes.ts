import { isLockConflict } from './applySql';

// Historical mode (`historical: 'height'`) turns every declared `@index` and every relation into a
// composite GiST `(field, _block_range)`, and GiST is by far the most expensive index type to build
// and to keep up on insert. About half of those serve no reader: not the indexer (it looks rows up
// by `id`, through the `(id, _block_range)` index in `compat.sql`, and through the handful of
// `getByFields` / `getAllByFields` filters, whose fields keep their index), and not the queries the
// SDK and portal run. Dropping them frees about 13 GB on mainnet at full size
// and spares every insert the maintenance. Historical mode itself must stay on: unfinalized blocks
// and reorg rewind need it. Rewind and the per-save close-out filter on `lower(_block_range)`
// and `id`, never on these.
//
// Two lists of entries, told apart by the constant that holds them:
//   REMOVED    the index is no longer declared in schema.graphql, so SubQuery does not recreate it;
//              it is only there to clean up a database built before it was removed from the schema.
//   RELATIONS  the index belongs to a relation, which SubQuery always indexes, so it is still
//              declared. The node runs `CREATE INDEX IF NOT EXISTS` for every declared index on
//              EVERY start (it treats each start as a fresh schema migration), so a plain drop is
//              undone, and an eleven-gigabyte rebuild is paid, at the next restart. It is replaced
//              instead by an empty stand-in under the same name (`WHERE false` indexes nothing and
//              can never be chosen by a query); the node then finds the name taken and skips it.
//              The stand-in is built first, under another name and without blocking writes, and
//              only then swapped in for the GiST in a short transaction (see `trimIndexes`).
//
// What is trimmed follows table size. On the five big tables (staking_positions, account_balances,
// staking_events, polyx_entries, events) every relation index is trimmed but the lookups readers
// filter those tables by, such as `staking_events (stash_id)` and `(identity_id)`: 18 indexes. The
// 17 measured before they were trimmed took 8.57 GB on mainnet; `reward_destination_account_id`
// came later and, trimmed from the start, has no measure.
// On the small tables only the event and extrinsic stamps (`created_event_id`,
// `updated_event_id` and the like) are trimmed, 36 indexes and 111 MB when last measured, because
// nothing looks a row up by the event that wrote it. The lookups to other entities stay as
// SubQuery's GiST, 166 single-column indexes of 490 MB on testnet and 311 MB on mainnet (the
// 2026-10-20 resyncs, with the settlement approvals on top): they are the joins an explorer runs
// (holders of an asset, keys of an identity), each costs at most tens of MB, and the replayed SDK
// and portal queries that sized the list could not speak for every reader. The REMOVED list frees
// about 4.3 GB more.
//
// Entries match on the table and column list, not on a generated name, and only while the index is
// still a GiST, so this is idempotent and safe on a database that never had them. Only indexes of
// at least 1 MB on either chain are listed: the rest cost nothing worth a stand-in. To bring one
// back, remove its row here and declare it in schema.graphql (or `DROP INDEX` the stand-in on an
// existing database and restart, so the node recreates the real one).
//
// One line per table, then its column lists: a list is a single column, or several joined by a
// comma without spaces. A composite list is in the order the node creates the index in, which is
// alphabetical, not the order the schema declares; `_block_range` is left off.
export const RELATIONS = `
  account_balances  account_id identity_id updated_event_id
  accounts  created_event_id updated_event_id
  asset_agent_actions  created_event_id updated_event_id
  asset_transactions  created_event_id
  assets  updated_event_id
  claims  created_event_id updated_event_id
  eras  end_event_id start_event_id
  events  block_id extrinsic_id
  holdings  asset_id
  identity_keys  created_event_id updated_event_id valid_from_block_id
  instruction_affirmations  created_event_id updated_event_id
  instruction_events  created_event_id
  instruction_parties  created_event_id updated_event_id
  instructions  created_event_id updated_event_id
  legs  created_event_id updated_event_id
  multi_sig_proposal_votes  created_event_id updated_event_id
  multi_sig_proposals  created_event_id extrinsic_id updated_event_id
  nfts  burned_event_id created_event_id updated_event_id
  nominations  valid_from_event_id
  polyx_entries  counterparty_identity_id created_event_id extrinsic_id
  portfolios  created_event_id updated_event_id
  staking_events  created_event_id position_id reward_destination_account_id validator_id
  staking_positions  controller_id created_event_id identity_id reward_destination_account_id stash_id updated_event_id
  validator_eras  created_event_id updated_event_id
`;

export const REMOVED = `
  asset_agent_actions  pallet_name
  assets  name ticker type
  authorizations  to_key
  blocks  parent_hash
  claims  filter_expiry
  events  event_id event_idx extrinsic_idx spec_version_id
  extrinsics  extrinsic_idx module_id signed success
  identities  primary_account
  identity_keys  identity_id,role
  instruction_affirmations  identity
  instruction_events  event identity
  legs  ticker
  nominations  era_index,position_id
  polyx_entries  account_id,date account_id,kind block_id date,kind movement_id
  staking_events  era_index
`;

export interface TrimEntry {
  table: string;
  columns: string[];
  /** replaced by an empty index of the same name, because the schema still declares it */
  standIn: boolean;
}

export const parseTrimList = (list: string, standIn: boolean): TrimEntry[] =>
  list
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .filter(([table]) => table)
    .flatMap(([table, ...lists]) =>
      lists.map(item => ({ table, columns: item.split(','), standIn }))
    );

export const TRIM_ENTRIES: TrimEntry[] = [
  ...parseTrimList(RELATIONS, true),
  ...parseTrimList(REMOVED, false),
];

/**
 * What the runner needs of a database: plain queries, and one transaction at a time. `query` must
 * run each statement on its own, outside any transaction, because `CREATE INDEX CONCURRENTLY`
 * cannot run inside a transaction block (a pool's `query` does; a transaction's does not).
 */
export interface TrimClient {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  transaction: (work: (query: TrimClient['query']) => Promise<void>) => Promise<void>;
}

export interface TrimOptions {
  /** how long the drop of one index may wait for its table's lock, in milliseconds */
  lockTimeoutMs: number;
  log: (message: string) => void;
}

export interface TrimSummary {
  trimmed: number;
  skipped: number;
}

interface FoundIndex {
  /** the index's name as stored, unquoted */
  name: string;
  /** the schema it lives in, unquoted */
  schema: string;
  /** the table it indexes, unquoted */
  table: string;
}

const FIND_INDEXES = `
  SELECT indexname AS name, schemaname AS schema, tablename AS "table"
  FROM pg_indexes
  WHERE schemaname = current_schema() AND tablename = $1
    AND regexp_replace(indexdef, '^.* USING ', '') = $2`;

// Whether an index of this name exists on this table, and whether it is usable. A build that
// CONCURRENTLY did not finish leaves the index behind marked invalid.
const FIND_STAND_IN = `
  SELECT i.indisvalid AS valid
  FROM pg_index i
  WHERE i.indexrelid = to_regclass($1) AND i.indrelid = to_regclass($2)`;

const STAND_IN_SUFFIX = '_standin';
const MAX_IDENTIFIER_LENGTH = 63;

const quote = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;
const qualified = (schema: string, name: string): string => `${quote(schema)}.${quote(name)}`;

/**
 * The name the stand-in is built under until it replaces the GiST. Deterministic, so a run that
 * finds the previous run's leftover can reuse it, and cut to the 63 characters Postgres keeps of
 * an identifier, from the original's end, so the suffix always survives.
 */
export const standInName = (name: string): string =>
  name.slice(0, MAX_IDENTIFIER_LENGTH - STAND_IN_SUFFIX.length) + STAND_IN_SUFFIX;

const defaults: TrimOptions = { lockTimeoutMs: 5000, log: message => console.log(message) };

const reasonOf = (error: unknown): string => {
  if (isLockConflict(error)) {
    return 'lock conflict';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
};

/**
 * Drops the GiST indexes in `TRIM_ENTRIES`, each in a transaction of its own that waits for its
 * table's lock only briefly. The node keeps writing to these tables, and a drop holds an exclusive
 * lock until it commits, so one script dropping a hundred indexes would hold them all while the
 * node waits, and give up on the lot when one conflicted. Here an index that cannot be had now, or
 * fails for any other reason, is logged and left; the next start finds it still a GiST and tries
 * again. Nothing here is fatal: the indexes cost speed, not correctness.
 *
 * A relation index is replaced in two steps, so the exclusive lock covers no build. Building even
 * an empty partial index reads every row (seconds on a table of a gigabyte), so the stand-in is
 * built first, as `CREATE INDEX CONCURRENTLY` under a temporary name, which lets writes through;
 * then one short transaction drops the GiST and renames the stand-in into its place. A temporary
 * index left by an earlier run that stopped between the steps is reused; one left invalid by a
 * build that failed is dropped, and that entry is skipped until the next start.
 */
export const trimIndexes = async (
  client: TrimClient,
  overrides: Partial<TrimOptions> = {}
): Promise<TrimSummary> => {
  const { lockTimeoutMs, log } = { ...defaults, ...overrides };
  const summary: TrimSummary = { trimmed: 0, skipped: 0 };

  /** Builds the stand-in under its temporary name, unless a valid one is already there. */
  const buildStandIn = async (found: FoundIndex, temp: string): Promise<boolean> => {
    const tempIndex = qualified(found.schema, temp);
    const state = (await client.query(FIND_STAND_IN, [
      tempIndex,
      qualified(found.schema, found.table),
    ])) as Array<{ valid: boolean }>;

    if (state.length === 0) {
      // Outside any transaction: CONCURRENTLY cannot run inside one
      await client.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quote(temp)} ON ${qualified(
          found.schema,
          found.table
        )} USING btree (id) WHERE false`
      );
    } else if (!state[0].valid) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${tempIndex}`);
      log(`Dropped the unfinished stand-in ${tempIndex}; the next start builds it again`);
      return false;
    }
    return true;
  };

  const trim = async (found: FoundIndex, standIn: boolean): Promise<void> => {
    const index = qualified(found.schema, found.name);
    const temp = standInName(found.name);
    try {
      if (standIn && !(await buildStandIn(found, temp))) {
        summary.skipped += 1;
        return;
      }
      await client.transaction(async query => {
        // SET LOCAL ends with the transaction, so the timeout does not stay on the connection
        await query(`SET LOCAL lock_timeout = ${Math.floor(lockTimeoutMs)}`);
        await query(`DROP INDEX ${index}`);
        if (standIn) {
          await query(
            `ALTER INDEX ${qualified(found.schema, temp)} RENAME TO ${quote(found.name)}`
          );
        }
      });
      summary.trimmed += 1;
    } catch (error) {
      summary.skipped += 1;
      log(`Left index ${index} for the next start: ${reasonOf(error)}`);
      if (standIn) {
        await discardIfInvalid(found, temp);
      }
    }
  };

  /** A failed CONCURRENTLY build leaves an invalid index behind: clear it so the next run starts clean. */
  const discardIfInvalid = async (found: FoundIndex, temp: string): Promise<void> => {
    try {
      const state = (await client.query(FIND_STAND_IN, [
        qualified(found.schema, temp),
        qualified(found.schema, found.table),
      ])) as Array<{ valid: boolean }>;
      if (state.length > 0 && !state[0].valid) {
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${qualified(found.schema, temp)}`);
      }
    } catch (error) {
      log(`Could not clear the stand-in ${temp}: ${reasonOf(error)}`);
    }
  };

  const trimEntry = async ({ table, columns, standIn }: TrimEntry): Promise<void> => {
    let found: FoundIndex[] = [];
    try {
      found = (await client.query(FIND_INDEXES, [
        table,
        `gist (${columns.join(', ')}, _block_range)`,
      ])) as FoundIndex[];
    } catch (error) {
      summary.skipped += 1;
      log(`Could not look for the ${table} (${columns.join(', ')}) index: ${reasonOf(error)}`);
    }
    await found.reduce(
      (previous, index) => previous.then(() => trim(index, standIn)),
      Promise.resolve()
    );
  };

  // One index at a time, so only one table's lock is ever held
  await TRIM_ENTRIES.reduce(
    (previous, entry) => previous.then(() => trimEntry(entry)),
    Promise.resolve()
  );

  return summary;
};
