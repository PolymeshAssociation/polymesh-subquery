import { Codec } from '@polkadot/types/types';
import { hexToU8a, isHex, u8aToHex } from '@polkadot/util';
import { utf8Text } from './bytes';
import { getTextValue, removeNullChars } from './common';

/**
 * UTF-8 text, keeping a leading byte-order mark, or `undefined` when it is invalid or holds a NUL,
 * which Postgres text rejects.
 */
const nulFreeText = (bytes: Uint8Array): string | undefined =>
  bytes.includes(0) ? undefined : utf8Text(bytes);

/** UTF-8 text when it is valid and NUL-free; otherwise hex. */
export const textOrHex = (bytes: Uint8Array): string => nulFreeText(bytes) ?? u8aToHex(bytes);

/**
 * A fixed-width value padded with trailing NULs, such as a ticker or a memo: its text without the
 * padding, or the hex of all of it when the rest is not NUL-free UTF-8.
 */
export const paddedText = (bytes: Uint8Array): string => {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) {
    end -= 1;
  }
  return nulFreeText(bytes.subarray(0, end)) ?? u8aToHex(bytes);
};

/** Whether `text` holds a control character other than tab, line feed and carriage return. */
const hasControl = (text: string): boolean =>
  [...text].some(c => {
    const code = c.codePointAt(0) ?? 0;
    return (code < 0x20 && c !== '\t' && c !== '\n' && c !== '\r') || code === 0x7f;
  });

/** A memo argument as the chain gave it: a string, or a codec's text. */
const rawText = (value: Codec | string | null | undefined): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }
  return value ? getTextValue(value) : undefined;
};

/**
 * A memo for display: its text without the padding, or the hex of all of it when that is not text
 * or holds a control character. Unlike a ticker, a memo is never matched against another column's
 * text, so bytes such as `0x010203…` read as the bytes they are.
 *
 * A string must be the memo's raw hex, as `toJSON()` or a codec's JSON text gives it: any string
 * that is valid hex is decoded as bytes, so text already decoded elsewhere would be misread if it
 * happened to look like hex.
 */
export const memoText = (value: Codec | string | null | undefined): string | undefined => {
  const raw = rawText(value);
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
