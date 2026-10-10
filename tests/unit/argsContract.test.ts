import { Metadata, TypeRegistry } from '@polkadot/types';
import { getSpecTypes } from '@polkadot/types-known';
import { GenericCall, GenericEvent } from '@polkadot/types';
import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { stringCamelCase, u8aConcat } from '@polkadot/util';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import chainTypes from '../../src/chainTypes';
import { argumentNames, metadataTypeNames } from '../../src/decode';
import { encodeArgs } from '../../src/mappings/args/encode';

const DIR = join(__dirname, '..', 'fixtures', 'args');

const registryFor = (specName: string, specVersion: number) => {
  const registry = new TypeRegistry();
  registry.setKnownTypes({ typesBundle: chainTypes.typesBundle as never });
  registry.register(chainTypes.types as never);
  registry.register(getSpecTypes(registry, 'Polymesh', specName, specVersion));
  const metadata = new Metadata(
    registry,
    gunzipSync(readFileSync(join(DIR, 'metadata', `${specVersion}.bin.gz`)))
  );
  registry.setMetadata(metadata);
  registry.setChainProperties(registry.createType('ChainProperties', { ss58Format: 12 }));
  return registry;
};

const fixtures = readdirSync(DIR)
  .filter(file => file.endsWith('.json'))
  .map(file => JSON.parse(readFileSync(join(DIR, file), 'utf8')));

describe.each(fixtures)('the canonical encoding at spec $specVersion', fixture => {
  const registry = registryFor(fixture.specName, fixture.specVersion);

  it('encodes every event exactly as the contract says', () => {
    for (const expected of fixture.events) {
      const record = registry.createType('EventRecord', expected.recordHex) as unknown as {
        event: GenericEvent;
      };
      const { event } = record;
      const substrate = {
        event,
        block: { specVersion: fixture.specVersion },
      } as unknown as SubstrateEvent;
      const { args, refs } = encodeArgs(
        event.data as unknown as Codec[],
        argumentNames(substrate),
        metadataTypeNames(substrate)
      );
      expect({ args, refs }).toEqual({ args: expected.args, refs: expected.refs });
    }
  });

  it('encodes every call exactly as the contract says', () => {
    for (const expected of fixture.calls) {
      const call = registry.createType('Call', expected.callHex) as unknown as GenericCall;
      const { args } = encodeArgs(
        call.args,
        call.meta.args.map(({ name }) => stringCamelCase(name.toString())),
        call.meta.args.map(({ type }) => type.toString())
      );
      expect(args).toEqual(expected.args);
    }
  });

  it('never writes a JSON number', () => {
    const numbers: unknown[] = [];
    const visit = (value: unknown): void => {
      if (typeof value === 'number') {
        numbers.push(value);
      } else if (value && typeof value === 'object') {
        Object.values(value).forEach(visit);
      }
    };
    [...fixture.events, ...fixture.calls].forEach(({ args, refs }) => visit({ args, refs }));
    expect(numbers).toEqual([]);
  });
});

/**
 * Before metadata v14 a nested value the chain types don't name decodes as a lookup class: a
 * `PortfolioId`'s `did` is `Lookup60` at spec 3001. Built from bytes through that era's metadata,
 * so it decodes as the node would.
 */
it('finds identities nested in pre-v14 events, whose type is only a lookup id', () => {
  const registry = registryFor('polymesh_mainnet', 3001);
  const pallet = registry.metadata.pallets.find(p => p.name.toString() === 'Portfolio');
  const variant =
    pallet &&
    registry.lookup
      .getSiType(pallet.events.unwrap().type)
      .def.asVariant.variants.find(v => v.name.toString() === 'MovedBetweenPortfolios');
  if (!pallet || !variant) {
    throw new Error('spec 3001 metadata has no portfolio.MovedBetweenPortfolios');
  }
  const A = `0x${'aa'.repeat(32)}`;
  const B = `0x${'bb'.repeat(32)}`;
  const values = [
    A,
    { did: B, kind: { User: 3 } },
    { did: A, kind: 'Default' },
    '0x414243000000000000000000',
    5,
    null,
  ];
  const event = registry.createType(
    'Event',
    u8aConcat(
      new Uint8Array([pallet.index.toNumber(), variant.index.toNumber()]),
      ...variant.fields.map((field, i) =>
        (
          registry.createType(registry.createLookupType(field.type) as never, values[i]) as Codec
        ).toU8a()
      )
    )
  ) as unknown as GenericEvent;

  const { args, refs } = encodeArgs(
    event.data as unknown as Codec[],
    event.meta.fields.map(() => undefined),
    event.meta.fields.map((f, i) =>
      f.typeName.isSome ? f.typeName.unwrap().toString() : event.meta.args[i].toString()
    )
  );

  expect(args).toEqual({
    0: A,
    1: { did: B, kind: { User: '3' } },
    2: { did: A, kind: 'Default' },
    3: 'ABC',
    4: '5',
    5: null,
  });
  expect(refs).toEqual([
    { kind: 'identity', value: A, argument: '0' },
    { kind: 'portfolio', value: `${B}/3`, argument: '1' },
    { kind: 'identity', value: B, argument: '1' },
    { kind: 'portfolio', value: `${A}/0`, argument: '2' },
    { kind: 'identity', value: A, argument: '2' },
    { kind: 'ticker', value: '0x414243000000000000000000', argument: '3' },
  ]);
});
