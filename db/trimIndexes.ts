import { isLockConflict } from './applySql';

// Historical mode (`historical: 'height'`) turns every declared `@index` and every relation into a
// composite GiST `(field, _block_range)`, and GiST is by far the most expensive index type to build
// and to keep up on insert. About half of those serve no reader: not the indexer (it looks rows up
// by `id`, through the `(id, _block_range)` index in `compat.sql`, and through the handful of
// `getByFields` / `getAllByFields` filters, whose fields keep their index), and not the queries the
// SDK and portal run. Dropping them frees about 4.9 GB on testnet and about 12 GB on mainnet at full
// size, and spares every insert the maintenance. Historical mode itself must stay on: unfinalized
// blocks and reorg rewind need it. Rewind and the per-save close-out filter on `lower(_block_range)`
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
  accounts  created_event_id identity_id updated_event_id
  asset_agent_actions  caller_id created_event_id updated_event_id
  asset_holders  asset_id
  asset_transactions  created_event_id instruction_id
  assets  owner_id updated_event_id
  authorizations  from_id
  claims  created_event_id issuer_id updated_event_id
  eras  end_event_id start_event_id
  events  block_id extrinsic_id
  holdings  account_id asset_id identity_id portfolio_id
  identity_keys  created_event_id identity_id updated_event_id valid_from_block_id
  instruction_affirmations  created_event_id off_chain_receipt_id party_id updated_event_id
  instruction_events  created_event_id off_chain_receipt_id
  instruction_parties  created_event_id instruction_id updated_event_id
  instructions  created_event_id updated_event_id
  legs  created_event_id updated_event_id
  multi_sig_proposal_votes  created_event_id signer_id updated_event_id
  multi_sig_proposals  created_event_id creator_id extrinsic_id updated_event_id
  nfts  account_id asset_id burned_event_id created_event_id identity_id portfolio_id updated_event_id
  nominations  valid_from_event_id validator_id
  polyx_entries  counterparty_identity_id created_event_id extrinsic_id
  portfolios  created_event_id updated_event_id
  staking_events  created_event_id position_id validator_id
  staking_positions  controller_id created_event_id identity_id reward_destination_account_id stash_id updated_event_id
  ticker_reservations  identity_id
  validator_eras  created_event_id era_id identity_id updated_event_id validator_id
  validators  account_id
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

/** What the runner needs of a database: plain queries, and one transaction at a time. */
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
  index: string;
  name: string;
  table: string;
}

const FIND_INDEXES = `
  SELECT format('%I.%I', schemaname, indexname) AS index, quote_ident(indexname) AS name,
    format('%I.%I', schemaname, tablename) AS "table"
  FROM pg_indexes
  WHERE schemaname = current_schema() AND tablename = $1
    AND regexp_replace(indexdef, '^.* USING ', '') = $2`;

const defaults: TrimOptions = { lockTimeoutMs: 5000, log: message => console.log(message) };

const reasonOf = (error: unknown): string =>
  isLockConflict(error) ? 'lock conflict' : error instanceof Error ? error.message : String(error);

/**
 * Drops the GiST indexes in `TRIM_ENTRIES`, each in a transaction of its own that waits for its
 * table's lock only briefly. The node keeps writing to these tables, and a drop holds an exclusive
 * lock until it commits, so one script dropping a hundred indexes would hold them all while the
 * node waits, and give up on the lot when one conflicted. Here an index that cannot be had now, or
 * fails for any other reason, is logged and left; the next start finds it still a GiST and tries
 * again. Nothing here is fatal: the indexes cost speed, not correctness.
 */
export const trimIndexes = async (
  client: TrimClient,
  overrides: Partial<TrimOptions> = {}
): Promise<TrimSummary> => {
  const { lockTimeoutMs, log } = { ...defaults, ...overrides };
  const summary: TrimSummary = { trimmed: 0, skipped: 0 };

  const trim = async (found: FoundIndex, standIn: boolean): Promise<void> => {
    try {
      await client.transaction(async query => {
        // SET LOCAL ends with the transaction, so the timeout does not stay on the connection
        await query(`SET LOCAL lock_timeout = ${Math.floor(lockTimeoutMs)}`);
        await query(`DROP INDEX ${found.index}`);
        if (standIn) {
          await query(`CREATE INDEX ${found.name} ON ${found.table} USING btree (id) WHERE false`);
        }
      });
      summary.trimmed += 1;
    } catch (error) {
      summary.skipped += 1;
      log(`Left index ${found.index} for the next start: ${reasonOf(error)}`);
    }
  };

  for (const { table, columns, standIn } of TRIM_ENTRIES) {
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
    for (const index of found) {
      await trim(index, standIn);
    }
  }

  return summary;
};
