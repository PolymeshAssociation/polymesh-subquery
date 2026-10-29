/**
 * An in-memory stand-in for the SubQuery store: what the seed and the handlers call, with
 * `getByFields` filtering as the node's store does. `verify-seed` seeds into it, and tests read
 * what was written from `db`.
 */
type Row = Record<string, unknown>;
type Filter = [string, string, unknown][];

const matches = (row: Row, filter: Filter): boolean =>
  filter.every(([field, op, value]) => {
    const actual = row[field];
    switch (op) {
      case '=':
        return actual === value || (actual == null && value == null);
      case '!=':
        return actual !== value;
      case 'in':
        return (value as unknown[]).includes(actual);
      case '!in':
        return !(value as unknown[]).includes(actual);
      default:
        throw new Error(`the memory store has no filter operator ${op}`);
    }
  });

const page = (rows: Row[], { offset = 0, limit = 100 }: { offset?: number; limit?: number } = {}) =>
  rows.slice(offset, offset + limit).map(row => ({ ...row }));

export const memoryStore = () => {
  const db: Record<string, Map<string, Row>> = {};
  const table = (entity: string) => (db[entity] ??= new Map());

  const write = (entity: string, rows: Row[]): Promise<void> => {
    rows.forEach(row => table(entity).set(row.id as string, { ...row }));
    return Promise.resolve();
  };

  // the store's interface returns promises; nothing here waits on anything
  const store = {
    get: (entity: string, id: string) => {
      const row = table(entity).get(id);
      return Promise.resolve(row && { ...row });
    },
    set: (entity: string, id: string, data: Row) => {
      table(entity).set(id, { ...data });
      return Promise.resolve();
    },
    remove: (entity: string, id: string) => {
      table(entity).delete(id);
      return Promise.resolve();
    },
    bulkCreate: write,
    bulkUpdate: write,
    bulkRemove: (entity: string, ids: string[]) => {
      ids.forEach(id => table(entity).delete(id));
      return Promise.resolve();
    },
    getByFields: (entity: string, filter: Filter, options?: { offset?: number; limit?: number }) =>
      Promise.resolve(
        page(
          [...table(entity).values()].filter(row => matches(row, filter)),
          options
        )
      ),
    getByField: (
      entity: string,
      field: string,
      value: unknown,
      options?: { offset?: number; limit?: number }
    ) =>
      Promise.resolve(
        page(
          [...table(entity).values()].filter(row => row[field] === value),
          options
        )
      ),
    getOneByField: (entity: string, field: string, value: unknown) =>
      Promise.resolve([...table(entity).values()].find(row => row[field] === value)),
  };

  /** Every row of `entity`, as written */
  const rows = (entity: string): Row[] => [...table(entity).values()];

  return { db, store, rows };
};
