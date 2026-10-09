import { TypeRegistry } from '@polkadot/types';
import { encodeArgs, encodeValue, RawReference } from '../../src/mappings/args/encode';

const registry = new TypeRegistry();
registry.register({
  IdentityId: '[u8;32]',
  AssetId: '[u8;16]',
  Ticker: '[u8;12]',
  PortfolioKind: { _enum: { Default: 'Null', User: 'u64', AccountId: 'AccountId' } },
  PortfolioId: { did: 'IdentityId', kind: 'PortfolioKind' },
  Holder: { _enum: { Portfolio: 'PortfolioId', Account: 'AccountId' } },
  Nested: { bigAmount: 'u128', amounts: 'Vec<u128>' },
  Flags: { _enum: ['On', 'Off'] },
  Payload: { _enum: { Unit: 'Null', Value: 'u64' } },
  Outcome: 'Result<u8, Text>',
  Lookup: 'BTreeMap<u32, u128>',
  Pair: '(u64, AccountId)',
  SnakeStruct: { claim_issuer: 'IdentityId', issuance_date: 'u64' },
  Leg: { from: 'PortfolioId', to: 'PortfolioId', asset: 'Ticker', amount: 'Balance' },
});
registry.setChainProperties(registry.createType('ChainProperties', { ss58Format: 12 }));

const DID = `0x${'22'.repeat(32)}`;
const ACCOUNT_HEX = `0x${'11'.repeat(32)}`;
const ASSET = `0x${'33'.repeat(16)}`;
const encode = (type: string, value: unknown, refs: RawReference[] = []) =>
  encodeValue(registry.createType(type as never, value), type, refs, 'x');

describe('encodeValue', () => {
  it('writes every integer as a decimal string, exactly, at any depth', () => {
    const max = '340282366920938463463374607431768211455';
    expect(encode('u32', 7)).toBe('7');
    expect(encode('Nested', { bigAmount: max, amounts: [max, 1] })).toEqual({
      bigAmount: max,
      amounts: [max, '1'],
    });
  });

  it('writes byte arrays as hex, even when their bytes are printable', () => {
    expect(encode('IdentityId', DID)).toBe(DID); // 0x22 is '"'
    expect(encode('AssetId', ASSET)).toBe(ASSET);
  });

  it('writes a ticker as text without its trailing NULs', () => {
    expect(encode('Ticker', '0x414243000000000000000000')).toBe('ABC');
  });

  it('keeps tickers apart that differ only past their text', () => {
    // testnet once registered tickers with trailing non-printable bytes beside the plain ones
    expect(encode('Ticker', '0x414243010000000000000000')).toBe('ABC\u0001');
    // a NUL inside the ticker is not padding, so the whole ticker is written as hex
    expect(encode('Ticker', '0x410042000000000000000000')).toBe('0x410042000000000000000000');
    expect(encode('Ticker', '0x41ff00000000000000000000')).toBe('0x41ff00000000000000000000');
  });

  it('writes Bytes and Text as text only when valid UTF-8 without NUL', () => {
    expect(encode('Bytes', '0x68656c6c6f')).toBe('hello');
    expect(encode('Bytes', '0xc328')).toBe('0xc328');
    expect(encode('Bytes', '0x0068690000')).toBe('0x0068690000');
    expect(encode('Text', 'hi')).toBe('hi');
  });

  it('writes accounts as SS58 with the chain prefix', () => {
    expect(encode('AccountId', ACCOUNT_HEX)).toBe(
      registry.createType('AccountId', ACCOUNT_HEX).toString()
    );
  });

  it('writes enums by variant, and a unit variant as its name', () => {
    expect(encode('Flags', 'Off')).toBe('Off');
    expect(encode('Payload', 'Unit')).toBe('Unit');
    expect(encode('Payload', { Value: 5 })).toEqual({ Value: '5' });
  });

  it('writes options, results, maps and tuples', () => {
    expect(encode('Option<u8>', null)).toBeNull();
    expect(encode('Option<u8>', 3)).toBe('3');
    expect(encode('Outcome', { Ok: 1 })).toEqual({ ok: '1' });
    expect(encode('Outcome', { Err: 'no' })).toEqual({ err: 'no' });
    expect(encode('Lookup', new Map([[1, 2]]))).toEqual([['1', '2']]);
    expect(encode('Pair', [9, ACCOUNT_HEX])).toEqual(['9', expect.any(String)]);
  });

  it('camelCases struct fields the metadata names in snake_case', () => {
    expect(encode('SnakeStruct', { claim_issuer: DID, issuance_date: 1 })).toEqual({
      claimIssuer: DID,
      issuanceDate: '1',
    });
  });

  it('collects the references it passes, with the argument they were in', () => {
    const refs: RawReference[] = [];
    encode('Holder', { Portfolio: { did: DID, kind: { User: 4 } } }, refs);

    expect(refs).toEqual([
      { kind: 'portfolio', value: `${DID}/4`, argument: 'x' },
      { kind: 'identity', value: DID, argument: 'x' },
    ]);
  });

  it("refers to a v7.4 account portfolio's account, not to a portfolio", () => {
    const refs: RawReference[] = [];
    const value = encode('PortfolioId', { did: DID, kind: { AccountId: ACCOUNT_HEX } }, refs);
    const account = (value as { kind: { AccountId: string } }).kind.AccountId;

    expect(refs).toEqual([
      { kind: 'identity', value: DID, argument: 'x' },
      { kind: 'account', value: account, argument: 'x' },
    ]);
  });
});

