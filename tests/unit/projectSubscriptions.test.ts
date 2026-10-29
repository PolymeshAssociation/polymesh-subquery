import project from '../../project';

type Handler = {
  kind?: string;
  handler: string;
  filter?: { module?: string; method?: string };
};

const eventFilters = (module: string): (string | undefined)[] =>
  (project.dataSources as { mapping: { handlers: Handler[] } }[])
    .flatMap(source => source.mapping.handlers)
    .filter(({ handler, filter }) => handler === 'handleEvent' && filter?.module === module)
    .map(({ filter }) => filter?.method);

describe('the batch failure events', () => {
  it('are stored one by one, and utility is not subscribed as a whole', () => {
    expect(eventFilters('utility').sort()).toEqual([
      'BatchCompletedWithErrors',
      'BatchInterrupted',
      'BatchInterruptedOld',
      'BatchOptimisticFailed',
      'ItemFailed',
    ]);
  });

  it('leave out the events of a batch that succeeded', () => {
    const stored = eventFilters('utility');

    expect(stored).not.toContain('BatchCompleted');
    expect(stored).not.toContain('ItemCompleted');
  });
});

describe('the call handlers', () => {
  // the v1 dictionary queries every key of a call filter as an extrinsics column, and has none
  // for the others: a query with one fails, and the node fetches every block over RPC instead
  const DICTIONARY_FIELDS = ['module', 'method', 'success', 'isSigned'];

  it('filter only on what the dictionary can query', () => {
    const callFilters = (project.dataSources as { mapping: { handlers: Handler[] } }[])
      .flatMap(source => source.mapping.handlers)
      .filter(({ kind }) => kind === 'substrate/CallHandler')
      .map(({ handler, filter }) => [handler, Object.keys(filter ?? {})]);

    expect(callFilters.length).toBeGreaterThan(0);
    callFilters.forEach(([handler, keys]) =>
      expect({
        handler,
        keys: (keys as string[]).filter(key => !DICTIONARY_FIELDS.includes(key)),
      }).toEqual({
        handler,
        keys: [],
      })
    );
  });
});
