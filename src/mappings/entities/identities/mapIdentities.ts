import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import {
  Account,
  AccountHistory,
  AssetPermissions,
  ChildIdentity,
  CustomClaimType,
  Event,
  EventIdEnum,
  Identity,
  Permissions,
  PermissionsJson,
  PortfolioPermissions,
  TransactionPermissions,
} from '../../../types';
import {
  MeshPortfolio,
  bytesToString,
  getEventParams,
  getNumberValue,
  getTextValue,
  meshPortfolioToPortfolio,
} from '../../../utils';
import { Attributes, extractArgs } from './../common';
import { createPortfolio, getPortfolio } from './mapPortfolio';

const createHistoryEntry = async (
  eventId: EventIdEnum,
  identity: string,
  address: string,
  blockId: string,
  datetime: Date,
  blockEventId: string,
  permissions?: PermissionsJson
): Promise<void> =>
  AccountHistory.create({
    id: blockEventId,
    eventId,
    account: address,
    identity,
    permissions,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    datetime,
  }).save();

/**
 * Returns Identity for a given DID
 *
 * @throws if no Identity is found
 */
const getIdentity = async (did: string): Promise<Identity> => {
  const identity = await Identity.get(did);
  if (!identity) {
    throw new Error(`Identity with DID ${did} was not found`);
  }

  return identity;
};

