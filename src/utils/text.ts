import { Codec } from '@polkadot/types/types';
import { hexStripPrefix, hexToU8a, isHex, u8aToHex } from '@polkadot/util';
import { TextDecoder } from 'util';
import { getTextValue, removeNullChars } from './common';

/**
 * Strict UTF-8 that keeps a leading byte-order mark. Mappings run in SubQuery's vm2 sandbox, where
 * the host's `TextDecoder` rejects the sandbox's typed arrays (so `u8aToString` fails) but accepts
 * a `Buffer`, which the host provides.
 */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** UTF-8 text, or `undefined` when it is invalid or holds a NUL, which Postgres text rejects. */
const utf8Text = (bytes: Uint8Array): string | undefined => {
  if (bytes.includes(0)) {
    return undefined;
  }
  try {
    return utf8.decode(Buffer.from(hexStripPrefix(u8aToHex(bytes)), 'hex'));
  } catch {
    return undefined;
  }
};

/** UTF-8 text when it is valid and NUL-free; otherwise hex. */
export const textOrHex = (bytes: Uint8Array): string => utf8Text(bytes) ?? u8aToHex(bytes);

/**
 * A fixed-width value padded with trailing NULs, such as a ticker or a memo: its text without the
 * padding, or the hex of all of it when the rest is not NUL-free UTF-8.
 */
export const paddedText = (bytes: Uint8Array): string => {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) {
    end -= 1;
  }
  return utf8Text(bytes.subarray(0, end)) ?? u8aToHex(bytes);
};

/** Whether `text` holds a control character other than tab, line feed and carriage return. */
const hasControl = (text: string): boolean =>
  [...text].some(c => {
    const code = c.charCodeAt(0);
    return (code < 0x20 && c !== '\t' && c !== '\n' && c !== '\r') || code === 0x7f;
  });

/**
 * A memo for display: its text without the padding, or the hex of all of it when that is not text
 * or holds a control character. Unlike a ticker, a memo is never matched against another column's
 * text, so bytes such as `0x010203…` read as the bytes they are.
 */
export const memoText = (value: Codec | string | null | undefined): string | undefined => {
  const raw = typeof value === 'string' ? value : value ? getTextValue(value) : undefined;
  if (!raw) {
    return undefined;
  }
  if (!isHex(raw)) {
    return removeNullChars(raw);
  }
  const bytes = hexToU8a(raw);
  const text = paddedText(bytes);
  return hasControl(text) ? u8aToHex(bytes) : text;
};
