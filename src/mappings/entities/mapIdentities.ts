import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { AccountHistoryProps } from 'polymesh-subql/types/models/AccountHistory';
import {
  Account,
  AccountHistory,
  AssetPermissions,
  EventIdEnum,
  Identity,
  ModuleIdEnum,
  Permissions,
  PortfolioPermissions,
  TransactionPermissions,
} from '../../types';
import { getTextValue } from '../util';
import { HandlerArgs } from './common';
import { createPortfolio, getPortfolio } from './mapPortfolio';

/**
 * Subscribes to the Identities related events
 */
export async function mapIdentities({
  blockId,
  eventId,
  moduleId,
  params,
  event,
}: HandlerArgs): Promise<void> {
  const datetime = event.block.timestamp;

  if (moduleId !== ModuleIdEnum.identity) {
    return;
  }

  if (eventId === EventIdEnum.DidCreated) {
    await handleDidCreated(blockId, eventId, params, datetime, event.idx);
  }

  if (eventId === EventIdEnum.SecondaryKeysAdded) {
    await handleSecondaryKeysAdded(blockId, eventId, params, datetime);
  }

  if (eventId === EventIdEnum.SecondaryKeysFrozen) {
    await handleSecondaryKeysFrozen(blockId, eventId, params, true);
  }

  if (eventId === EventIdEnum.SecondaryKeysUnfrozen) {
    await handleSecondaryKeysFrozen(blockId, eventId, params, false);
  }

  if (eventId === EventIdEnum.SecondaryKeysRemoved) {
    await handleSecondaryKeysRemoved(params);
  }

  if (eventId === EventIdEnum.SecondaryKeyPermissionsUpdated) {
    await handleSecondaryKeysPermissionsUpdated(blockId, params);
  }

  if (eventId === EventIdEnum.PrimaryKeyUpdated) {
    await handlePrimaryKeyUpdated(blockId, eventId, params, datetime, event);
  }

  if (eventId === EventIdEnum.SecondaryKeyLeftIdentity) {
    await handleSecondaryKeyLeftIdentity(params, eventId, blockId, datetime, event);
  }
}

const createHistoryEntry = async (
  eventId: EventIdEnum,
  identityId: string,
  address: string,
  blockId: string,
  datetime: Date,
  event: SubstrateEvent
): Promise<void> => {
  const historyData: Omit<AccountHistoryProps, 'id'> = {
    eventId,
    accountId: address,
    identityId,
    permissionsId: address,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    datetime,
  };

  const identifier = `${blockId}/${event.idx}`;
  const historyEntry = new AccountHistory(identifier);
  Object.assign(historyEntry, historyData);

  await historyEntry.save();
};

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

/**
 * Creates an Identity if already not present. It also creates default Portfolio for that Identity
 *
 * @note WARNING: This function should only be used for the events that do not validate a DID to exists, before execution of the underlying extrinsic.
 * For e.g. `settlement.InstructionCreated` as it doesn't validates the target DID
 */
export const createIdentityIfNotExists = async (
  did: string,
  blockId: string,
  event: SubstrateEvent
): Promise<void> => {
  let identity = await Identity.get(did);
  if (!identity) {
    identity = Identity.create({
      id: did,
      did,
      primaryAccount: '',
      eventId: event.event.method as EventIdEnum,
      secondaryKeysFrozen: false,
      datetime: event.block.timestamp,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    });

    await identity.save();

    await createPortfolio(
      {
        identityId: did,
        number: 0,
        eventIdx: event.idx,
      },
      blockId
    );
  }
};

const handleDidCreated = async (
  blockId: string,
  eventId: EventIdEnum,
  params: Codec[],
  datetime: Date,
  eventIdx: number
): Promise<void> => {
  const [rawDid, rawAddress] = params;

  const did = getTextValue(rawDid);
  const address = getTextValue(rawAddress);

  let defaultPortfolio;
  const identity = await Identity.get(did);
  if (identity) {
    Object.assign(identity, {
      primaryAccount: address,
      updatedBlockId: blockId,
      eventId,
      datetime,
    });
    await identity.save();

    const portfolio = await getPortfolio({ identityId: did, number: 0 });
    portfolio.updatedBlockId = blockId;
    defaultPortfolio = portfolio.save();
  } else {
    await Identity.create({
      id: did,
      did,
      primaryAccount: address,
      secondaryKeysFrozen: false,
      eventId,
      createdBlockId: blockId,
      updatedBlockId: blockId,
      datetime,
    }).save();

    defaultPortfolio = createPortfolio(
      {
        identityId: did,
        number: 0,
        eventIdx,
      },
      blockId
    );
  }

  const permissions = Permissions.create({
    id: address,
    assets: null,
    portfolios: null,
    transactions: null,
    transactionGroups: [],
    createdBlockId: blockId,
    updatedBlockId: blockId,
    datetime,
  }).save();

  const account = Account.create({
    id: address,
    identityId: did,
    permissionsId: address,
    eventId,
    address,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    datetime,
  }).save();

  await Promise.all([permissions, account, defaultPortfolio]);
};