export const createPermissions = async (
  args: Attributes<Permissions>,
  address: string,
  blockId: string
): Promise<void> =>
  Permissions.create({
    id: address,
    ...args,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();

export const createAccount = async (args: Attributes<Account>, blockId: string): Promise<void> =>
  Account.create({
    id: args.address,
    ...args,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();

export const createIdentity = async (args: Attributes<Identity>, blockId: string): Promise<void> =>
  Identity.create({
    id: args.did,
    ...args,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
/**
 * Creates an Identity if already not present. It also creates default Portfolio for that Identity
 *
 * @note WARNING: This function should only be used for the events that do not validate a DID to exists, before execution of the underlying extrinsic.
 * For e.g. `settlement.InstructionCreated` as it doesn't validates the target DID
 */
export const createIdentityIfNotExists = async (
  did: string,
  blockId: string,
  eventId: EventIdEnum,
  eventIdx: number,
  block: SubstrateBlock,
  blockEventId: string
): Promise<void> => {
  const identity = await Identity.get(did);
  if (!identity) {
    await createIdentity(
      {
        did,
        primaryAccount: '',
        eventId,
        secondaryKeysFrozen: false,
        datetime: block.timestamp,
      },
      blockId
    );

    await createPortfolio(
      {
        identityId: did,
        number: 0,
        eventIdx,
        createdEventId: blockEventId,
      },
      blockId
    );
  }
};

export const handleDidCreated = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);

  const {
    eventId,
    createdBlockId: blockId,
    datetime,
    eventIdx,
    blockEventId,
  } = getEventParams(args);

  const [rawDid, rawAddress] = args.params;

  const did = getTextValue(rawDid);
  const address = getTextValue(rawAddress);

  let defaultPortfolio;
  const identity = await Identity.get(did);
  if (identity) {
    identity.primaryAccount = address;
    identity.updatedBlockId = blockId;
    identity.eventId = eventId;
    identity.datetime = datetime;
    await identity.save();

    const portfolio = await getPortfolio({ identityId: did, number: 0 });

    portfolio.updatedBlockId = blockId;
    defaultPortfolio = portfolio.save();
  } else {
    await createIdentity(
      {
        did,
        primaryAccount: address,
        secondaryKeysFrozen: false,
        eventId,
        datetime,
      },
      blockId
    );

    defaultPortfolio = createPortfolio(
      {
        identityId: did,
        number: 0,
        eventIdx,
        createdEventId: blockEventId,
      },
      blockId
    );
  }

  const permissions = createPermissions(
    {
      datetime,
      transactionGroups: [],
    },
    address,
    blockId
  );

  const account = createAccount(
    {
      identityId: did,
      permissionsId: address,
      eventId,
      address,
      datetime,
    },
    blockId
  );

  await Promise.all([permissions, account, defaultPortfolio]);
};

export const handleChildDidCreated = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const { createdBlockId, updatedBlockId } = getEventParams(args);

  let childDid: string, parentDid: string;

  if (args instanceof Event) {
    const attributes = JSON.parse(args.attributesTxt);
    [{ value: parentDid }, { value: childDid }] = attributes;
  } else {
    const [rawParentDid, rawChildDid] = args.params;

    parentDid = getTextValue(rawParentDid);
    childDid = getTextValue(rawChildDid);
  }

  await ChildIdentity.create({
    id: childDid,
    parentId: parentDid,
    childId: childDid,
    createdBlockId,
    updatedBlockId,
  }).save();
};

export const handleChildDidUnlinked = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  let childDid: string;

  if (args instanceof Event) {
    const attributes = JSON.parse(args.attributesTxt);
    [, , { value: childDid }] = attributes;
  } else {
    const [, , rawChildDid] = args.params;

    childDid = getTextValue(rawChildDid);
  }

  await ChildIdentity.remove(childDid);
};

interface PermissionsLike {
  assets: AssetPermissions | undefined;
  portfolios: PortfolioPermissions | undefined;
  transactions: TransactionPermissions | undefined;
  transactionGroups: string[];
}

const getPermissions = (accountPermissions: Record<string, unknown>): PermissionsLike => {
  let assets: AssetPermissions | undefined = undefined,
    portfolios: PortfolioPermissions | undefined = undefined,
    transactions: TransactionPermissions | undefined = undefined,
    transactionGroups: string[] = [];

  let type: string;
  Object.keys(accountPermissions).forEach(key => {
    switch (key) {
      case 'asset': {
        const assetPermissions = accountPermissions.asset as Record<string, string[]>;
        type = Object.keys(assetPermissions)[0];
        assets = {
          type,
          values: assetPermissions[type],
        };
        break;
      }
      case 'portfolio': {
        const portfolioPermissions = accountPermissions.portfolio as Record<
          string,
          MeshPortfolio[]
        >;
        type = Object.keys(portfolioPermissions)[0];
        portfolios = {
          type,
          values: portfolioPermissions[type]?.map(meshPortfolio => {
            const { identityId: did, number } = meshPortfolioToPortfolio(meshPortfolio);
            return { did, number };
          }),
        };
        break;
      }
      case 'extrinsic': {
        const transactionPermissions = accountPermissions.extrinsic as Record<string, string[]>;
        type = Object.keys(transactionPermissions)[0];
        transactions = {
          type,
          values: transactionPermissions[type],
        };
        break;
      }
      default: {
        transactionGroups = accountPermissions[key] as string[];
      }
    }
  });
  return {
    assets,
    portfolios,
    transactions,
    transactionGroups,
  };
};

export const handleSecondaryKeysPermissionsUpdated = async (
  event: SubstrateEvent
): Promise<void> => {
  const args = extractArgs(event);
  let address;

  const [, rawSignerDetails, , rawUpdatedPermissions] = args.params;

  if (rawSignerDetails instanceof Map) {
    // for chain version < 5.0.0
    const signer = rawSignerDetails.get('signer').toString();
    address = JSON.parse(signer).account;
  } else {
    // for chain version >= 5.0.0
    address = getTextValue(rawSignerDetails);
  }
  const updatedPermissions = JSON.parse(rawUpdatedPermissions.toString());

  const permissions = await Permissions.get(address);
  if (!permissions) {
    throw new Error(`Permissions for account ${address} were not found`);
  }

  const { assets, portfolios, transactionGroups, transactions } =
    getPermissions(updatedPermissions);

  permissions.assets = assets;
  permissions.portfolios = portfolios;
  permissions.transactions = transactions;
  permissions.transactionGroups = transactionGroups;
  permissions.updatedBlockId = args.blockId;

  await permissions.save();
};

type MeshAccount = string | { account: string };

export const handleSecondaryKeysRemoved = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const [, rawAccounts] = args.params;
  const accounts = rawAccounts.toJSON() as MeshAccount[];

  const removePromises = accounts.map(account => {
    let address;
    if (typeof account === 'string') {
      // for chain version >= 5.0.0
      address = account;
    } else {
      // for chain version < 5.0.0
      ({ account: address } = account);
    }

    return [Account.remove(address), Permissions.remove(address)];
  });

  await Promise.all(removePromises.flat());
};

export const handleSignerLeft = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const [, rawAccount] = args.params;

  logger.info(`got raw account: ${rawAccount.toJSON()}`);

  const account = rawAccount.toJSON() as MeshAccount;

  let address;
  if (typeof account === 'string') {
    // for chain version >= 5.0.0
    address = account;
  } else {
    // for chain version < 5.0.0
    ({ account: address } = account);
  }

  logger.info('removing account for address: ', address);

  await Promise.all([Account.remove(address), Permissions.remove(address)]);
};