describe('encodeArgs', () => {
  it('keys arguments by name when every one is named, by position otherwise', () => {
    const values = [
      registry.createType('u8', 1),
      registry.createType('Ticker', '0x410000000000000000000000'),
    ];

    expect(encodeArgs(values, ['amount', 'ticker'], ['u8', 'Ticker']).args).toEqual({
      amount: '1',
      ticker: 'A',
    });
    expect(encodeArgs(values, [undefined, undefined], ['u8', 'Ticker']).args).toEqual({
      0: '1',
      1: 'A',
    });
  });
});

/**
 * Mappings run in SubQuery's vm2 sandbox, where the host's `TextDecoder` rejects the sandbox's typed
 * arrays but accepts a `Buffer` (testnet block 90,237 failed on its first ticker). The encoder is
 * loaded afresh here with a `TextDecoder`, global and from `util`, that does the same.
 */
describe('encodeValue inside the mappings sandbox', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const util = require('util') as { TextDecoder: typeof TextDecoder };
  const realm = globalThis as unknown as { TextDecoder: typeof TextDecoder };
  const host = util.TextDecoder;
  let sandboxed: typeof encodeValue;

  beforeAll(() => {
    class HostOnlyDecoder extends host {
      decode(input?: Parameters<TextDecoder['decode']>[0]): string {
        if (!Buffer.isBuffer(input)) {
          throw new TypeError('The "list" argument must be an instance of ArrayBufferView');
        }
        return super.decode(input);
      }
    }
    util.TextDecoder = HostOnlyDecoder;
    realm.TextDecoder = HostOnlyDecoder;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      sandboxed = require('../../src/mappings/args/encode').encodeValue;
    });
  });

  afterAll(() => {
    util.TextDecoder = host;
    realm.TextDecoder = host;
  });

  const encodeIn = (type: string, value: unknown) =>
    sandboxed(registry.createType(type as never, value), type);

  it('writes tickers, Bytes and Text without the host TextDecoder', () => {
    expect(encodeIn('Ticker', '0x4d554d424149524f434b5353')).toBe('MUMBAIROCKSS');
    expect(encodeIn('Bytes', '0x68656c6c6f')).toBe('hello');
    expect(encodeIn('Bytes', '0xe282ac')).toBe('€');
    expect(encodeIn('Bytes', '0xf09f9880')).toBe('😀');
    expect(encodeIn('Bytes', '0xc328')).toBe('0xc328');
    expect(encodeIn('Bytes', '0x0068690000')).toBe('0x0068690000');
    expect(encodeIn('Text', 'hi')).toBe('hi');
    expect(encodeIn('Text', 'a\u0000b')).toBe('0x610062');
  });

  it('rejects what strict UTF-8 forbids: overlongs, surrogates, and code points past U+10FFFF', () => {
    expect(encodeIn('Bytes', '0xc0af')).toBe('0xc0af');
    expect(encodeIn('Bytes', '0xeda080')).toBe('0xeda080');
    expect(encodeIn('Bytes', '0xf4908080')).toBe('0xf4908080');
    expect(encodeIn('Bytes', '0xe282')).toBe('0xe282');
  });

  it('keeps a leading byte-order mark', () => {
    expect(encodeIn('Bytes', '0xefbbbf61')).toBe('\ufeffa');
  });
});

