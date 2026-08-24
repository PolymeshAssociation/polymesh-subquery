/**
 * Shared helpers for backfill scripts that touch SubQuery tables directly.
 *
 * The node runs with historical tracking enabled, and its store layer reshapes every entity table
 * accordingly: `_id` (a UUID) is the primary key, `id` carries no uniqueness, and `_block_range`
 * (an int8range) marks each revision's validity window. Consequences scripts must respect:
 *
 * - only the open revision (`upper(_block_range) IS NULL`) may be read or written; rewriting
 *   closed revisions falsifies point-in-time queries
 * - keyset pagination must run on `_id`, never on `id` (non-unique, drops revisions at batch
 *   boundaries)
 * - inserts must supply `_id` and `_block_range` explicitly - both NOT NULL with no DB default
 *   (see `11_handle_classic_ticker_claimed.sql` for the SQL precedent)
 */

import { DataSource, EntityManager } from 'typeorm';

/** Matches any object exposing TypeORM's raw query interface (DataSource or EntityManager). */
export type Queryable = Pick<DataSource | EntityManager, 'query'>;

/** Predicate selecting the row version visible at the current chain head. */
export const CURRENT_REVISION = 'upper(_block_range) is null';

export interface CurrentBatchOptions {
  /** Table to read from */
  table: string;
  /** Extra predicates ANDed after the current-revision filter; may reference $1..$n parameters */
  where?: string;
  whereParams?: unknown[];
}

/**
 * Fetches one batch of current revisions ordered by `_id`.
 *
 * Returns rows including their `_id`; feed the last one back as `afterId` to continue. `afterId`
 * is nullable - pass null for the first page - because `_id` is a UUID column and there is no
 * empty-string ordering sentinel.
 */
export const fetchCurrentBatch = async <T>(
  postgres: Queryable,
  { table, where = '', whereParams = [] }: CurrentBatchOptions,
  afterId: string | null,
  limit: number
): Promise<(T & { _id: string })[]> => {
  const idParamIndex = whereParams.length + 1;
  const extraFilter = where ? `\n        and (${where})` : '';

  return postgres.query(
    `select *
       from ${table}
      where ${CURRENT_REVISION}${extraFilter}
        and ($${idParamIndex}::uuid is null or _id > $${idParamIndex}::uuid)
      order by _id
      limit $${idParamIndex + 1}`,
    [...whereParams, afterId, limit]
  );
};

/**
 * Updates the current revision of every row matching `where`, returning the affected row count.
 *
 * Closed revisions are deliberately out of scope so historical queries keep seeing the values of
 * their era. `set` and `where` parameter placeholders must be numbered from $1.
 */
export const updateCurrentRevisions = async (
  postgres: Queryable,
  table: string,
  set: string,
  where: string,
  params: unknown[]
): Promise<number> => {
  const extraFilter = where ? `\n       and (${where})` : '';

  const result: unknown[] = await postgres.query(
    `update ${table}
        set ${set}
      where ${CURRENT_REVISION}${extraFilter}`,
    params
  );

  // UPDATE results arrive as [rows, affectedCount]
  return Number(result[1] ?? 0);
};