export const handleSecondaryKeysFrozen = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, eventId, params } = extractArgs(event);

  const [rawDid] = params;
  const did = getTextValue(rawDid);

  const identity = await getIdentity(did);

  identity.secondaryKeysFrozen = true;
  identity.updatedBlockId = blockId;
  identity.eventId = eventId;

  await identity.save();
};

export const handleSecondaryKeysUnfrozen = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, eventId, params } = extractArgs(event);

  const [rawDid] = params;
  const did = getTextValue(rawDid);

  const identity = await getIdentity(did);

  identity.secondaryKeysFrozen = false;
  identity.updatedBlockId = blockId;
  identity.eventId = eventId;

  await identity.save();
};

export const handleSecondaryKeysAdded = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const { eventId, createdBlockId: blockId, datetime } = getEventParams(args);

  const promises = [];
  const [rawDid, rawAccounts] = args.params;

  const did = getTextValue(rawDid);
  const accounts = JSON.parse(rawAccounts.toString());

  const { id: identityId } = await getIdentity(did);

  accounts.forEach((accountWithPermissions: any) => {
    const { permissions, ...rest } = accountWithPermissions;
    let address;
    if ('key' in rest) {
      // for chain version >= 5.0.0
      address = rest.key;
    } else if ('signer' in rest) {
      // for chain version < 5.0.0
      address = rest.signer.account;
    }

    const { assets, portfolios, transactions, transactionGroups } = getPermissions(permissions);

    promises.push(
      createPermissions(
        {
          assets,
          portfolios,
          transactions,
          transactionGroups,
          datetime,
        },
        address,
        blockId
      )
    );

    promises.push(
      createAccount(
        {
          address,
          identityId,
          permissionsId: address,
          eventId,
          datetime,
        },
        blockId
      )
    );
  });

  await Promise.all(promises);
};

export const handlePrimaryKeyUpdated = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const { eventId, createdBlockId: blockId, datetime, blockEventId } = getEventParams(args);

  const [rawDid, , newKey] = args.params;

  const did = getTextValue(rawDid);
  const address = getTextValue(newKey);

  const identity = await getIdentity(did);
  const [account, permissions] = await Promise.all([
    Account.get(identity.primaryAccount),
    Permissions.get(identity.primaryAccount),
  ]);

  identity.primaryAccount = address;
  identity.updatedBlockId = blockId;
  identity.eventId = eventId;

  // remove the identity mapping from account and set permissions to null
  account.identityId = undefined;
  account.permissionsId = undefined;
  account.eventId = eventId;
  account.updatedBlockId = blockId;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { assets, portfolios, transactionGroups, transactions } = permissions || {
    transactionGroups: [],
  };

  await Promise.all([
    createPermissions(
      {
        assets,
        portfolios,
        transactions,
        transactionGroups,
        datetime,
      },
      address,
      blockId
    ),
    createAccount(
      {
        address,
        identityId: identity.id,
        permissionsId: address,
        eventId,
        datetime,
      },
      blockId
    ),
    identity.save(),
    // unlink the old account from the identity
    account.save(),
    Permissions.remove(account.id),
    createHistoryEntry(eventId, identity.id, account.id, blockId, datetime, blockEventId, {
      assets,
      portfolios,
      transactionGroups,
      transactions,
    }),
  ]);
};

export const handleSecondaryKeyLeftIdentity = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const { eventId, createdBlockId: blockId, datetime, blockEventId } = getEventParams(args);

  const [, rawAccount] = args.params;
  const address = getTextValue(rawAccount);

  const accountEntity = await Account.get(address);
  const did = accountEntity.identityId;

  accountEntity.identityId = undefined;
  accountEntity.permissionsId = undefined;
  accountEntity.eventId = eventId;
  accountEntity.updatedBlockId = blockId;

  await Promise.all([
    accountEntity.save(),
    Permissions.remove(address),
    createHistoryEntry(eventId, did, address, blockId, datetime, blockEventId),
  ]);
};

export const handleCustomClaimTypeCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const [rawDid, rawCustomClaimTypeId, rawName] = params;

  const identityId = getTextValue(rawDid);
  const id = getNumberValue(rawCustomClaimTypeId);
  const name = bytesToString(rawName);

  const customClaimType = await CustomClaimType.get(`${id}`);

  if (!customClaimType) {
    await CustomClaimType.create({
      id: `${id}`,
      name,
      identityId,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  }
};
