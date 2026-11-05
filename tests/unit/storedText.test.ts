/**
 * A text a user entered is stored as the chain holds it, whichever runtime's decoding gave it:
 * before metadata v14 the type bundle decoded names and details as `Text`, which the index trimmed,
 * and from v14 the metadata gives `Bytes`, which it did not (testnet venue 36 is "New STO !!! ").
 */
import { TypeRegistry } from '@polkadot/types';
import { Codec } from '@polkadot/types/types';
import { VM } from 'vm2';
import { requiredText, storedText } from '../../src/utils/text';
import { inSandbox } from './sandbox';

const registry = new TypeRegistry();
const as = (type: string, value?: unknown): Codec => registry.createType(type, value);

describe('storedText', () => {
  it.each(['Bytes', 'Text'])('reads a %s exactly as stored, spaces included', type => {
    expect(storedText(as(type, 'New STO !!! '))).toBe('New STO !!! ');
    expect(storedText(as(type, ' ARVOGOLD '))).toBe(' ARVOGOLD ');
  });

  it('gives an empty value as "", and no value as undefined', () => {
    expect(storedText(as('Bytes', ''))).toBe('');
    expect(storedText(as('Text', ''))).toBe('');
    expect(storedText(as('Option<Bytes>'))).toBeUndefined();
    expect(storedText(undefined)).toBeUndefined();
    expect(storedText(null)).toBeUndefined();
  });

  it("reads an Option's value", () => {
    expect(storedText(as('Option<Bytes>', 'Series A '))).toBe('Series A ');
    expect(storedText(as('Option<Bytes>', ''))).toBe('');
  });

  it('drops the NUL padding of a fixed-width value, and gives other bytes that are no text as hex', () => {
    expect(storedText(as('Bytes', 'ACME\0\0\0'))).toBe('ACME');
    expect(storedText(as('Bytes', '0x410042'))).toBe('0x410042');
    expect(storedText(as('Bytes', '0xc328'))).toBe('0xc328');
  });
});

describe('requiredText', () => {
  it('gives the text, "" included, and names a value that is absent', () => {
    expect(requiredText(as('Bytes', ''), 'the name')).toBe('');
    expect(() => requiredText(as('Option<Bytes>'), 'the name')).toThrow(/the name was expected/);
  });
});

describe('storedText inside the mappings sandbox', () => {
  const sandboxed = inSandbox(
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    () => require('../../src/utils/text') as typeof import('../../src/utils/text')
  );

  it('decodes without the host TextDecoder', () => {
    expect(sandboxed().storedText(as('Bytes', 'Café — 株式 '))).toBe('Café — 株式 ');
  });

  it('reads a codec from the other side of the bridge, without instanceof', () => {
    const bridged = new VM().run(`({ toHex: () => '0x2050422020' })`) as Codec;
    expect(sandboxed().storedText(bridged)).toBe(' PB  ');
  });
});
