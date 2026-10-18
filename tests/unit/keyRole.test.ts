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

import { keyRoleFor, KeyRecordResolution, resolveKeyRole } from '../../src/utils/accounts';
import { AccountKeyRole } from '../../src/types';
import { __resetBlockContext } from '../../src/mappings/blockContext';
import { codec } from './helpers';

const DID = '0x01'.padEnd(66, '0');
const MULTISIG = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';

describe('keyRoleFor', () => {
  it('maps a primaryKey record to PrimaryKey', () => {
    expect(keyRoleFor({ kind: 'primaryKey', did: DID })).toBe(AccountKeyRole.PrimaryKey);
  });

  it('maps a secondaryKey record to SecondaryKey', () => {
    expect(keyRoleFor({ kind: 'secondaryKey', did: DID })).toBe(AccountKeyRole.SecondaryKey);
  });

  it('maps a multiSigSigner record to MultiSigSigner', () => {
    expect(keyRoleFor({ kind: 'multiSigSigner', multiSig: MULTISIG })).toBe(
      AccountKeyRole.MultiSigSigner
    );
  });

  it('maps the absence of a record to Unlinked', () => {
    expect(keyRoleFor(undefined)).toBe(AccountKeyRole.Unlinked);
  });

  it("a multisig's own account keyed as a secondary key reads SecondaryKey, not a multisig role", () => {
    const multisigOwnKeyRecord: KeyRecordResolution = { kind: 'secondaryKey', did: DID };
    expect(keyRoleFor(multisigOwnKeyRecord)).toBe(AccountKeyRole.SecondaryKey);
  });
});

/**
 * Before 5.0 the chain had no `identity.keyRecords`: an identity's keys were in
 * `identity.keyToIdentityIds`, and an account that joined a multisig as a signer in
 * `multiSig.keyToMultiSig`, which 5.0 migrated to `KeyRecord::MultiSigSignerKey`.
 */
describe('resolveKeyRole before 5.0', () => {
  const SIGNER = '5D8Ad2TLrpMd7TczCRQAynBB6oHw5SDVa3vPdpLkbdJwoc1J';
  const withLegacyStorage = (multisigOfKey: string | undefined) => {
    __resetBlockContext();
    (globalThis as any).api.query = {
      identity: { keyToIdentityIds: jest.fn().mockResolvedValue(codec(undefined)) },
      multiSig: { keyToMultiSig: jest.fn().mockResolvedValue(codec(multisigOfKey)) },
    };
  };

  it('reads a multisig signer key from multiSig.keyToMultiSig', async () => {
    withLegacyStorage(MULTISIG);

    expect(await resolveKeyRole(SIGNER, '0000466636')).toBe(AccountKeyRole.MultiSigSigner);
  });

  it('leaves a key in neither map unlinked', async () => {
    withLegacyStorage(undefined);

    expect(await resolveKeyRole(SIGNER, '0000466636')).toBe(AccountKeyRole.Unlinked);
  });
});
