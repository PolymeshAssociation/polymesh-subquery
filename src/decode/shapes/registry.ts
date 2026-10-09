import { ArityMismatch, NoDecoderForSpecVersion } from '../errors';
import { V7 } from './consts';

/**
 * The parameters one event carries over a range of spec versions.
 *
 * These shapes are frozen history: a pre-7.x event's parameters cannot change again, so this
 * table is written once and stops growing.
 */
export interface EventShape {
  /** First spec version this shape applies to, inclusive, on the public chain's scale */
  from: number;
  /** Last spec version this shape applies to, inclusive. Open ended when omitted */
  to?: number;
  /** Parameter names in parameter order */
  fields: readonly string[];
  /**
   * Index from which trailing parameters may be absent.
   *
   * A few Polymesh events grew parameters within a release line - `asset.AssetCreated` gained
   * its name, identifiers and funding round at 5.1.0 - and the handlers already read them
   * defensively. Declaring the tolerance here keeps that fact in the table instead of in an
   * `if (raw)` in a handler body.
   */
  optionalFrom?: number;
  /** Other names a handler may read a field under: alias to field */
  aliases?: Readonly<Record<string, string>>;
}

const shapes = new Map<string, EventShape[]>();

const shapeKey = (moduleId: string, eventId: string): string =>
  `${moduleId.toLowerCase()}.${eventId}`;

/** Parameter counts a shape accepts, as an inclusive band */
export const acceptedArity = (shape: EventShape): { min: number; max: number } => ({
  min: shape.optionalFrom ?? shape.fields.length,
  max: shape.fields.length,
});

const accepts = (shape: EventShape, arity: number): boolean => {
  const { min, max } = acceptedArity(shape);

  return arity >= min && arity <= max;
};

const covers = (shape: EventShape, specVersion: number): boolean =>
  specVersion >= shape.from && (shape.to === undefined || specVersion <= shape.to);

const describeRanges = (entries: readonly EventShape[]): string =>
  entries.map(({ from, to }) => `[${from}, ${to ?? 'open'}]`).join(', ');

const describeArities = (entries: readonly EventShape[]): string =>
  entries
    .map(shape => {
      const { min, max } = acceptedArity(shape);

      return min === max ? `${max}` : `${min} to ${max}`;
    })
    .join(' or ');

/**
 * A single shape covering every spec version from genesis - the common case for an event
 * that has never changed shape. `registerShape(m, e, stable([...]))` reads as "this is what it
 * has always looked like."
 */
export const stable = (fields: readonly string[]): EventShape[] => [{ from: 0, fields }];

/**
 * A single shape from genesis up to and including `to` - the common case for an event the chain
 * removed at a later spec version, with no shape change before then.
 */
export const discontinuedAt = (to: number, fields: readonly string[]): EventShape[] => [
  { from: 0, to, fields },
];

/**
 * A single shape from `from` onward, open-ended - the common case for an event the chain
 * introduced partway through its history, with no shape change since.
 */
export const introducedAt = (from: number, fields: readonly string[]): EventShape[] => [
  { from, fields },
];

/**
 * For an event whose `assetId` field held a `Ticker` until v7.0, when the chain named assets by
 * ticker: the field is `ticker` up to v6 and `assetId` from v7, so its stored name says which it
 * holds. A shape spanning v7 is split there. Handlers read the asset as `assetId` in every era
 * (`getAssetId` takes a ticker or an id), so up to v6 `assetId` stays an alias for `ticker`.
 */
export const tickerBeforeV7 = (entries: readonly EventShape[]): EventShape[] =>
  entries.flatMap(shape => {
    if (shape.from >= V7) {
      return [shape];
    }
    const ticker: EventShape = {
      ...shape,
      fields: shape.fields.map(field => (field === 'assetId' ? 'ticker' : field)),
      aliases: { ...shape.aliases, assetId: 'ticker' },
    };
    if (shape.to !== undefined && shape.to < V7) {
      return [ticker];
    }
    return [
      { ...ticker, to: V7 - 1 },
      { ...shape, from: V7 },
    ];
  });

/**
 * Declares the parameters an event carries.
 *
 * Called once per event at module load. Registering two shapes for the same spec range is
 * allowed and is how an event that changed arity mid-range is expressed - the one matching the
 * observed parameter count wins.
 */
export const registerShape = (
  moduleId: string,
  eventId: string,
  entries: readonly EventShape[]
): void => {
  const key = shapeKey(moduleId, eventId);

  shapes.set(key, [...(shapes.get(key) ?? []), ...entries]);
};

/**
 * `registerShape` for several event ids that all carry the same shape - a rename or a group of
 * events introduced together often share one. `registerShapes(m, [e1, e2], entries)` reads as
 * "these all look like this," and keeps the shared shape written once instead of repeated per id.
 */
export const registerShapes = (
  moduleId: string,
  eventIds: readonly string[],
  entries: readonly EventShape[]
): void => {
  eventIds.forEach(eventId => registerShape(moduleId, eventId, entries));
};

/** Every registered shape, keyed by `moduleId.eventId`. Read by the metadata contract test */
export const registeredShapes = (): ReadonlyMap<string, readonly EventShape[]> => shapes;

/** Shapes registered for one event, in registration order */
export const shapesFor = (moduleId: string, eventId: string): readonly EventShape[] =>
  shapes.get(shapeKey(moduleId, eventId)) ?? [];

/**
 * The shape to decode `arity` parameters with at `specVersion`.
 *
 * @throws NoDecoderForSpecVersion when nothing covers the spec version
 * @throws ArityMismatch when a decoder covers it but disagrees about the parameter count
 */
export const resolveShape = (
  moduleId: string,
  eventId: string,
  specVersion: number,
  arity: number
): EventShape => {
  const registered = shapesFor(moduleId, eventId);
  const covering = registered.filter(shape => covers(shape, specVersion));

  if (covering.length === 0) {
    throw new NoDecoderForSpecVersion(
      moduleId,
      eventId,
      specVersion,
      registered.length ? describeRanges(registered) : 'none'
    );
  }

  const matched = covering.find(shape => accepts(shape, arity));

  if (!matched) {
    throw new ArityMismatch(moduleId, eventId, arity, describeArities(covering));
  }

  return matched;
};
