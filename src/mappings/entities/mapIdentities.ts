import { Codec } from '@polkadot/types/types';
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
import { getTextValue } from '../util';
import { HandlerArgs } from './common';
import { createPortfolio } from './mapPortfolio';

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

const getIdentity = async (param: Codec): Promise<Identity> => {
  const did = getTextValue(param);

  const identity = await Identity.get(did);
  if (!identity) {
    throw new Error(`Identity with DID ${did} was not found`);
  }

  return identity;
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

  const identity = Identity.create({
    id: did,
    did,
    primaryAccount: address,
    secondaryKeysFrozen: false,
    eventId,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    datetime,
  }).save();

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

  const defaultPortfolio = createPortfolio(
    {
      identityId: did,
      number: 0,
      eventIdx,
    },
    blockId
  );

  await Promise.all([identity, permissions, account, defaultPortfolio]);
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

  const {
    signer: { account: address },
  } = JSON.parse(rawSignerDetails.toString());

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

const handleSecondaryKeysRemoved = async (params: Codec[]): Promise<void> => {
  const [, rawAccounts] = params;

  const accounts = JSON.parse(rawAccounts.toString());

  const removePromises = accounts.map(({ account }) => Account.remove(account));

  await Promise.all(removePromises);
};

const handleSecondaryKeysFrozen = async (
  blockId: string,
  eventId: EventIdEnum,
  params: Codec[],
  frozen: boolean
): Promise<void> => {
  const [rawDid] = params;
  const identity = await getIdentity(rawDid);

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

  const { id: identityId } = await getIdentity(rawDid);

  const accounts = JSON.parse(rawAccounts.toString());

  const promises = [];

  accounts.forEach(({ signer: { account: address }, permissions }) => {
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
