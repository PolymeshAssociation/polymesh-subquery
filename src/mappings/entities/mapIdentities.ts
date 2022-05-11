import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { EventIdEnum, ModuleIdEnum } from './common';
import { Permissions } from '../../types/models/Permissions';
import { Account } from '../../types/models/Account';
import { Identity } from '../../types/models/Identity';
import { getFirstValueFromJson, getTextValue } from '../util';

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
      const did = getTextValue(params[0]);
      const address = getTextValue(params[1]);
      await Identity.create({
        id: did,
        did,
        primaryAccount: getTextValue(params[1]),
        secondaryKeysFrozen: false,
        blockId,
        datetime,
      }).save();

      await Permissions.create({
        id: address,
        assets: null,
        portfolios: null,
        transactions: null,
        transactionGroups: [],
        createdBlockId: blockId,
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
    }

    if (eventId === EventIdEnum.SecondaryKeysAdded) {
      const { id: identityId } = await fetchIdentity(params[0]);

      const accountsList = params[1].toJSON() as any[];

      const promises = [];

      for (const account of accountsList) {
        const address = account.signer.account;

        const { assets, portfolios, transactions, transactionGroups } = getPermissions(
          account.permissions
        );

        promises.push(
          Permissions.create({
            id: address,
            assets,
            portfolios,
            transactions,
            transactionGroups,
            createdBlockId: blockId,
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
      }

      await Promise.all(promises);
    }

    if (eventId === EventIdEnum.SecondaryKeysFrozen) {
      const identity = await fetchIdentity(params[0]);
      identity.secondaryKeysFrozen = true;
      await identity.save();
    }

    if (eventId === EventIdEnum.SecondaryKeysUnfrozen) {
      const identity = await fetchIdentity(params[0]);
      identity.secondaryKeysFrozen = false;
      await identity.save();
    }

    if (eventId === EventIdEnum.SecondaryKeysRemoved) {
      await fetchIdentity(params[0]);
      const accountsRemoved = params[1].toJSON() as any[];
      const accounts = accountsRemoved.map(account => Account.remove(account.account));

      await Promise.all(accounts);
    }

    if (eventId === EventIdEnum.SecondaryKeyPermissionsUpdated) {
      await fetchIdentity(params[0]);
      const address = getFirstValueFromJson(params[1])['account'];
      const permissions = await Permissions.get(address);
      const { assets, portfolios, transactions, transactionGroups } = getPermissions(
        params[3].toJSON() as any
      );

      permissions.assets = assets;
      permissions.portfolios = portfolios;
      permissions.transactions = transactions;
      permissions.transactionGroups = transactionGroups;
      permissions.updatedBlockId = `${blockId}`;
      await permissions.save();
    }
  }
}

function getPermissions(accountPermissions: Record<string, unknown>) {
  logger.info(JSON.stringify(accountPermissions));
  let assets,
    portfolios,
    transactions,
    transactionGroups = [];

  let type;
  Object.keys(accountPermissions).forEach(key => {
    logger.info(key);
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
          values: portfolioPermissions[type],
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
}

async function fetchIdentity(param: Codec) {
  const did = getTextValue(param);

  const identity = await Identity.get(did);
  if (!identity) {
    throw new Error(`Identity with DID ${did} was not found`);
  }
  return identity;
}
