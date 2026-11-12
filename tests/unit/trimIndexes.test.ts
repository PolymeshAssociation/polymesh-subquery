import {
  parseTrimList,
  standInName,
  trimIndexes,
  TRIM_ENTRIES,
  TrimClient,
} from '../../db/trimIndexes';

const conflict = (code: string) => Object.assign(new Error('conflict'), { code });

const found = (table: string, name: string) => ({ name, schema: 'public', table });

type Found = ReturnType<typeof found>;

/**
 * A client whose lookups answer from `indexes` (by table and column list) and `standIns` (the
 * validity of a leftover stand-in, by its quoted name), and which records every statement in the
 * order it ran: those outside a transaction as they are, and each transaction as a nested list.
 */
const clientOf = (
  indexes: Record<string, Found[]>,
  failing: (sql: string) => Error | undefined = () => undefined,
  standIns: Record<string, boolean> = {}
) => {
  const log: Array<string | string[]> = [];
  const client: TrimClient = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('indisvalid')) {
        const [name] = params as [string];
        return name in standIns ? [{ valid: standIns[name] }] : [];
      }
      if (params) {
        const [table, def] = params as [string, string];
        return indexes[`${table}|${def}`] ?? [];
      }
      log.push(sql);
      const error = failing(sql);
      if (error) throw error;
      return [];
    }),
    transaction: async work => {
      const statements: string[] = [];
      log.push(statements);
      await work(async sql => {
        statements.push(sql);
        const error = failing(sql);
        if (error) throw error;
      });
    },
  };
  return {
    client,
    log,
    get transactions() {
      return log.filter(Array.isArray);
    },
  };
};

const relation = TRIM_ENTRIES.filter(entry => entry.standIn)[0];
const removed = TRIM_ENTRIES.filter(entry => !entry.standIn)[0];
const keyOf = ({ table, columns }: { table: string; columns: string[] }) =>
  `${table}|gist (${columns.join(', ')}, _block_range)`;