const getPermissions = (
  accountPermissions: Record<string, unknown>
): {
  assets: AssetPermissions | null;
  portfolios: PortfolioPermissions | null;
  transactions: TransactionPermissions | null;
  transactionGroups: string[];
} => {
  let assets: AssetPermissions,
    portfolios: PortfolioPermissions,
    transactions: TransactionPermissions,
    transactionGroups: string[] = [];

  let type: string;
  Object.keys(accountPermissions).forEach(key => {
    switch (key) {
      case 'asset': {
        const assetPermissions = accountPermissions.asset;
        type = Object.keys(assetPermissions)[0];
        assets = {
          type,
          values: assetPermissions[type],
        };
        break;
      }
      case 'portfolio': {
        const portfolioPermissions = accountPermissions.portfolio;
        type = Object.keys(portfolioPermissions)[0];
        portfolios = {
          type,
          values: portfolioPermissions[type]?.map(({ did, kind: { user: number } }) => ({
            did,
            number: number || null,
          })),
        };
        break;
      }
      case 'extrinsic': {
        const transactionPermissions = accountPermissions.extrinsic;
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

const handleSecondaryKeysPermissionsUpdated = async (
  blockId: string,
  params: Codec[]
): Promise<void> => {
  const [, rawSignerDetails, , rawUpdatedPermissions] = params;

  let address;
  if (rawSignerDetails instanceof Map) {
    // for chain version < 5.0.0
    const signer = rawSignerDetails.get('signer').toString();
    address = JSON.parse(signer).account;
  } else {
    // for chain version >= 5.0.0
    address = getTextValue(rawSignerDetails);
  }

  const permissions = await Permissions.get(address);
  if (!permissions) {
    throw new Error(`Permissions for account ${address} were not found`);
  }

  const updatedPermissions = getPermissions(JSON.parse(rawUpdatedPermissions.toString()));

  Object.assign(permissions, {
    ...updatedPermissions,
    updatedBlockId: blockId,
  });

  await permissions.save();
};

type MeshAccount = string | { account: string };

const handleSecondaryKeysRemoved = async (params: Codec[]): Promise<void> => {
  const [, rawAccounts] = params;

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

const handleSecondaryKeysFrozen = async (
  blockId: string,
  eventId: EventIdEnum,
  params: Codec[],
  frozen: boolean
): Promise<void> => {
  const [rawDid] = params;
  const identity = await getIdentity(getTextValue(rawDid));

  Object.assign(identity, {
    secondaryKeysFrozen: frozen,
    updatedBlockId: blockId,
    eventId,
  });

  await identity.save();
};

const handleSecondaryKeysAdded = async (
  blockId: string,
  eventId: EventIdEnum,
  params: Codec[],
  datetime: Date
): Promise<void> => {
  const [rawDid, rawAccounts] = params;

  const { id: identityId } = await getIdentity(getTextValue(rawDid));

  const accounts = JSON.parse(rawAccounts.toString());

  const promises = [];

  accounts.forEach(({ permissions, ...rest }) => {
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
      Permissions.create({
        id: address,
        assets,
        portfolios,
        transactions,
        transactionGroups,
        createdBlockId: blockId,
        updatedBlockId: blockId,
        datetime,
      }).save()
    );

    promises.push(
      Account.create({
        id: address,
        address,
        identityId,
        permissionsId: address,
        eventId,
        createdBlockId: blockId,
        updatedBlockId: blockId,
        datetime,
      }).save()
    );
  });

  await Promise.all(promises);
};

const handlePrimaryKeyUpdated = async (
  blockId: string,
  eventId,
  params: Codec[],
  datetime: Date,
  event: SubstrateEvent
): Promise<void> => {
  const [rawDid, , newKey] = params;
  const address = getTextValue(newKey);

  const identity = await getIdentity(getTextValue(rawDid));
  const [account, permissions] = await Promise.all([
    Account.get(identity.primaryAccount),
    Permissions.get(identity.primaryAccount),
  ]);

  Object.assign(identity, {
    primaryAccount: address,
    updatedBlockId: blockId,
    eventId,
  });

  const newPermissions = new Permissions(address);
  account.identityId = null;
  permissions.id = address;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, ...oldPermissions } = permissions;

  Object.assign(newPermissions, oldPermissions);

  await Promise.all([
    identity.save(),
    newPermissions.save(),
    Account.create({
      id: address,
      address,
      identityId: identity.id,
      permissionsId: address,
      eventId,
      createdBlockId: blockId,
      updatedBlockId: blockId,
      datetime,
    }).save(),
    // unlink the old account from the identity
    account.save(),
    Permissions.remove(account.id),
    createHistoryEntry(eventId, identity.id, account.id, blockId, datetime, event),
  ]);
};

const handleSecondaryKeyLeftIdentity = async (
  params: Codec[],
  eventId: EventIdEnum,
  blockId: string,
  datetime: Date,
  event: SubstrateEvent
): Promise<void> => {
  const [, rawAccount] = params;

  const account = JSON.parse(rawAccount.toString()) as MeshAccount;

  let address;
  if (typeof account === 'string') {
    // for chain version >= 5.0.0
    address = account;
  } else {
    // for chain version < 5.0.0
    ({ account: address } = account);
  }

  const accountEntity = await Account.get(address);
  const did = accountEntity.identityId;
  accountEntity.identityId = null;

  await Promise.all([
    Permissions.remove(address),
    accountEntity.save(),
    createHistoryEntry(eventId, did, address, blockId, datetime, event),
  ]);
};
