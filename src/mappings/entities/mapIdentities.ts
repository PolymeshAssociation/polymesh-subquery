import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import {
  Account,
  AssetPermissions,
  EventIdEnum,
  Identity,
  ModuleIdEnum,
  Permissions,
  PortfolioPermissions,
  TransactionPermissions,
} from '../../types';
import { MeshPortfolio, getTextValue, meshPortfolioToPortfolio } from '../util';
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

  if (moduleId === ModuleIdEnum.identity) {
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
  }
}

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
    assets: undefined,
    portfolios: undefined,
    transactions: undefined,
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

  const promises: PromiseLike<unknown>[] = [];

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
