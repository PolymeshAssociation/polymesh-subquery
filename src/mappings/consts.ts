import { encodeAddress } from '@polkadot/keyring';
import { stringToHex } from '@polkadot/util';

export const getAccountId = (value: string, ss58Format?: number): string =>
  encodeAddress(stringToHex(`modl${value}`).padEnd(66, '0'), ss58Format);

// List of all the systematic issuers can be found [here](https://github.com/PolymeshAssociation/Polymesh/blob/d45fd1a161990310242f21230ac8a1a5d15498eb/pallets/common/src/constants.rs#L23)
export const systematicIssuers = {
  governanceCommittee: {
    did: '0x73797374656d3a676f7665726e616e63655f636f6d6d69747465650000000000', // Governance Committee
    accountId: 'pm/govcm',
  },
  cddProvider: {
    did: '0x73797374656d3a637573746f6d65725f6475655f64696c6967656e6365000000',
    accountId: 'pm/cusdd',
  },
  treasury: {
    did: '0x73797374656d3a74726561737572795f6d6f64756c655f646964000000000000',
    accountId: 'pm/trsry',
  },
  blockRewardReserve: {
    did: '0x73797374656d3a626c6f636b5f7265776172645f726573657276655f64696400',
    accountId: 'pm/blrwr',
  },
  settlementModule: {
    did: '0x73797374656d3a736574746c656d656e745f6d6f64756c655f64696400000000',
    accountId: 'pm/setmn',
  },
  classicMigration: {
    did: '0x73797374656d3a706f6c796d6174685f636c61737369635f6d69670000000000',
    accountId: 'pm/ehmig',
  },
  fiatTickersReservation: {
    did: '0x73797374656d3a666961745f7469636b6572735f7265736572766174696f6e00',
    accountId: 'pm/ftres',
  },
  rewards: {
    did: '0x73797374656d3a726577617264735f6d6f64756c655f64696400000000000000',
    accountId: 'pm/rewrd',
  },
};
