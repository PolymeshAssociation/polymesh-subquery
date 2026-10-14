import { TypeRegistry } from '@polkadot/types';
import { flagOf, memberOf, optionOf } from '../../src/utils/codec';

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
