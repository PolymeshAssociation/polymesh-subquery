import { parseTrimList, trimIndexes, TRIM_ENTRIES, TrimClient } from '../../db/trimIndexes';

const conflict = (code: string) => Object.assign(new Error('conflict'), { code });

const found = (table: string, name: string) => ({
  index: `public.${name}`,
  name,
  table: `public.${table}`,
});

/** A client whose lookups answer from `indexes` (by table and column list) and which records each transaction. */
const clientOf = (
  indexes: Record<string, ReturnType<typeof found>[]>,
  failing: (sql: string) => Error | undefined = () => undefined
) => {
  const transactions: string[][] = [];
  const client: TrimClient = {
    query: jest.fn(async (_sql: string, params?: unknown[]) => {
      const [table, def] = params as [string, string];
      return indexes[`${table}|${def}`] ?? [];
    }),
    transaction: async work => {
      const statements: string[] = [];
      transactions.push(statements);
      await work(async sql => {
        statements.push(sql);
        const error = failing(sql);
        if (error) throw error;
      });
    },
  };
  return { client, transactions };
};

const relation = TRIM_ENTRIES.filter(entry => entry.standIn)[0];
const removed = TRIM_ENTRIES.filter(entry => !entry.standIn)[0];
const keyOf = ({ table, columns }: { table: string; columns: string[] }) =>
  `${table}|gist (${columns.join(', ')}, _block_range)`;

describe('trimIndexes', () => {
  const log = jest.fn();
  const options = { lockTimeoutMs: 1234, log };

  beforeEach(() => log.mockClear());

  it('does nothing when no index of the list is a GiST any more', async () => {
    const { client, transactions } = clientOf({});

    await expect(trimIndexes(client, options)).resolves.toEqual({ trimmed: 0, skipped: 0 });
    expect(transactions).toEqual([]);
  });

  it('drops a removed index in its own transaction under a lock timeout, with no stand-in', async () => {
    const { client, transactions } = clientOf({
      [keyOf(removed)]: [found(removed.table, 'old_ix')],
    });

    await expect(trimIndexes(client, options)).resolves.toEqual({ trimmed: 1, skipped: 0 });
    expect(transactions).toEqual([['SET LOCAL lock_timeout = 1234', 'DROP INDEX public.old_ix']]);
  });

  it('replaces a relation index with an empty stand-in of the same name', async () => {
    const { client, transactions } = clientOf({
      [keyOf(relation)]: [found(relation.table, 'rel_ix')],
    });

    await trimIndexes(client, options);

    expect(transactions).toEqual([
      [
        'SET LOCAL lock_timeout = 1234',
        'DROP INDEX public.rel_ix',
        `CREATE INDEX rel_ix ON public.${relation.table} USING btree (id) WHERE false`,
      ],
    ]);
  });

  it.each(['55P03', '40P01'])('skips only the index that hit a %s', async code => {
    const { client, transactions } = clientOf(
      {
        [keyOf(removed)]: [found(removed.table, 'busy_ix')],
        [keyOf(relation)]: [found(relation.table, 'free_ix')],
      },
      sql => (sql === 'DROP INDEX public.busy_ix' ? conflict(code) : undefined)
    );

    await expect(trimIndexes(client, options)).resolves.toEqual({ trimmed: 1, skipped: 1 });
    expect(transactions).toHaveLength(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('busy_ix');
    expect(log.mock.calls[0][0]).toContain('lock conflict');
  });

  it('leaves an index that fails for another reason, and keeps going', async () => {
    const { client } = clientOf(
      {
        [keyOf(removed)]: [found(removed.table, 'bad_ix')],
        [keyOf(relation)]: [found(relation.table, 'good_ix')],
      },
      sql => (sql === 'DROP INDEX public.bad_ix' ? new Error('permission denied') : undefined)
    );

    await expect(trimIndexes(client, options)).resolves.toEqual({ trimmed: 1, skipped: 1 });
    expect(log.mock.calls[0][0]).toContain('permission denied');
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
