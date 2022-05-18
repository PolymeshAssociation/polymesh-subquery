import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { AssetPermissions, PortfolioPermissions, TransactionPermissions } from '../../types';
import { Account } from '../../types/models/Account';
import { Identity } from '../../types/models/Identity';
import { Permissions } from '../../types/models/Permissions';
import { getTextValue } from '../util';
import { EventIdEnum, ModuleIdEnum } from './common';

/**
 * Subscribes to the Identities related events
 */
export async function mapIdentities(
  blockId: number,
  eventId: EventIdEnum,
  moduleId: ModuleIdEnum,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> {
  const datetime = event.block.timestamp;

  if (moduleId === ModuleIdEnum.Identity) {
    if (eventId === EventIdEnum.DidCreated) {
      await handleDidCreated(blockId, eventId, params, datetime);
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
  blockId: number,
  eventId: EventIdEnum,
  params: Codec[],
  datetime: Date
): Promise<void> => {
  const did = getTextValue(params[0]);
  const address = getTextValue(params[1]);
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

  await Permissions.create({
    id: address,
    assets: null,
    portfolios: null,
    transactions: null,
    transactionGroups: [],
    createdBlockId: blockId,
    updatedBlockId: blockId,
    datetime,
  }).save();

  await Account.create({
    id: address,
    identityId: did,
    permissionsId: address,
    eventId,
    address,
    blockId,
    datetime,
  }).save();
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
  blockId: number,
  params: Codec[]
): Promise<void> => {
  await getIdentity(params[0]);

  const {
    signer: { account: address },
  } = JSON.parse(params[1].toString());

  const permissions = await Permissions.get(address);
  if (!permissions) {
    throw new Error(`Permissions for account ${address} were not found`);
  }

  const updatedPermissions = getPermissions(JSON.parse(params[3].toString()));

  Object.assign(permissions, {
    ...updatedPermissions,
    updatedBlockId: blockId,
  });

  await permissions.save();
};

const handleSecondaryKeysRemoved = async (params: Codec[]): Promise<void> => {
  await getIdentity(params[0]);

  const accounts = JSON.parse(params[1].toString());

  const removePromises = accounts.map(({ account }) => Account.remove(account));

  await Promise.all(removePromises);
};

const handleSecondaryKeysFrozen = async (
  blockId: number,
  eventId: EventIdEnum,
  params: Codec[],
  frozen: boolean
): Promise<void> => {
  const identity = await getIdentity(params[0]);

  Object.assign(identity, {
    secondaryKeysFrozen: frozen,
    updatedBlockId: blockId,
    eventId,
  });

  await identity.save();
};

const handleSecondaryKeysAdded = async (
  blockId: number,
  eventId: EventIdEnum,
  params: Codec[],
  datetime: Date
): Promise<void> => {
  const { id: identityId } = await getIdentity(params[0]);

  const accounts = JSON.parse(params[1].toString());

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
        blockId,
        datetime,
      }).save()
    );
  });

  await Promise.all(promises);
};
