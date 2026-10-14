import { TypeRegistry } from '@polkadot/types';
import {
  flagOf,
  isRecord,
  itemsOf,
  jsonOf,
  memberOf,
  optionalMemberOf,
  optionOf,
} from '../../src/utils/codec';

const registry = new TypeRegistry();
registry.register({
  Kind: { _enum: { Fungible: 'Null', NonFungible: 'u32' } },
  Details: { owner: 'u32', kind: 'Kind' },
});

describe('optionOf', () => {
  it('unwraps a Some and returns undefined for a None', () => {
    expect(optionOf(registry.createType('Option<u32>', 7), 'x')?.toString()).toBe('7');
    expect(optionOf(registry.createType('Option<u32>', null), 'x')).toBeUndefined();
  });

  it('refuses a value that is not an Option, rather than reading it as None', () => {
    expect(() => optionOf(registry.createType('u32', 7), 'asset.assets')).toThrow(
      /asset.assets was expected to be an Option/
    );
    expect(() => optionOf(undefined, 'x')).toThrow(TypeError);
  });
});

describe('memberOf and flagOf', () => {
  const details = registry.createType('Details' as never, { owner: 3, kind: { NonFungible: 1 } });

  it('reads a struct field and an enum flag', () => {
    expect(memberOf(details, 'owner').toString()).toBe('3');
    expect(flagOf(memberOf(details, 'kind'), 'isNonFungible')).toBe(true);
    expect(flagOf(memberOf(details, 'kind'), 'isFungible')).toBe(false);
  });

  it('names the member a runtime change removed', () => {
    expect(() => memberOf(details, 'ownerDid')).toThrow(/ownerDid was expected on/);
    expect(() => flagOf(memberOf(details, 'kind'), 'isGone')).toThrow(/isGone was expected/);
    expect(() => memberOf(null, 'owner')).toThrow(TypeError);
  });
});

describe('optionalMemberOf', () => {
  it('is undefined for a field the runtime lacks, and the field otherwise', () => {
    const details = registry.createType('Details' as never, { owner: 3, kind: 'Fungible' });

    expect(optionalMemberOf(details, 'owner')?.toString()).toBe('3');
    expect(optionalMemberOf(details, 'frozen')).toBeUndefined();
    expect(optionalMemberOf(undefined, 'owner')).toBeUndefined();
  });
});

describe('itemsOf', () => {
  it('lists a Vec, a tuple and a set', () => {
    expect(itemsOf(registry.createType('Vec<u32>', [1, 2]), 'x').map(String)).toEqual(['1', '2']);
    expect(itemsOf(registry.createType('(u32, u8)', [3, 4]), 'x').map(String)).toEqual(['3', '4']);
    expect(itemsOf(registry.createType('BTreeSet<u32>', [5]), 'x').map(String)).toEqual(['5']);
  });

  it('refuses a value that is not a list', () => {
    expect(() => itemsOf(registry.createType('u32', 1), 'the signers')).toThrow(
      /the signers was expected to be a list/
    );
    expect(() => itemsOf(null, 'x')).toThrow(TypeError);
  });
});

describe('jsonOf', () => {
  const isPending = (json: unknown): json is { pending: number[] } =>
    isRecord(json) && Array.isArray(json.pending);

  it('returns the JSON once the check accepts it, and names the type when it does not', () => {
    const ok = { toJSON: () => ({ pending: [1] }) } as never;
    const bad = { toJSON: () => ({ pending: null }) } as never;

    expect(jsonOf(ok, isPending, 'Schedule')).toEqual({ pending: [1] });
    expect(() => jsonOf(bad, isPending, 'Schedule')).toThrow(
      'Schedule did not have the expected shape: {"pending":null}'
    );
  });
});
