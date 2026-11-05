import { TypeRegistry } from '@polkadot/types';
import { stringToHex } from '@polkadot/util';
import { memoText } from '../../src/utils/text';

const registry = new TypeRegistry();
registry.register({ Memo: '[u8;32]' });

const memo = (hex: string) => registry.createType('Memo' as never, hex);
const padded = (text: string) => stringToHex(text).padEnd(66, '0');
const HASH = `0x${'9f'.repeat(31)}c3`;

describe('memoText', () => {
  it('reads a memo as UTF-8 text without its NUL padding', () => {
    expect(memoText(memo(padded('invoice 42')))).toBe('invoice 42');
    expect(memoText(padded('invoice 42'))).toBe('invoice 42');
    expect(memoText(memo(padded('€100 réf')))).toBe('€100 réf');
  });

  it('writes a memo that is not text as hex, rather than control characters', () => {
    expect(memoText(memo(HASH))).toBe(HASH);
    const interiorNul = `${stringToHex('ab')}00${stringToHex('cd').slice(2)}`.padEnd(66, '0');
    expect(memoText(interiorNul)).toBe(interiorNul);
    const counting = `0x${Array.from({ length: 32 }, (_, i) => String(i + 1).padStart(2, '0')).join(
      ''
    )}`;
    expect(memoText(memo(counting))).toBe(counting);
  });

  it('keeps tabs and line breaks as text', () => {
    expect(memoText(memo(padded('line 1\r\nline\t2')))).toBe('line 1\r\nline\t2');
  });

  it('keeps a memo of text that looks like hex as text', () => {
    expect(memoText(memo(padded('0x5f3a')))).toBe('0x5f3a');
  });

  it('reads an all-NUL memo as empty, and no memo as none', () => {
    expect(memoText(memo(`0x${'00'.repeat(32)}`))).toBe('');
    expect(memoText(registry.createType('Option<Memo>' as never, null))).toBeUndefined();
    expect(memoText(undefined)).toBeUndefined();
  });

  it('passes through a memo that is already text', () => {
    expect(memoText('already text')).toBe('already text');
  });
});
