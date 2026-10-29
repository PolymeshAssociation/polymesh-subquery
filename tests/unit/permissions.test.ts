/**
 * Extrinsic permissions are stored in one form whatever runtime wrote them: 7.0's, a map by pallet
 * name with names as text. Before metadata v14 polkadot-js decoded them as a list with snake_case
 * fields and text names, and from v14 to 7.0 as a list with camelCase fields and names in hex.
 */
import { getPermissions } from '../../src/mappings/entities/identities/mapIdentities';
import {
  authorizationData,
  canonicalExtrinsicPermissions,
  canonicalPermissions,
} from '../../src/utils/permissions';

const hex = (text: string) => `0x${Buffer.from(text).toString('hex')}`;

describe('canonicalExtrinsicPermissions', () => {
  it('turns the v14 list of pallets into a map by pallet name, names as text', () => {
    expect(
      canonicalExtrinsicPermissions({
        these: [
          {
            palletName: hex('Asset'),
            dispatchableNames: { these: [hex('freeze'), hex('add_documents')] },
          },
          { palletName: hex('Utility'), dispatchableNames: { whole: null } },
        ],
      })
    ).toEqual({
      these: {
        Asset: { extrinsics: { these: ['add_documents', 'freeze'] } },
        Utility: { extrinsics: { whole: null } },
      },
    });
  });

  it('reads the snake_cased list of text names the type bundle gave before v14', () => {
    expect(
      canonicalExtrinsicPermissions({
        except: [{ pallet_name: 'Asset', dispatchable_names: { except: ['issue'] } }],
      })
    ).toEqual({ except: { Asset: { extrinsics: { except: ['issue'] } } } });
  });

  it('gives one value for one permission set, whichever era decoded it', () => {
    const v14 = canonicalExtrinsicPermissions({
      these: [{ palletName: hex('Identity'), dispatchableNames: { these: [hex('add_claim')] } }],
    });
    const preV14 = canonicalExtrinsicPermissions({
      these: [{ pallet_name: 'Identity', dispatchable_names: { these: ['add_claim'] } }],
    });
    const v7 = { these: { Identity: { extrinsics: { these: ['add_claim'] } } } };

    expect(v14).toEqual(v7);
    expect(preV14).toEqual(v7);
    expect(canonicalExtrinsicPermissions(v7)).toEqual(v7);
  });

  // testnet's identity 0x1a3f… stores 50-byte names, `!!` and 48 spaces; the chain matches names
  // exactly, so a misspelt or padded one is kept as it is stored
  it('keeps each name exactly as stored: padding, case, and names no pallet has', () => {
    const padded = '!!'.padEnd(50, ' ');
    expect(
      canonicalExtrinsicPermissions({
        these: [
          { pallet_name: padded, dispatchable_names: { these: [padded] } },
          { pallet_name: 'identity', dispatchable_names: { these: ['add_authorization'] } },
        ],
      })
    ).toEqual({
      these: {
        [padded]: { extrinsics: { these: [padded] } },
        identity: { extrinsics: { these: ['add_authorization'] } },
      },
    });
  });

  it('reads a name as hex only where v14 decoded it as bytes', () => {
    expect(
      canonicalExtrinsicPermissions({
        these: [{ pallet_name: '0x41', dispatchable_names: { these: ['0x42'] } }],
      })
    ).toEqual({ these: { '0x41': { extrinsics: { these: ['0x42'] } } } });
  });

  it('leaves whole permissions whole, and turns an empty list into an empty map', () => {
    expect(canonicalExtrinsicPermissions({ whole: null })).toEqual({ whole: null });
    expect(canonicalExtrinsicPermissions({ these: [] })).toEqual({ these: {} });
  });
});

describe('canonicalPermissions', () => {
  it("converts a key's extrinsic permissions and keeps its other members, in their order", () => {
    const permissions = canonicalPermissions({
      asset: { these: ['0x41534b4b0000000000000000'] },
      extrinsic: { these: [{ pallet_name: 'Asset', dispatchable_names: { whole: null } }] },
      portfolio: { whole: null },
    });

    expect(permissions).toEqual({
      asset: { these: ['0x41534b4b0000000000000000'] },
      extrinsic: { these: { Asset: { extrinsics: { whole: null } } } },
      portfolio: { whole: null },
    });
    expect(Object.keys(permissions)).toEqual(['asset', 'extrinsic', 'portfolio']);
  });
});

describe("a key's permissions (getPermissions)", () => {
  it("stores its transactions in the index's form, whichever era decoded them", () => {
    const key = (extrinsic: unknown) =>
      getPermissions({ asset: { whole: null }, extrinsic, portfolio: { whole: null } });

    const preV14 = key({ these: [{ pallet_name: 'Asset', dispatchable_names: { whole: null } }] });
    const v14 = key({ these: [{ palletName: hex('Asset'), dispatchableNames: { whole: null } }] });

    const expected = { type: 'these', values: { Asset: { extrinsics: { whole: null } } } };
    expect(preV14.transactions).toEqual(expected);
    expect(v14.transactions).toEqual(expected);
    expect(key({ whole: null }).transactions).toEqual({ type: 'whole', values: null });
  });
});

describe("an authorization's data (authorizationData)", () => {
  it("puts a key's extrinsic permissions in the index's form, and leaves any other payload", () => {
    const extrinsic = { these: [{ pallet_name: 'Asset', dispatchable_names: { whole: null } }] };

    expect(authorizationData('JoinIdentity', { extrinsic })).toEqual({
      extrinsic: { these: { Asset: { extrinsics: { whole: null } } } },
    });
    expect(authorizationData('TransferAssetOwnership', '0x1234')).toBe('0x1234');
    expect(authorizationData('BecomeAgent', [{ extrinsic }])).toEqual([{ extrinsic }]);
  });
});
