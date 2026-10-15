import project from '../../project';

type Handler = { handler: string; filter?: { module?: string; method?: string } };

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
