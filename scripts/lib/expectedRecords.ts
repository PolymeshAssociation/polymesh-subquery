/** A `handleEvent` subscription from `project.ts`: a module, and for `system` a method */
export interface Filter {
  module: string;
  method?: string;
}

export interface ChainEvent {
  section: string;
  method: string;
  /** the extrinsic that emitted it, or `undefined` for initialization and finalization */
  extrinsic?: number;
}

/** The positions in a block of the events the index subscribes to, so should hold */
export const expectedEvents = (events: ChainEvent[], filters: Filter[]): Set<number> =>
  new Set(
    events.flatMap((event, idx) =>
      filters.some(
        filter =>
          filter.module === event.section &&
          (filter.method === undefined || filter.method === event.method)
      )
        ? [idx]
        : []
    )
  );

/** An extrinsic's closing event, which the index may write without subscribing to it */
export const isClosing = (event: ChainEvent): boolean =>
  event.section === 'system' &&
  (event.method === 'ExtrinsicSuccess' || event.method === 'ExtrinsicFailed');
