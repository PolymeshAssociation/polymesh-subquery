import {
  Block,
  EventIdEnum,
  Identity,
  MultiSigSignerStatusEnum,
  SignerTypeEnum,
} from '../../types';
import { getAccountId, systematicIssuers } from '../consts';
import { createAccount, createIdentity, createPermissions } from '../entities/mapIdentities';
import { createMultiSig, createMultiSigSigner } from '../entities/mapMultiSig';
import { createPortfolio } from '../entities/mapPortfolio';
import { extractString, extractValue } from '../../utils';

const genesisBlock = '0';
type DidWithAccount = { did: string; accountId: string };

/**
 * Creates entry for genesis block
 */
const insertGenesisBlock = async (datetime: Date) =>
  Block.create({
    id: '0',
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
  const multiSigEntries = await api.query.multiSig.adminDid.entries();

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

    signerEntries.forEach(
      ([
        {
          args: [, rawSigner],
        },
      ]) => {
        const signer = JSON.parse(rawSigner.toString());

        const signerTypeString = Object.keys(signer)[0];
        const signerType = signerTypeString[0].toUpperCase() + signerTypeString.slice(1);
        const signerValue = signer[signerTypeString];

        multiSigInserts.push(
          createMultiSigSigner(
            multiSigAddress,
            signerType as SignerTypeEnum,
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
 * This adds in all the entries which are present in the genesisBlock
 */
export default async (): Promise<void> => {
  logger.info('Running genesis handler');

  const timestamp = await api.query.timestamp.now();
  const datetime = new Date(+timestamp.toString());

  await Promise.all([insertGenesisBlock(datetime), handleGenesisDids(datetime), handleMultiSigs()]);

  logger.info('Applied genesis migrations');
};
