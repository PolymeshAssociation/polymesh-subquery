import { hexStripPrefix, u8aToHex } from '@polkadot/util';
import { TextDecoder } from 'util';

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