/**
 * vm2 hides a host object's `constructor` from the sandbox, so a nested value's class, and the
 * type name the registry has for it, can't be read there (testnet settlement legs lost their
 * tickers and portfolios). This hides it the same way on every value inside `codec`.
 */
const blindConstructors = (codec: unknown): void => {
  if (!codec || typeof codec !== 'object') {
    return;
  }
  Object.defineProperty(codec, 'constructor', { value: Object, configurable: true });
  const c = codec as {
    isSome?: boolean;
    unwrap?: () => unknown;
    isBasic?: boolean;
    value?: unknown;
  };
  if (codec instanceof Map) {
    [...codec.entries()].forEach(([key, value]) => {
      blindConstructors(key);
      blindConstructors(value);
    });
  } else if (Array.isArray(codec)) {
    codec.forEach(blindConstructors);
  } else if (c.isSome && c.unwrap) {
    blindConstructors(c.unwrap());
  } else if (c.isBasic === false) {
    blindConstructors(c.value);
  }
};

describe('encodeValue where constructors are hidden, as in the mappings sandbox', () => {
  const encodeBlind = (type: string, value: unknown, refs: RawReference[] = []) => {
    const codec = registry.createType(type as never, value);
    blindConstructors(codec);
    return encodeValue(codec, type, refs, 'x');
  };

  it('names nested values from their parent, so tickers and references inside them survive', () => {
    const refs: RawReference[] = [];
    const legs = encodeBlind(
      'Vec<Leg>',
      [
        {
          from: { did: DID, kind: { User: 4 } },
          to: { did: ASSET.padEnd(66, '4'), kind: 'Default' },
          asset: '0x413041360000000000000000',
          amount: 1,
        },
      ],
      refs
    );

    expect(legs).toEqual([
      {
        from: { did: DID, kind: { User: '4' } },
        to: { did: ASSET.padEnd(66, '4'), kind: 'Default' },
        asset: 'A0A6',
        amount: '1',
      },
    ]);
    expect(refs.map(r => [r.kind, r.value])).toEqual([
      ['portfolio', `${DID}/4`],
      ['identity', DID],
      ['portfolio', `${ASSET.padEnd(66, '4')}/0`],
      ['identity', ASSET.padEnd(66, '4')],
      ['ticker', '0x413041360000000000000000'],
    ]);
  });

  it('names values inside options, tuples and enums', () => {
    const refs: RawReference[] = [];
    expect(encodeBlind('Option<Ticker>', '0x414243000000000000000000', refs)).toBe('ABC');
    expect(encodeBlind('(u32, IdentityId)', [1, DID], refs)).toEqual(['1', DID]);
    encodeBlind('Holder', { Portfolio: { did: DID, kind: 'Default' } }, refs);

    expect(refs.map(r => r.kind)).toEqual(['ticker', 'identity', 'portfolio', 'identity']);
  });
});
