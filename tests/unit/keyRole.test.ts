/**
 * `Account.keyRole` (G16) has one derivation point: `keyRoleFor`, mapping a `KeyRecordResolution`
 * to the enum. The four cases from the plan's role table:
 *
 *   primaryKey record      → PrimaryKey
 *   secondaryKey record    → SecondaryKey
 *   multiSigSigner record  → MultiSigSigner
 *   no record              → Unlinked   (pallet / system address, detached key)
 *
 * A multisig's own account resolves through the same path: its key record says PrimaryKey or
 * SecondaryKey (whatever DID it is joined to), never a role that itself encodes "multisig" —
 * multisig-ness is the `MultiSig` row keyed by the same address.
 */

import { keyRoleFor, KeyRecordResolution } from '../../src/utils/accounts';
import { KeyRoleEnum } from '../../src/types';

const DID = '0x01'.padEnd(66, '0');
const MULTISIG = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';

describe('keyRoleFor', () => {
  it('maps a primaryKey record to PrimaryKey', () => {
    expect(keyRoleFor({ kind: 'primaryKey', did: DID })).toBe(KeyRoleEnum.PrimaryKey);
  });

  it('maps a secondaryKey record to SecondaryKey', () => {
    expect(keyRoleFor({ kind: 'secondaryKey', did: DID })).toBe(KeyRoleEnum.SecondaryKey);
  });

  it('maps a multiSigSigner record to MultiSigSigner', () => {
    expect(keyRoleFor({ kind: 'multiSigSigner', multiSig: MULTISIG })).toBe(
      KeyRoleEnum.MultiSigSigner
    );
  });

  it('maps the absence of a record to Unlinked', () => {
    expect(keyRoleFor(undefined)).toBe(KeyRoleEnum.Unlinked);
  });

  it("a multisig's own account keyed as a secondary key reads SecondaryKey, not a multisig role", () => {
    const multisigOwnKeyRecord: KeyRecordResolution = { kind: 'secondaryKey', did: DID };
    expect(keyRoleFor(multisigOwnKeyRecord)).toBe(KeyRoleEnum.SecondaryKey);
  });
});
