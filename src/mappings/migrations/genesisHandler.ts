import {
  Block,
  Event,
  EventIdEnum,
  KeyRole,
  KeyRoleEnum,
  ModuleIdEnum,
  MultiSigSignerStatusEnum,
  SignerTypeEnum,
} from '../../types';
import {
  capitalizeFirstLetter,
  extractString,
  extractValue,
  legacyQuery,
  padId,
} from '../../utils';
import { getAccountId, SEED_EVENT_ID, systematicIssuers } from '../consts';
import { createAccount, createIdentity } from '../entities/identities/mapIdentities';
import { openIdentityKey } from '../entities/identities/mapIdentityKey';
import { createPortfolio } from '../entities/identities/mapPortfolio';
import {
  createMultiSig,
  createMultiSigAdmin,
  createMultiSigSigner,
} from '../entities/multiSig/mapMultiSig';
import { upsertEvmAccountMapping } from '../entities/revive/mapEvmAccountMapping';
import { seedAccountBalances } from '../../seed/accountBalance';
import { seedHoldings } from '../../seed/holding';

const genesisBlock = padId('0');
type DidWithAccount = { did: string; accountId: string };

/**
 * Creates entry for genesis block
 */
const insertGenesisBlock = async (datetime: Date) =>
  Block.create({
    id: genesisBlock,
    blockId: 0,
    parentId: 0,
    hash: chainId,
    parentHash: '',
    specVersionId: 3000,
    datetime,
    countEvents: 0,
    countExtrinsics: 0,
    countExtrinsicsError: 0,
    countExtrinsicsSigned: 0,
    countExtrinsicsSuccess: 0,
    countExtrinsicsUnsigned: 0,
    extrinsicsRoot: '',
    stateRoot: '',
  }).save();

/**
 * The id of the one synthetic seed `Event` (decision D13). Genesis- and storage-seeded rows
 * point their `createdEvent` / `updatedEvent` at it, so those relations stay non-null without an
 * origin-discriminator column.
 */
export const seedEventId = SEED_EVENT_ID;

/**
 * Writes the seed `Event`. Must run after `insertGenesisBlock` (`Event.block` is non-null) and
 * before any entity insert. Fixes defect A17: `createPortfolio` has always been called with
 * `createdEventId: '0000000000/0000000000'` for a row that did not exist — historical mode's
 * foreign keys are virtual, so Postgres never caught the dangling reference.
 */
export const insertSeedEvent = async (): Promise<void> =>
  Event.create({
    id: seedEventId,
    blockId: genesisBlock,
    eventIdx: 0,
    specVersionId: 3000,
    moduleId: ModuleIdEnum.seeding,
    moduleIdText: 'seeding',
    eventId: EventIdEnum.Seeded,
    eventIdText: 'Seeded',
    attributesTxt: '[]',
  }).save();

/**
 * This methods inserts all the entries for GC and systematic issuer DIDs
 *
 * For each DID here, it adds an insert in
 * - Identity - adds entry for the DID mocking DidCreated event
 * - Portfolio - adds in default portfolio entry for the identity
 * - Permission - adds in default whole permissions for the primary account
 * - Account - adds entry for the primary account
 */
const handleGenesisDids = async () => {
  const ss58Format = api.registry.chainSS58;

  // There are special Identities specified in the chain's genesis block that need to be included in the DB.
  const gcDids = Array(33)
    .fill('')
    .map((_, index) => {
      const twoDigitNumber = index.toString(16).padStart(2, '0');
      return `0x${twoDigitNumber}`.padEnd(66, '0');
    });

  const rawGcAccountIds = await api.query.identity.didRecords.multi(gcDids);

  const gcIdentities = [];
  const accountInserts = [];

  rawGcAccountIds.forEach((accountCodec, index) => {
    const did = gcDids[index];

    const account = accountCodec.toJSON();

    const primaryKey = extractString(account, 'primary_key') || '';
    const secondaryKeyValues: any[] = extractValue(account, 'secondary_keys') || [];
    const secondaryKeys = secondaryKeyValues.map(
      ({ signer: { account: secondaryKey } }) => secondaryKey
    );

    gcIdentities.push({
      did,
      accountId: primaryKey,
    });

    if (primaryKey.length) {
      [primaryKey, ...secondaryKeys].forEach((key, keyIndex) => {
        accountInserts.push(
          createAccount(
            {
              identityId: did,
              keyRole: keyIndex === 0 ? KeyRoleEnum.PrimaryKey : KeyRoleEnum.SecondaryKey,
              eventId: EventIdEnum.DidCreated,
              address: key,
            },
            SEED_EVENT_ID
          )
        );
        // The membership interval opened at genesis. `eventIdx` disambiguates keys of one identity
        // seeded in the genesis block.
        accountInserts.push(
          openIdentityKey(
            {
              identityId: did,
              address: key,
              role: keyIndex === 0 ? KeyRole.Primary : KeyRole.Secondary,
              addedReason: EventIdEnum.DidCreated,
              eventIdx: keyIndex,
            },
            SEED_EVENT_ID
          )
        );
      });
    }
  });

  const systematicIssuerIdentities = Object.values(systematicIssuers).map(({ did, accountId }) => ({
    did,
    accountId: getAccountId(accountId, ss58Format),
  }));

  const createIdentityAndPortfolio = ({ did, accountId }: DidWithAccount): Promise<void>[] => [
    createIdentity(
      {
        did,
        primaryAccount: accountId,
        secondaryKeysFrozen: false,
      },
      SEED_EVENT_ID
    ),
    createPortfolio(
      {
        identityId: did,
        number: 0,
      },
      SEED_EVENT_ID
    ),
  ];

  const identityAndPortfolioInserts = [...systematicIssuerIdentities, ...gcIdentities]
    .map(createIdentityAndPortfolio)
    .flat();

  await Promise.all([...identityAndPortfolioInserts, ...accountInserts]);
};

