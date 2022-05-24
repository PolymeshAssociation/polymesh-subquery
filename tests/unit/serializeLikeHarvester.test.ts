import '@subql/types/dist/global';
import {
  extractArrayType,
  extractEnumType,
  extractMapTypes,
  extractOptionType,
  extractResultTypes,
  extractStructTypes,
  extractTupleTypes,
  extractVecType,
  isArray,
  isEnum,
  isMap,
  isOption,
  isResult,
  isStruct,
  isTuple,
  isVec,
  parseType,
  serializeLikeHarvester,
} from '../../src/mappings/serializeLikeHarvester';
import { Bytes, GenericCall, createClass, TypeRegistry } from '@polkadot/types';
import { Metadata } from '@polkadot/types/metadata';
import '@subql/types/dist/global';
import { stringToU8a } from '@polkadot/util';
import rpcMetadata from '@polkadot/types-support/metadata/static-substrate';

const registry = new TypeRegistry();
describe('parseType', () => {
  it('should work with structs', () => {
    const Struct = createClass(registry, '{"anInt": "i32", "someTexts": "Vec<Text>"}');
    expect(parseType(new Struct(registry).toRawType())).toStrictEqual({
      anInt: 'i32',
      someTexts: 'Vec<Text>',
    });
  });

  it('should work with enums', () => {
    const Enum = createClass(registry, '{"_enum": {"Foo": "Text", "Bar": "u32"}}');
    expect(parseType(new Enum(registry).toRawType())).toStrictEqual({
      _enum: { Foo: 'Text', Bar: 'u32' },
    });
  });

  it('should ignore other types', () => {
    const Text = createClass(registry, 'Text');
    expect(parseType(new Text(registry).toRawType())).toStrictEqual(undefined);
  });
});

describe('Tuples', () => {
  it('should work with rawTypes', () => {
    const Tuple = createClass(registry, '(HashMap<Text,i64>,(bool, Text), i64)');
    const tuple: any = new Tuple(registry);
    expect(isTuple(tuple)).toBeTruthy();
    expect(extractTupleTypes(tuple, tuple.toRawType())).toStrictEqual([
      'HashMap<Text,i64>',
      '(bool,Text)',
      'i64',
    ]);
  });

  it('should work with actual types', () => {
    registry.register('MyHashMap', createClass(registry, 'HashMap<Text,i64>'));
    const Tuple = createClass(registry, '(MyHashMap,(bool, Text), i64)');
    const tuple: any = new Tuple(registry);
    expect(isTuple(tuple)).toBeTruthy();
    expect(extractTupleTypes(tuple, '(MyHashMap,(bool,Text),i64)')).toStrictEqual([
      'MyHashMap',
      '(bool,Text)',
      'i64',
    ]);
  });

  it('should fail', () => {
    const NotTuple = createClass(registry, 'Text');
    expect(isTuple(new NotTuple(registry))).toBeFalsy();
  });
});

describe('Vec', () => {
  it('should work with rawTypes', () => {
    const Vec = createClass(registry, 'Vec<u32>');
    const vec = new Vec(registry);
    expect(isVec(vec)).toBeTruthy();
    expect(extractVecType(vec, vec.toRawType())).toBe('u32');
  });

  it('should work with actual types', () => {
    registry.register('MyHashMap', createClass(registry, 'HashMap<Text,i64>'));
    const Vec = createClass(registry, 'Vec<MyHashMap>');
    const vec: any = new Vec(registry);
    expect(isVec(vec)).toBeTruthy();
    expect(extractVecType(vec, 'Vec<MyHashMap>')).toBe('MyHashMap');
  });

  it('should fail', () => {
    const NotVec = createClass(registry, 'HashMap<Text, u32>');
    expect(isVec(new NotVec(registry))).toBeFalsy();
  });
});

describe('Array', () => {
  it('should work with rawTypes', () => {
    const Array = createClass(registry, '[u64;3]');
    const array: any = new Array(registry);
    expect(isArray(array)).toBeTruthy();
    expect(extractArrayType(array, array.toRawType())).toBe('u64');
  });

  it('should work with actual types', () => {
    registry.register('MyHashMap', createClass(registry, 'HashMap<Text,i64>'));
    const Array = createClass(registry, '[MyHashMap;3]');
    const array: any = new Array(registry);
    expect(isArray(array)).toBeTruthy();
    expect(extractArrayType(array, '[MyHashMap;3]')).toBe('MyHashMap');
  });

  it('should fail', () => {
    const NotArray = createClass(registry, 'HashMap<Text, u32>');
    expect(isArray(new NotArray(registry))).toBeFalsy();
  });
});

