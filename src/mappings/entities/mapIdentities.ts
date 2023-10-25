import { SubstrateEvent } from '@subql/types';
import {
  Account,
  AccountHistory,
  AssetPermissions,
  ChildIdentity,
  Event,
  EventIdEnum,
  Identity,
  ModuleIdEnum,
  Permissions,
  PermissionsJson,
  PortfolioPermissions,
  TransactionPermissions,
} from '../../types';
import {
  MeshPortfolio,
  getAccountKey,
  getEventParams,
  getTextValue,
  meshPortfolioToPortfolio,
} from '../util';
import { Attributes, HandlerArgs } from './common';
import { createPortfolio, getPortfolio } from './mapPortfolio';

/**
 * Subscribes to the Identities related events
 */
export async function mapIdentities(args: HandlerArgs | Event, ss58Format?: number): Promise<void> {
  const { moduleId, eventId } = args;

  if (moduleId !== ModuleIdEnum.identity) {
    return;
  }

  if (eventId === EventIdEnum.DidCreated) {
    await handleDidCreated(args, ss58Format);
  }

  if (eventId === EventIdEnum.ChildDidCreated) {
    await handleChildDidCreated(args);
  }

  if (eventId === EventIdEnum.ChildDidUnlinked) {
    await handleChildDidUnlinked(args);
  }

  if (eventId === EventIdEnum.SecondaryKeysAdded) {
    await handleSecondaryKeysAdded(args, ss58Format);
  }

  if (eventId === EventIdEnum.SecondaryKeysFrozen) {
    await handleSecondaryKeysFrozen(args, true);
  }

  if (eventId === EventIdEnum.SecondaryKeysUnfrozen) {
    await handleSecondaryKeysFrozen(args, false);
  }

  if (eventId === EventIdEnum.SecondaryKeysRemoved) {
    await handleSecondaryKeysRemoved(args, ss58Format);
  }

  if (eventId === EventIdEnum.SecondaryKeyPermissionsUpdated) {
    await handleSecondaryKeysPermissionsUpdated(args, ss58Format);
  }

  if (eventId === EventIdEnum.PrimaryKeyUpdated) {
    await handlePrimaryKeyUpdated(args, ss58Format);
  }

  if (eventId === EventIdEnum.SecondaryKeyLeftIdentity) {
    await handleSecondaryKeyLeftIdentity(args, ss58Format);
  }
}

