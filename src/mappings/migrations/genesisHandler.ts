import {
  Block,
  EventIdEnum,
  Identity,
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
import { getAccountId, systematicIssuers } from '../consts';
import {
  createAccount,
  createIdentity,
  createPermissions,
} from '../entities/identities/mapIdentities';
import { createPortfolio } from '../entities/identities/mapPortfolio';
import {
  createMultiSig,
  createMultiSigAdmin,
  createMultiSigSigner,
} from '../entities/multiSig/mapMultiSig';
import { upsertEvmAccountMapping } from '../entities/revive/mapEvmAccountMapping';
import { seedAccountBalances } from '../../seed/accountBalance';

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
 * This methods inserts all the entries for GC and systematic issuer DIDs
 *
 * For each DID here, it adds an insert in
 * - Identity - adds entry for the DID mocking DidCreated event
 * - Portfolio - adds in default portfolio entry for the identity
 * - Permission - adds in default whole permissions for the primary account
 * - Account - adds entry for the primary account
 */
const handleGenesisDids = async (datetime: Date) => {
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
      [primaryKey, ...secondaryKeys].forEach(key => {
        accountInserts.push(
          createPermissions(
            {
              datetime,
              transactionGroups: [],
            },
            key,
            genesisBlock
          )
        );
        accountInserts.push(
          createAccount(
            {
              identityId: did,
              permissionsId: key,
              eventId: EventIdEnum.DidCreated,
              address: key,
              datetime,
            },
            genesisBlock
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
        eventId: EventIdEnum.DidCreated,
        datetime,
      },
      genesisBlock
    ),
    createPortfolio(
      {
        identityId: did,
        number: 0,
        eventIdx: 0,
        createdEventId: `${genesisBlock}/${padId('0')}`,
      },
      genesisBlock
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
const handleMultiSigs = async (): Promise<void> => {
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
      rawCreator,
    ] = multiSigEntry;
    const creator = rawCreator.toString();
    const multiSigAddress = rawAddress.toString();

    const creatorIdentity = await Identity.get(creator);
    const creatorAccount = creatorIdentity?.primaryAccount || '';

    const [signaturesRequired, signerEntries] = await Promise.all([
      api.query.multiSig.multiSigSignsRequired(multiSigAddress),
      api.query.multiSig.multiSigSigners.entries(multiSigAddress),
    ]);

    multiSigInserts.push(
      createMultiSig(
        multiSigAddress,
        creator,
        creatorAccount,
        +signaturesRequired.toString(),
        genesisBlock
      )
    );

    if (is7xChainAtGenesis) {
      createMultiSigAdmin(multiSigAddress, creator, genesisBlock);
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
            genesisBlock
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

  await Promise.all([insertGenesisBlock(datetime), handleGenesisDids(datetime), handleMultiSigs()]);

  // runs last so that it can link to the Accounts created above
  await handleEvmAccountMappings(datetime);

  // opening balance snapshot for the POLYX ledger — without it every derived balance is wrong by
  // the genesis allocation (docs/implementation/02-polyx-ledger.md)
  await seedAccountBalances({ blockId: genesisBlock, datetime });

  logger.info('Applied genesis migrations');
};
