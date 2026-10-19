import '@subql/types-core/dist/global';
import '@subql/types/dist/global';
import {
  camelToSnakeCase,
  capitalizeFirstLetter,
  findTopLevelCommas,
  fromEntries,
  hexToString,
  removeNullChars,
} from '../../src/utils';

test('fromEntries', () => {
  expect(
    fromEntries(
      [
        ['a', 5],
        ['b', 13],
      ],
      n => n + 1
    )
  ).toStrictEqual({ a: 6, b: 14 });
});

test('camelToSnakeCase', () => {
  expect(camelToSnakeCase('fooBarBaz')).toBe('foo_bar_baz');
});

test('capitalizeFirstLetter', () => {
  expect(capitalizeFirstLetter('helloWorld')).toBe('HelloWorld');
});

test('removeNullChars', () => {
  expect(removeNullChars('\0hello\0World\0\0\0')).toBe('helloWorld');
});

test('findTopLevelCommas', () => {
  expect(findTopLevelCommas('Map<a,b>', true)).toStrictEqual([5]);
  expect(findTopLevelCommas('Map<Map<(u8,u32),String>,bool>', true)).toStrictEqual([24]);
  expect(findTopLevelCommas('Map<Map<(u8,u32),String>,bool>', true)).toStrictEqual([24]);

  expect(findTopLevelCommas('(Map<(u8,u32),String>,bool,u32,Text)', false)).toStrictEqual([
    21, 26, 30,
  ]);
  expect(findTopLevelCommas('(Map<(u8,u32),String>,bool,u32)', true)).toStrictEqual([21]);

  expect(
    findTopLevelCommas(
      '(NominatorIndexCompact,[{"validatorIndex":"ValidatorIndexCompact","offchainAccuracy":"Compact<OffchainAccuracy>"};2],ValidatorIndexCompact)'
    )
  ).toStrictEqual([22, 116]);

  expect(() => findTopLevelCommas('Vec<i8>')).toThrowError();
});

/**
 * Bytes the chain stores are UTF-8 text more often than not, and an event codec renders them as
 * that text, so hex read from storage decodes the same way; bytes that are no UTF-8 keep a
 * character per byte.
 */
describe('hexToString', () => {
  it('decodes UTF-8, as an event codec renders the same bytes', () => {
    expect(hexToString(`0x${Buffer.from('Café — 株式', 'utf8').toString('hex')}`)).toBe(
      'Café — 株式'
    );
  });

  it('keeps a character per byte for bytes that are no UTF-8', () => {
    expect(hexToString('0xff41')).toBe('ÿA');
  });

  it('drops the padding of a fixed-width value', () => {
    expect(hexToString('0x4143000000')).toBe('AC');
  });
});

/**
 * Mappings run in SubQuery's vm2 sandbox, where the host's `TextDecoder` rejects the sandbox's typed
 * arrays (both dev-server resyncs failed at block 1, decoding a genesis lock id). The utils are
 * loaded afresh here with a `TextDecoder`, global and from `util`, that does the same.
 */
describe('hexToString inside the mappings sandbox', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const util = require('util') as { TextDecoder: typeof TextDecoder };
  const realm = globalThis as unknown as { TextDecoder: typeof TextDecoder };
  const host = util.TextDecoder;
  let sandboxed: typeof hexToString;

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
      sandboxed = require('../../src/utils').hexToString;
    });
  });

  afterAll(() => {
    util.TextDecoder = host;
    realm.TextDecoder = host;
  });

  it('decodes without the host TextDecoder', () => {
    expect(sandboxed('0x7374616b696e6720')).toBe('staking ');
    expect(sandboxed(`0x${Buffer.from('Café — 株式', 'utf8').toString('hex')}`)).toBe(
      'Café — 株式'
    );
    expect(sandboxed('0xff41')).toBe('ÿA');
    expect(sandboxed('0x4143000000')).toBe('AC');
  });
});