describe('Option', () => {
  it('should work with rawTypes', () => {
    const Option = createClass(registry, 'Option<Text>');
    const option = new Option(registry);
    expect(isOption(option)).toBeTruthy();
    expect(extractOptionType(option, option.toRawType())).toBe('Text');
  });

  it('should work with actual types', () => {
    registry.register('MyHashMap', createClass(registry, 'HashMap<Text,i64>'));
    const Option = createClass(registry, 'Option<MyHashMap>');
    const option: any = new Option(registry);
    expect(isOption(option)).toBeTruthy();
    expect(extractOptionType(option, 'Option<MyHashMap>')).toBe('MyHashMap');
  });

  it('should fail', () => {
    const NotOption = createClass(registry, 'HashMap<Text, u32>');
    expect(isOption(new NotOption(registry))).toBeFalsy();
  });
});

describe('isResult', () => {
  it('should work with rawTypes', () => {
    const Result = createClass(registry, 'Result<bool,Text>');
    const result: any = new Result(registry);
    expect(isResult(result)).toBeTruthy();
    expect(extractResultTypes(result, result.toRawType())).toStrictEqual({
      ok: 'bool',
      err: 'Text',
    });
  });

  it('should work with actual types', () => {
    registry.register('MyHashMap', createClass(registry, 'HashMap<Text,i64>'));
    const Result = createClass(registry, 'Result<MyHashMap,Text>');
    const result: any = new Result(registry);
    expect(isResult(result)).toBeTruthy();
    expect(extractResultTypes(result, 'Result<MyHashMap,Text>')).toStrictEqual({
      ok: 'MyHashMap',
      err: 'Text',
    });
  });

  it('should fail', () => {
    const NotResult = createClass(registry, 'HashMap<Text, u32>');
    expect(isResult(new NotResult(registry))).toBeFalsy();
  });
});

describe('Map', () => {
  it('should work with rawTypes', () => {
    const HashMap = createClass(registry, 'HashMap<Text,u32>');
    const hashMap: any = new HashMap(registry);
    expect(isMap(hashMap)).toBeTruthy();
    expect(extractMapTypes(hashMap, hashMap.toRawType())).toStrictEqual({
      key: 'Text',
      value: 'u32',
    });

    const BTreeMap = createClass(registry, 'HashMap<(u32, bool),BTreeMap<i8,Text>>');
    const bTreeMap: any = new BTreeMap(registry);
    expect(isMap(bTreeMap)).toBeTruthy();
    expect(extractMapTypes(bTreeMap, bTreeMap.toRawType())).toStrictEqual({
      key: '(u32,bool)',
      value: 'BTreeMap<i8,Text>',
    });
  });

  it('should work with actual types', () => {
    registry.register('MyHashMap', createClass(registry, 'HashMap<Text,i64>'));
    const HashMap = createClass(registry, 'HashMap<Text,MyHashMap>');
    const hashMap: any = new HashMap(registry);
    expect(isMap(hashMap)).toBeTruthy();
    expect(extractMapTypes(hashMap, 'HashMap<Text,MyHashMap>')).toStrictEqual({
      key: 'Text',
      value: 'MyHashMap',
    });
  });

  it('should fail', () => {
    const NotMap = createClass(registry, 'Option<u32>');
    expect(isMap(new NotMap(registry))).toBeFalsy();
  });
});

describe('Enum', () => {
  it('should work with actual types', () => {
    const Enum = createClass(registry, JSON.stringify({ _enum: { Foo: 'Text', Bar: 'Vec<u32>' } }));
    const someEnum: any = new Enum(registry);
    expect(someEnum).toBeTruthy();
    expect(extractEnumType(someEnum, someEnum.toRawType(), 'Foo')).toBe('Text');
  });

  it('should work with actual types', () => {
    registry.register('MyHashMap', createClass(registry, 'HashMap<Text,i64>'));
    const Enum = createClass(
      registry,
      JSON.stringify({ _enum: { Foo: 'MyHashMap', Bar: 'Vec<u32>' } })
    );
    const someEnum: any = new Enum(registry);
    expect(someEnum).toBeTruthy();
    expect(
      extractEnumType(
        someEnum,
        JSON.stringify({ _enum: { Foo: 'MyHashMap', Bar: 'Vec<u32>' } }),
        'Foo'
      )
    ).toBe('MyHashMap');
  });

  it('should fail', () => {
    const NotEnum = createClass(registry, 'HashMap<Text, u32>');
    expect(isEnum(new NotEnum(registry))).toBeFalsy();
  });
});

