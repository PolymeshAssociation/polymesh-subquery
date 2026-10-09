/**
 * The shape table names a tuple-style event's fields the way the runtime that makes the event
 * struct-style names them. From that runtime on, `decodeEvent` takes the names from the metadata,
 * so a handler only reads one set of names if every era's shape already uses them.
 *
 * `chainEventFields.json` lists, per runtime pallet and event, the field names the chain declares.
 */
import { stringCamelCase } from '@polkadot/util';
import chainFields from '../fixtures/chainEventFields.json';
import '../../src/decode/shapes';
import { shapesFor } from '../../src/decode/shapes/registry';

const handled = Object.entries(chainFields as Record<string, string[]>)
  .map(([key, fields]) => {
    const [pallet, event] = key.split('.');
    const moduleId = pallet[0].toLowerCase() + pallet.slice(1);
    const current = shapesFor(moduleId, event).find(shape => shape.to === undefined);
    return { key, fields: fields.map(name => stringCamelCase(name)), current };
  })
  .filter(({ current }) => current !== undefined);

describe('shape names match the chain', () => {
  it('covers the handled events', () => {
    expect(handled.length).toBeGreaterThan(60);
  });

  it.each(handled.map(({ key, fields, current }) => [key, fields, current?.fields]))(
    '%s',
    (_, fields, shape) => {
      expect(shape).toEqual(fields);
    }
  );
});
