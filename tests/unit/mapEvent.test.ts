import { TypeRegistry } from '@polkadot/types';
import { SubstrateEvent } from '@subql/types';
import { handleToolingEvent } from '../../src/mappings/entities/events/mapEvent';

const registry = new TypeRegistry();
registry.register({ IdentityId: '[u8;32]' });

const DID = `0x${'22'.repeat(32)}`;
const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

/** An event of real codecs, with the names and types its metadata would give. */
const eventOf = (
  section: string,
  method: string,
  fields: [name: string | undefined, type: string, value: unknown][],
  specVersion = 8_000_000
): SubstrateEvent =>
  ({
    idx: 2,
    block: {
      block: { header: { number: { toString: () => '1' } } },
      specVersion,
      timestamp: new Date('2026-01-01T00:00:00Z'),
    },
    event: {
      section,
      method,
      data: fields.map(([, type, value]) => registry.createType(type as never, value)),
      meta: {
        fields: fields.map(([name, type]) => ({
          name: name ? { isSome: true, unwrap: () => name } : { isSome: false },
          typeName: { isSome: true, unwrap: () => type },
        })),
      },
    },
  } as unknown as SubstrateEvent);

describe('handleToolingEvent', () => {
  it('stores named arguments by name, and what they refer to', async () => {
    const event = await handleToolingEvent(
      eventOf('balances', 'Transfer', [
        ['from', 'AccountId', ALICE],
        ['to', 'AccountId', BOB],
        ['amount', 'u128', '1'],
      ])
    );

    expect(event.args).toEqual({
      from: registry.createType('AccountId', ALICE).toString(),
      to: registry.createType('AccountId', BOB).toString(),
      amount: '1',
    });
    expect(event.refs).toEqual([
      `account:${registry.createType('AccountId', ALICE).toString()}`,
      `account:${registry.createType('AccountId', BOB).toString()}`,
    ]);
  });

  it("names a tuple event's arguments from its registered shape", async () => {
    const event = await handleToolingEvent(
      eventOf('identity', 'DidCreated', [
        [undefined, 'IdentityId', DID],
        [undefined, 'AccountId', ALICE],
        [undefined, 'Vec<u8>', []],
      ])
    );

    expect(Object.keys(event.args as object)).toEqual(['did', 'primaryKey', 'secondaryKeys']);
    expect(event.refs).toEqual([
      `identity:${DID}`,
      `account:${registry.createType('AccountId', ALICE).toString()}`,
    ]);
  });

  it('prefers the metadata names to the shape when the event names its fields', async () => {
    const event = await handleToolingEvent(
      eventOf('identity', 'DidCreated', [
        ['did', 'IdentityId', DID],
        ['primary_key', 'AccountId', ALICE],
        ['secondary_keys', 'Vec<u8>', []],
      ])
    );

    expect(Object.keys(event.args as object)).toEqual(['did', 'primaryKey', 'secondaryKeys']);
  });

  it('stores arguments by position when no shape is registered', async () => {
    const event = await handleToolingEvent(
      eventOf('example', 'Unregistered', [
        [undefined, 'IdentityId', DID],
        [undefined, 'AccountId', ALICE],
      ])
    );

    expect(Object.keys(event.args as object)).toEqual(['0', '1']);
    expect(event.refs).toEqual([
      `identity:${DID}`,
      `account:${registry.createType('AccountId', ALICE).toString()}`,
    ]);
  });

  it('names only the parameters an event carries when its shape has optional ones', async () => {
    const event = await handleToolingEvent(
      eventOf(
        'balances',
        'Transfer',
        [
          [undefined, 'Option<IdentityId>', DID],
          [undefined, 'AccountId', ALICE],
          [undefined, 'Option<IdentityId>', null],
          [undefined, 'AccountId', BOB],
          [undefined, 'u128', 1],
        ],
        7_000_000
      )
    );

    expect(Object.keys(event.args as object)).toEqual([
      'fromIdentityId',
      'from',
      'toIdentityId',
      'to',
      'amount',
    ]);
  });

  it('stores arguments by position when the shape disagrees about the count', async () => {
    const event = await handleToolingEvent(
      eventOf('identity', 'DidCreated', [
        [undefined, 'IdentityId', DID],
        [undefined, 'AccountId', ALICE],
      ])
    );

    expect(Object.keys(event.args as object)).toEqual(['0', '1']);
  });
});