describe('Struct', () => {
  it('should work with actual types', () => {
    const Struct = createClass(registry, JSON.stringify({ foo: 'Text', bar: 'Vec<u32>' }));
    const struct: any = new Struct(registry);
    expect(isStruct(struct)).toBeTruthy();
    expect(extractStructTypes(struct, struct.toRawType())).toStrictEqual({
      foo: 'Text',
      bar: 'Vec<u32>',
    });
  });
  it('should work with actual types', () => {
    registry.register('MyHashMap', createClass(registry, 'HashMap<Text,i64>'));
    const Struct = createClass(registry, JSON.stringify({ foo: 'MyHashMap', bar: 'Vec<u32>' }));
    const struct: any = new Struct(registry);
    expect(isStruct(struct)).toBeTruthy();
    expect(
      extractStructTypes(struct, JSON.stringify({ foo: 'MyHashMap', bar: 'Vec<u32>' }))
    ).toStrictEqual({
      foo: 'MyHashMap',
      bar: 'Vec<u32>',
    });
  });

  it('should fail', () => {
    const NotStruct = createClass(registry, 'HashMap<Text, u32>');
    expect(isStruct(new NotStruct(registry))).toBeFalsy();
  });
});

describe('serializeLikeHarvester', () => {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const logFoundType = () => {};
  it('should ignore non object types', () => {
    expect(serializeLikeHarvester(4 as any, 'u32', logFoundType)).toBe(4);
    expect(serializeLikeHarvester('hi' as any, 'u32', logFoundType)).toBe('hi');
  });

  it('should log found types', () => {
    const logFoundType = jest.fn();

    registry.register(
      'MyStruct',
      createClass(registry, JSON.stringify({ foo: 'bool', bar: 'u32' }))
    );
    registry.register('MyVec', createClass(registry, 'Vec<MyStruct>'));
    const MyVec = createClass(registry, 'MyVec');

    expect(
      serializeLikeHarvester(new MyVec(registry, [{ foo: true, bar: 3 }]), 'MyVec', logFoundType)
    ).toStrictEqual([{ foo: true, bar: 3 }]);

    expect(logFoundType).toHaveBeenNthCalledWith(1, 'MyVec', 'Vec<MyStruct>');
    expect(logFoundType).toHaveBeenNthCalledWith(2, 'MyStruct', '{"foo":"bool","bar":"u32"}');
  });

  it('should serialize dates like the harvester', () => {
    const CompactMoment = createClass(registry, 'Compact<Moment>');

    const notPrecise = new CompactMoment(registry, Date.parse('04 Dec 1995 00:12:00 GMT'));
    expect(serializeLikeHarvester(notPrecise, 'Compact<Moment>', logFoundType)).toBe(
      '1995-12-04T00:12:00'
    );

    const veryPrecise = new CompactMoment(registry, Date.parse('04 Dec 1995 00:12:00 GMT') + 1);
    expect(serializeLikeHarvester(veryPrecise, 'Compact<Moment>', logFoundType)).toBe(
      '1995-12-04T00:12:00.001000'
    );
  });

  it('should serialize AccountIds like the harvester', () => {
    const AccountId = createClass(registry, 'AccountId');

    const account = new AccountId(registry, '5F3sa2TJAWMqDhXG6jhV4N8ko9SxwGy8TpaNS1repo5EYjQX');
    expect(serializeLikeHarvester(account, 'Compact<Moment>', logFoundType)).toBe(
      '0x841226ea070c9577979ca2e854130fbe3253853c13c05943e09908312950275d'
    );
  });

  it('should serialize empty tuples like the harvester', () => {
    registry.register('Empty', createClass(registry, '()'));
    const Empty = createClass(registry, 'Empty');

    expect(serializeLikeHarvester(new Empty(registry), 'Empty', logFoundType)).toBe(null);
  });

  it('should serialize HexBytes like the harvester', () => {
    registry.register('HexBytes', registry.get('Bytes'));
    const HexBytes = createClass(registry, 'HexBytes');

    expect(serializeLikeHarvester(new HexBytes(registry, 'hello'), 'HexBytes', logFoundType)).toBe(
      '0x68656c6c6f'
    );
  });

  it('should serialize Bytes like the harvester', () => {
    // Invalid utf-8
    expect(
      serializeLikeHarvester(
        new Bytes(registry, [...Buffer.from('c328', 'hex').values()]),
        'Bytes',
        logFoundType
      )
    ).toBe('0xc328');

    // Valid utf-8
    expect(
      serializeLikeHarvester(
        new Bytes(registry, [...stringToU8a('hello').values()]),
        'Bytes',
        logFoundType
      )
    ).toBe('hello');

    // Valid utf-8 with null characters
    expect(
      serializeLikeHarvester(
        new Bytes(registry, [...stringToU8a('\0hello\0\0').values()]),
        'Bytes',
        logFoundType
      )
    ).toBe('hello');
  });

  it('should serialize Text like the harvester', () => {
    const Text = createClass(registry, 'Text');

    expect(serializeLikeHarvester(new Text(registry, '\0foo\0bar\0'), 'Text', logFoundType)).toBe(
      'foobar'
    );
  });

  it('should serialize Tickers like the harvester', () => {
    registry.register('Ticker', createClass(registry, '[u8;12]'));
    const Ticker = createClass(registry, 'Ticker');

    expect(
      serializeLikeHarvester(
        new Ticker(registry, [...stringToU8a('ticker\0\0\0\0\0\0')]),
        'Ticker',
        logFoundType
      )
    ).toBe('ticker');
  });

  it('should serialize Calls like the harvester', () => {
    // Taken from https://github.com/polkadot-js/api/blob/master/packages/types/src/extrinsic/Extrinsic.spec.ts
    const registry = new TypeRegistry();
    const metadata = new Metadata(registry, rpcMetadata);
    registry.setMetadata(metadata);

    const extrinsic = new GenericCall(registry, {
      args: ['0x0000000000000000000000000000000000000000000000000000000000000000', 0, 0],
      callIndex: [6, 1], // balances.setBalance
    });
    expect(extrinsic.toRawType()).toBe('Call');

    expect(serializeLikeHarvester(extrinsic, 'Call', logFoundType)).toStrictEqual({
      call_args: [
        {
          name: 'who',
          value: {
            Id: '0x0000000000000000000000000000000000000000000000000000000000000000',
          },
        },
        { name: 'new_free', value: 0 },
        { name: 'new_reserved', value: 0 },
      ],
      call_function: 'set_balance',
      call_index: '0601',
      call_module: 'Balances',
    });
  });

  it('should serialize Vec<LookupSource> as a call argument like the harvester', () => {
    const VecLookupSource = createClass(registry, 'Vec<LookupSource>');

    expect(
      serializeLikeHarvester(
        new VecLookupSource(registry, ['5F3sa2TJAWMqDhXG6jhV4N8ko9SxwGy8TpaNS1repo5EYjQX']),
        'Vec<LookupSource>',
        logFoundType,
        true
      )
    ).toStrictEqual(['841226ea070c9577979ca2e854130fbe3253853c13c05943e09908312950275d']);
  });

  it('should serialize LookupSource like the harvester', () => {
    const VecLookupSource = createClass(registry, 'Vec<LookupSource>');

    expect(
      serializeLikeHarvester(
        new VecLookupSource(registry, ['5F3sa2TJAWMqDhXG6jhV4N8ko9SxwGy8TpaNS1repo5EYjQX']),
        'Vec<LookupSource>',
        logFoundType
      )
    ).toStrictEqual(['0x841226ea070c9577979ca2e854130fbe3253853c13c05943e09908312950275d']);
  });

  it('should serialize Balance like the harvester', () => {
    const Balance = createClass(registry, 'Balance');

    expect(serializeLikeHarvester(new Balance(registry, 20), 'Balance', logFoundType)).toBe(20);
  });

  it('should serialize ElectionScore like the harvester', () => {
    const ElectionScore = createClass(registry, 'ElectionScore');

    expect(
      serializeLikeHarvester(
        new ElectionScore(registry, [20, 30, 40]),
        'ElectionScore',
        logFoundType
      )
    ).toStrictEqual([20, 30, 40]);
  });

  it('should serialize Tuples like the harvester', () => {
    registry.register({
      HexBytes: 'Bytes',
      MyTuple: '(HexBytes,u32,i64)',
    });
    const MyTuple = createClass(registry, 'MyTuple');
    expect(
      serializeLikeHarvester(new MyTuple(registry, ['hello', 30, -40]), 'MyTuple', logFoundType)
    ).toStrictEqual({ col1: '0x68656c6c6f', col2: 30, col3: -40 });
  });

  it('should serialize Arrays like the harvester', () => {
    registry.register({ MyArray: '[u32; 2]' });
    const MyArray = createClass(registry, 'MyArray');

    expect(
      serializeLikeHarvester(new MyArray(registry, [3, 4]), 'MyArray', logFoundType)
    ).toStrictEqual([3, 4]);
  });

  it('should serialize Vecs like the harvester', () => {
    registry.register({ HexBytes: 'Bytes', MyVec: 'Vec<HexBytes>' });
    const MyVec = createClass(registry, 'MyVec');
    expect(
      serializeLikeHarvester(new MyVec(registry, ['hello', 'bye']), 'MyVec', logFoundType)
    ).toStrictEqual(['0x68656c6c6f', '0x627965']);
  });

  it('should serialize Results like the harvester', () => {
    registry.register({
      HexBytes: 'Bytes',
      MyResult: 'Result<HexBytes,HexBytes>',
    });
    const MyResult = createClass(registry, 'MyResult');
    expect(
      serializeLikeHarvester(new MyResult(registry, { Ok: 'foo' }), 'MyResult', logFoundType)
    ).toStrictEqual({ Ok: '0x666f6f' });
    expect(
      serializeLikeHarvester(new MyResult(registry, { Err: 'bar' }), 'MyResult', logFoundType)
    ).toStrictEqual({ Error: '0x626172' });
  });

  it('should serialize Enums like the harvester', () => {
    registry.register({
      HexBytes: 'Bytes',
      MyEnum: JSON.stringify({ _enum: { Foo: 'bool', Bar: 'HexBytes' } }),
      MySimpleEnum: JSON.stringify({ _enum: ['One', 'Two', 'Three'] }),
    });
    const MyEnum = createClass(registry, 'MyEnum');
    expect(
      serializeLikeHarvester(new MyEnum(registry, { Foo: false }), 'MyEnum', logFoundType)
    ).toStrictEqual({ Foo: false });
    expect(
      serializeLikeHarvester(new MyEnum(registry, { Bar: 'bar' }), 'MyEnum', logFoundType)
    ).toStrictEqual({ Bar: '0x626172' });

    const MySimpleEnum = createClass(registry, 'MySimpleEnum');
    expect(
      serializeLikeHarvester(new MySimpleEnum(registry, 'One'), 'MySimpleEnum', logFoundType)
    ).toStrictEqual('One');
  });

  it('should serialize Structs like the harvester', () => {
    registry.register({
      HexBytes: 'Bytes',
      MyStruct: JSON.stringify({ foo: 'HexBytes', bar: 'Bytes' }),
    });
    const MyStruct = createClass(registry, 'MyStruct');
    expect(
      serializeLikeHarvester(
        new MyStruct(registry, { foo: 'hello', bar: 'hello' }),
        'MyStruct',
        logFoundType
      )
    ).toStrictEqual({ foo: '0x68656c6c6f', bar: 'hello' });
  });

  it('should serialize Options like the harvester', () => {
    registry.register({
      HexBytes: 'Bytes',
      MyOption: 'Option<HexBytes>',
    });
    const MyOption = createClass(registry, 'MyOption');
    expect(
      serializeLikeHarvester(new MyOption(registry, 'hello'), 'MyOption', logFoundType)
    ).toStrictEqual('0x68656c6c6f');
    expect(
      serializeLikeHarvester(new MyOption(registry, null), 'MyOption', logFoundType)
    ).toStrictEqual(null);
  });

  it('should serialize Maps like the harvester', () => {
    registry.register({
      HexBytes: 'Bytes',
      MyMap: 'HashMap<HexBytes,Bytes>',
    });
    const MyMap = createClass(registry, 'MyMap');
    expect(
      serializeLikeHarvester(
        new MyMap(registry, { hello: 'hello', bye: 'bye' }),
        'MyMap',
        logFoundType
      )
    ).toStrictEqual({ '0x68656c6c6f': 'hello', '0x627965': 'bye' });
  });
});
