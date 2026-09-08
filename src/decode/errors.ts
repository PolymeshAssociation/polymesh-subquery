import { AnomalyKind } from '../types';

/**
 * A shape the indexer could not decode.
 *
 * Every subclass names the `AnomalyKind` it is recorded as, so a decode failure reaches the
 * `IndexerAnomaly` table without the throw site having to know about the entity.
 */
export abstract class DecodeError extends Error {
  abstract readonly kind: AnomalyKind;

  protected constructor(readonly moduleId: string, readonly eventId: string, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A named field lookup found no field of that name in the block's own metadata.
 *
 * Thrown rather than returning `undefined` on purpose: a handler that reads a field the event
 * does not carry is asking a question about a shape it does not have, and continuing with an
 * empty value is how a wrong value gets written silently.
 */
export class FieldNotFound extends DecodeError {
  readonly kind = AnomalyKind.FieldNotFound;

  constructor(moduleId: string, eventId: string, readonly field: string, available: string[]) {
    super(
      moduleId,
      eventId,
      `${moduleId}.${eventId} has no field "${field}"; it carries [${available.join(', ')}]`
    );
  }
}
