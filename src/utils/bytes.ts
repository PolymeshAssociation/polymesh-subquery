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
