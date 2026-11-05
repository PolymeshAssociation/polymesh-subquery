import { hexStripPrefix, u8aToHex } from '@polkadot/util';

/**
 * A codec's bare bytes, copied into this realm.
 *
 * Mappings run in SubQuery's vm2 sandbox, and every codec comes from the host. Inside the sandbox
 * `@polkadot/util` doesn't recognise the host's `Uint8Array`: `u8aToU8a`, which `compactFromU8a`
 * and every `@polkadot/util-crypto` helper run their input through, reads it as text instead, and
 * silently produces the wrong bytes. Lint rejects any other `toU8a` call in `src`.
 */
export const codecBytes = (codec: { toU8a(isBare?: boolean): Uint8Array }): Uint8Array =>
  // eslint-disable-next-line no-restricted-syntax
  Uint8Array.from(codec.toU8a(true));

/**
 * `bytes` as UTF-8 text, or `undefined` when they are no valid UTF-8.
 *
 * Decoded through a `Buffer`, which the host provides: the host's `TextDecoder`, which
 * `@polkadot/util`'s `u8aToString` uses, rejects the sandbox's typed arrays, and lint rejects it in
 * `src`. A `Buffer` replaces each invalid sequence, so the text is valid exactly when it encodes back
 * to the same bytes. The bytes reach it as hex, so no typed array crosses into the host.
 */
export const utf8Text = (bytes: Uint8Array | string): string | undefined => {
  const buffer = Buffer.from(
    hexStripPrefix(typeof bytes === 'string' ? bytes : u8aToHex(bytes)),
    'hex'
  );
  const text = buffer.toString('utf8');

  return Buffer.from(text, 'utf8').equals(buffer) ? text : undefined;
};