const createHistoryEntry = async (
  eventId: EventIdEnum,
  identity: string,
  address: string,
  blockId: string,
  datetime: Date,
  eventIdx: number,
  permissions?: PermissionsJson
): Promise<void> =>
  AccountHistory.create({
    id: `${blockId}/${eventIdx}`,
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
  event: SubstrateEvent
): Promise<void> => {
  const identity = await Identity.get(did);
  if (!identity) {
    await createIdentity(
      {
        did,
        primaryAccount: '',
        eventId: event.event.method as EventIdEnum,
        secondaryKeysFrozen: false,
        datetime: event.block.timestamp,
      },
      blockId
    );

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

const handleDidCreated = async (args: HandlerArgs | Event, ss58Format?: number): Promise<void> => {
  const { eventId, createdBlockId: blockId, datetime, eventIdx } = await getEventParams(args);

  let did: string, address: string;

  if (args instanceof Event) {
    const attributes = JSON.parse(args.attributesTxt);
    const [{ value: identityId }, { value: addressHex }] = attributes;

    did = identityId;
    address = getAccountKey(addressHex, ss58Format);
  } else {
    const [rawDid, rawAddress] = args.params;

    did = getTextValue(rawDid);
    address = getTextValue(rawAddress);
  }

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

const handleChildDidCreated = async (args: HandlerArgs | Event): Promise<void> => {
  const { createdBlockId, updatedBlockId } = await getEventParams(args);

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

const handleChildDidUnlinked = async (args: HandlerArgs | Event): Promise<void> => {
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

const handleSecondaryKeysPermissionsUpdated = async (
  args: HandlerArgs | Event,
  ss58Format?: number
): Promise<void> => {
  let address;
  let updatedPermissions;
  if (args instanceof Event) {
    const attributes = JSON.parse(args.attributesTxt);
    let addressHex;
    [, { value: addressHex }, , { value: updatedPermissions }] = attributes;
    if (typeof addressHex === 'string') {
      address = getAccountKey(addressHex, ss58Format);
    } else {
      addressHex = addressHex.signer.account || addressHex.signer.Account;
      address = getAccountKey(addressHex, ss58Format);
    }
  } else {
    const [, rawSignerDetails, , rawUpdatedPermissions] = args.params;

    if (rawSignerDetails instanceof Map) {
      // for chain version < 5.0.0
      const signer = rawSignerDetails.get('signer').toString();
      address = JSON.parse(signer).account;
    } else {
      // for chain version >= 5.0.0
      address = getTextValue(rawSignerDetails);
    }
    updatedPermissions = JSON.parse(rawUpdatedPermissions.toString());
  }

  const permissions = await Permissions.get(address);
  if (!permissions) {
    throw new Error(`Permissions for account ${address} were not found`);
  }

  const updatedPermissionsValue = getPermissions(updatedPermissions);

  Object.assign(permissions, {
    ...updatedPermissionsValue,
    updatedBlockId: args.blockId,
  });

  await permissions.save();
};

type MeshAccount = string | { account: string };

const handleSecondaryKeysRemoved = async (
  args: HandlerArgs | Event,
  ss58Format?: number
): Promise<void> => {
  let accounts;
  if (args instanceof Event) {
    const attributes = JSON.parse(args.attributesTxt);
    [, { value: accounts }] = attributes;
  } else {
    const [, rawAccounts] = args.params;
    accounts = rawAccounts.toJSON() as MeshAccount[];
  }

  const removePromises = accounts.map(account => {
    let address;
    if (typeof account === 'string') {
      // for chain version >= 5.0.0
      address = account;
    } else {
      // for chain version < 5.0.0
      ({ account: address } = account);
    }
    if (ss58Format) {
      address = getAccountKey(address, ss58Format);
    }
    return [Account.remove(address), Permissions.remove(address)];
  });

  await Promise.all(removePromises.flat());
};

const handleSecondaryKeysFrozen = async (
  args: HandlerArgs | Event,
  frozen: boolean
): Promise<void> => {
  const { blockId, eventId } = args;
  let did: string;

  if (args instanceof Event) {
    const attributes = JSON.parse(args.attributesTxt);
    [{ value: did }] = attributes;
  } else {
    const [rawDid] = args.params;
    did = getTextValue(rawDid);
  }

  const identity = await getIdentity(did);

  Object.assign(identity, {
    secondaryKeysFrozen: frozen,
    updatedBlockId: blockId,
    eventId,
  });

  await identity.save();
};

const handleSecondaryKeysAdded = async (
  args: HandlerArgs | Event,
  ss58Format?: number
): Promise<void> => {
  const { eventId, createdBlockId: blockId, datetime } = await getEventParams(args);

  const promises = [];
  let did, accounts;
  if (args instanceof Event) {
    const attributes = JSON.parse(args.attributesTxt);
    [{ value: did }, { value: accounts }] = attributes;
  } else {
    const [rawDid, rawAccounts] = args.params;

    did = getTextValue(rawDid);
    accounts = JSON.parse(rawAccounts.toString());
  }

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

    // for migration cases
    if (ss58Format) {
      address = getAccountKey(address, ss58Format);
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

const handlePrimaryKeyUpdated = async (
  args: HandlerArgs | Event,
  ss58Format?: number
): Promise<void> => {
  const { eventId, createdBlockId: blockId, datetime, eventIdx } = await getEventParams(args);

  let did: string, address: string;

  if (args instanceof Event) {
    const attributes = JSON.parse(args.attributesTxt);
    const [{ value: identityId }, , { value: addressHex }] = attributes;

    did = identityId;
    address = getAccountKey(addressHex, ss58Format);
  } else {
    const [rawDid, , newKey] = args.params;

    did = getTextValue(rawDid);
    address = getTextValue(newKey);
  }

  const identity = await getIdentity(did);
  const [account, permissions] = await Promise.all([
    Account.get(identity.primaryAccount),
    Permissions.get(identity.primaryAccount),
  ]);

  Object.assign(identity, {
    primaryAccount: address,
    updatedBlockId: blockId,
    eventId,
  });

  // remove the identity mapping from account and set permissions to null
  Object.assign(account, {
    identityId: undefined,
    permissionsId: undefined,
    eventId,
    updatedBlockId: blockId,
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { assets, portfolios, transactionGroups, transactions } = permissions;

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
    createHistoryEntry(eventId, identity.id, account.id, blockId, datetime, eventIdx, {
      assets,
      portfolios,
      transactionGroups,
      transactions,
    }),
  ]);
};

const handleSecondaryKeyLeftIdentity = async (
  args: HandlerArgs | Event,
  ss58Format?: number
): Promise<void> => {
  let address: string;
  const { eventId, createdBlockId: blockId, datetime, eventIdx } = await getEventParams(args);

  if (args instanceof Event) {
    const attributes = JSON.parse(args.attributesTxt);
    const [, { value: addressHex }] = attributes;
    address = getAccountKey(addressHex, ss58Format);
  } else {
    const [, rawAccount] = args.params;
    address = getTextValue(rawAccount);
  }

  const accountEntity = await Account.get(address);
  const did = accountEntity.identityId;

  Object.assign(accountEntity, {
    identityId: undefined,
    permissionsId: undefined,
    eventId,
    updatedBlockId: blockId,
  });

  await Promise.all([
    accountEntity.save(),
    Permissions.remove(address),
    createHistoryEntry(eventId, did, address, blockId, datetime, eventIdx),
  ]);
};