/**
 * This method adds all the MultiSigs and their signers present in the genesis block
 */
const handleMultiSigs = async (datetime: Date): Promise<void> => {
  let multiSigEntries;
  const is7xChainAtGenesis = 'adminDid' in api.query.multiSig;
  if (is7xChainAtGenesis) {
    multiSigEntries = await api.query.multiSig.adminDid.entries();
  } else {
    // `multiSig.multiSigToIdentity` was renamed to `adminDid` at spec 7.0.0
    multiSigEntries = await legacyQuery('multiSig', 'multiSigToIdentity', [0, 6_999_999]).entries();
  }

  const multiSigInserts = [];
  for (const multiSigEntry of multiSigEntries) {
    const [
      {
        args: [rawAddress],
      },
      rawAdminDid,
    ] = multiSigEntry;
    // `adminDid` (7.x+) / `multiSigToIdentity` (pre-7) storage — the *administering* identity, not
    // the creator. The chain keeps no creator storage, so a genesis-seeded `MultiSig.creator` is
    // left null and only the admin relationship is recovered.
    const adminDid = rawAdminDid.toString();
    const multiSigAddress = rawAddress.toString();

    const [signaturesRequired, signerEntries] = await Promise.all([
      api.query.multiSig.multiSigSignsRequired(multiSigAddress),
      api.query.multiSig.multiSigSigners.entries(multiSigAddress),
    ]);

    multiSigInserts.push(
      createMultiSig(
        multiSigAddress,
        undefined,
        undefined,
        +signaturesRequired.toString(),
        genesisBlock,
        datetime,
        SEED_EVENT_ID
      )
    );

    if (adminDid.length) {
      multiSigInserts.push(
        createMultiSigAdmin(multiSigAddress, adminDid, genesisBlock, SEED_EVENT_ID)
      );
    }

    signerEntries.forEach(
      ([
        {
          args: [, rawSigner],
        },
      ]) => {
        let signerType: SignerTypeEnum;
        let signerValue: string;
        if (is7xChainAtGenesis) {
          signerType = SignerTypeEnum.Account;
          signerValue = rawSigner.toString();
        } else {
          const signer = JSON.parse(rawSigner.toString());

          const signerTypeString = Object.keys(signer)[0];

          signerType = capitalizeFirstLetter(signerTypeString) as SignerTypeEnum;
          signerValue = signer[signerTypeString];
        }

        multiSigInserts.push(
          createMultiSigSigner(
            multiSigAddress,
            signerType,
            signerValue,
            MultiSigSignerStatusEnum.Approved,
            genesisBlock,
            datetime,
            SEED_EVENT_ID
          )
        );
      }
    );
  }

  await Promise.all(multiSigInserts);
};

/**
 * This method adds the `H160 -> AccountId32` mappings present in the genesis block
 *
 * `pallet_revive`'s genesis config seeds `OriginalAccount` directly through its `mapped_accounts`
 * field, so these mappings exist without a `revive.mapAccount` extrinsic ever being dispatched and
 * would otherwise be invisible to the indexer
 */
const handleEvmAccountMappings = async (datetime: Date): Promise<void> => {
  // the revive pallet only exists from the 8.x chain onwards
  if (!api.query.revive?.originalAccount) {
    return;
  }

  const entries = await api.query.revive.originalAccount.entries();

  await Promise.all(
    entries.map(
      ([
        {
          args: [rawEvmAddress],
        },
        rawAddress,
      ]) =>
        upsertEvmAccountMapping({
          evmAddress: rawEvmAddress.toString(),
          address: rawAddress.toString(),
          mapped: true,
          datetime,
          blockId: genesisBlock,
        })
    )
  );
};

/**
 * This adds in all the entries which are present in the genesisBlock
 */
export default async (): Promise<void> => {
  logger.info('Running genesis handler');

  const timestamp = await api.query.timestamp.now();
  const datetime = new Date(+timestamp.toString());

  // the genesis block and the seed Event must exist before anything points a relation at them
  await insertGenesisBlock(datetime);
  await insertSeedEvent();

  await Promise.all([handleGenesisDids(), handleMultiSigs(datetime)]);

  // runs last so that it can link to the Accounts created above
  await handleEvmAccountMappings(datetime);

  // opening balance snapshot for the POLYX ledger — without it every derived balance is wrong by
  // the genesis allocation (docs/implementation/02-polyx-ledger.md)
  await seedAccountBalances({ blockId: genesisBlock, datetime });

  // opening asset-holding snapshot — Holding is rebuilt from the movement stream, so it needs
  // the same genesis baseline (docs/implementation/03-holdings-nfts.md)
  await seedHoldings({ blockId: genesisBlock, datetime });

  logger.info('Applied genesis migrations');
};