describe('trimIndexes', () => {
  const logged = jest.fn();
  const options = { lockTimeoutMs: 1234, log: logged };

  beforeEach(() => logged.mockClear());

  it('does nothing when no index of the list is a GiST any more', async () => {
    const { client, transactions } = clientOf({});

    await expect(trimIndexes(client, options)).resolves.toEqual({ trimmed: 0, skipped: 0 });
    expect(transactions).toEqual([]);
  });

  it('drops a removed index in its own transaction under a lock timeout, with no stand-in', async () => {
    const { client, log } = clientOf({
      [keyOf(removed)]: [found(removed.table, 'old_ix')],
    });

    await expect(trimIndexes(client, options)).resolves.toEqual({ trimmed: 1, skipped: 0 });
    expect(log).toEqual([['SET LOCAL lock_timeout = 1234', 'DROP INDEX "public"."old_ix"']]);
  });

  it('builds the stand-in concurrently outside a transaction, then swaps it in', async () => {
    const { client, log } = clientOf({
      [keyOf(relation)]: [found(relation.table, 'rel_ix')],
    });

    await expect(trimIndexes(client, options)).resolves.toEqual({ trimmed: 1, skipped: 0 });

    expect(log).toEqual([
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "rel_ix_standin" ON "public"."${relation.table}" USING btree (id) WHERE false`,
      [
        'SET LOCAL lock_timeout = 1234',
        'DROP INDEX "public"."rel_ix"',
        'ALTER INDEX "public"."rel_ix_standin" RENAME TO "rel_ix"',
      ],
    ]);
  });

  it('reuses a valid stand-in a previous run left, without building another', async () => {
    const { client, log } = clientOf(
      { [keyOf(relation)]: [found(relation.table, 'rel_ix')] },
      () => undefined,
      { '"public"."rel_ix_standin"': true }
    );

    await expect(trimIndexes(client, options)).resolves.toEqual({ trimmed: 1, skipped: 0 });
    expect(log).toEqual([
      [
        'SET LOCAL lock_timeout = 1234',
        'DROP INDEX "public"."rel_ix"',
        'ALTER INDEX "public"."rel_ix_standin" RENAME TO "rel_ix"',
      ],
    ]);
  });

  it('drops an invalid leftover stand-in and skips the entry until the next start', async () => {
    const { client, log } = clientOf(
      { [keyOf(relation)]: [found(relation.table, 'rel_ix')] },
      () => undefined,
      { '"public"."rel_ix_standin"': false }
    );

    await expect(trimIndexes(client, options)).resolves.toEqual({ trimmed: 0, skipped: 1 });
    expect(log).toEqual(['DROP INDEX CONCURRENTLY IF EXISTS "public"."rel_ix_standin"']);
    expect(log.some(Array.isArray)).toBe(false);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('rel_ix_standin'));
  });

  it('drops the invalid index a failed concurrent build leaves, and skips the entry', async () => {
    const standIns: Record<string, boolean> = {};
    const { client, log } = clientOf(
      { [keyOf(relation)]: [found(relation.table, 'rel_ix')] },
      sql => {
        if (sql.startsWith('CREATE INDEX CONCURRENTLY')) {
          standIns['"public"."rel_ix_standin"'] = false;
          return new Error('deadlock detected');
        }
        return undefined;
      },
      standIns
    );

    await expect(trimIndexes(client, options)).resolves.toEqual({ trimmed: 0, skipped: 1 });
    expect(log[log.length - 1]).toBe('DROP INDEX CONCURRENTLY IF EXISTS "public"."rel_ix_standin"');
    expect(log.some(Array.isArray)).toBe(false);
    expect(logged.mock.calls[0][0]).toContain('deadlock detected');
  });

  it('keeps the built stand-in when the swap loses a lock conflict, for the next start', async () => {
    const { client, log } = clientOf(
      { [keyOf(relation)]: [found(relation.table, 'rel_ix')] },
      sql => (sql === 'DROP INDEX "public"."rel_ix"' ? conflict('55P03') : undefined),
      { '"public"."rel_ix_standin"': true }
    );

    await expect(trimIndexes(client, options)).resolves.toEqual({ trimmed: 0, skipped: 1 });
    expect(log.some(entry => typeof entry === 'string' && entry.startsWith('DROP'))).toBe(false);
    expect(logged.mock.calls[0][0]).toContain('lock conflict');
  });

  it('names the stand-in deterministically within the 63 characters Postgres keeps', () => {
    expect(standInName('short_ix')).toBe('short_ix_standin');
    const long = 'x'.repeat(63);
    const name = standInName(long);
    expect(name).toHaveLength(63);
    expect(name.endsWith('_standin')).toBe(true);
    expect(standInName(long)).toBe(name);
  });

  it.each(['55P03', '40P01'])('skips only the index that hit a %s', async code => {
    const harness = clientOf(
      {
        [keyOf(removed)]: [found(removed.table, 'busy_ix')],
        [keyOf(relation)]: [found(relation.table, 'free_ix')],
      },
      sql => (sql === 'DROP INDEX "public"."busy_ix"' ? conflict(code) : undefined)
    );

    await expect(trimIndexes(harness.client, options)).resolves.toEqual({
      trimmed: 1,
      skipped: 1,
    });
    expect(harness.transactions).toHaveLength(2);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toContain('busy_ix');
    expect(logged.mock.calls[0][0]).toContain('lock conflict');
  });

  it('leaves an index that fails for another reason, and keeps going', async () => {
    const { client } = clientOf(
      {
        [keyOf(removed)]: [found(removed.table, 'bad_ix')],
        [keyOf(relation)]: [found(relation.table, 'good_ix')],
      },
      sql => (sql === 'DROP INDEX "public"."bad_ix"' ? new Error('permission denied') : undefined)
    );

    await expect(trimIndexes(client, options)).resolves.toEqual({ trimmed: 1, skipped: 1 });
    expect(logged.mock.calls[0][0]).toContain('permission denied');
  });

  it('skips an entry whose lookup fails instead of throwing', async () => {
    const { client } = clientOf({});
    client.query = jest.fn(async () => {
      throw new Error('connection reset');
    });

    const summary = await trimIndexes(client, options);

    expect(summary.trimmed).toBe(0);
    expect(summary.skipped).toBe(TRIM_ENTRIES.length);
  });
});

describe('parseTrimList', () => {
  it('reads a table and each of its column lists, splitting composites on the comma', () => {
    expect(parseTrimList('\n  claims  a b,c\n  legs  ticker\n', true)).toEqual([
      { table: 'claims', columns: ['a'], standIn: true },
      { table: 'claims', columns: ['b', 'c'], standIn: true },
      { table: 'legs', columns: ['ticker'], standIn: true },
    ]);
  });
});
