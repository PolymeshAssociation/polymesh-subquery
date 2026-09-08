import { ArityMismatch, NoDecoderForSpecVersion } from '../errors';

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
