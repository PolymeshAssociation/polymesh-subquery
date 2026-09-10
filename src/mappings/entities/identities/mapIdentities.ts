import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import {
  decodeEvent,
  legacyPermissionsUpdatedAddress,
  legacyRemovedAddresses,
  legacySecondaryKeyEntries,
  legacySignerLeftAddress,
} from '../../../decode';
import {
  Account,
  AssetPermissions,
  ChildIdentity,
  CustomClaimType,
  Event,
  EventIdEnum,
  Identity,
  KeyRole,
  KeyRoleEnum,
  PortfolioPermissions,
  TransactionPermissions,
} from '../../../types';
import {
  MeshPortfolio,
  bytesToString,
  getEventParams,
  getNumberValue,
  getTextValue,
  meshPortfolioToAssetHolder,
} from '../../../utils';
import { getAccountKeyType } from '../../../utils/accounts';
import { Attributes, extractArgs } from './../common';
import { closeIdentityKeys, openIdentityKey, rotateIdentityKey } from './mapIdentityKey';
import { createPortfolio, getPortfolio } from './mapPortfolio';

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

export const createAccount = async (
  args: Omit<Attributes<Account>, 'keyType' | 'evmAddress'>,
  blockId: string
): Promise<void> =>
  Account.create({
    id: args.address,
    ...args,
    ...getAccountKeyType(args.address),
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

  const { did: rawDid, primaryKey: rawAddress } = decodeEvent(event);

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

  const account = createAccount(
    {
      identityId: did,
      keyRole: KeyRoleEnum.PrimaryKey,
      eventId,
      address,
      datetime,
    },
    blockId
  );

  await Promise.all([account, defaultPortfolio]);

  // The primary key's membership record — a primary key always has full permission, so no
  // `permissions` snapshot is kept.
  await openIdentityKey(
    { identityId: did, address, role: KeyRole.Primary, addedReason: eventId, eventIdx },
    blockId
  );
};

export const handleChildDidCreated = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const { createdBlockId, updatedBlockId } = getEventParams(args);

  let childDid: string, parentDid: string;

  if (args instanceof Event) {
    const attributes = JSON.parse(args.attributesTxt);
    [{ value: parentDid }, { value: childDid }] = attributes;
  } else {
    const { did: rawParentDid, childDid: rawChildDid } = decodeEvent(event);

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
    childDid = getTextValue(decodeEvent(event).childDid);
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
            const data = meshPortfolioToAssetHolder(meshPortfolio);
            if ('account' in data) {
              return { did: data.identityId, account: data.account };
            }
            return { did: data.identityId, number: data.number };
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
  const { blockId, eventId, eventIdx } = extractArgs(event);

  const { account: rawSignerDetails, updatedPermissions: rawUpdatedPermissions } =
    decodeEvent(event);

  const address = legacyPermissionsUpdatedAddress(rawSignerDetails);
  const updatedPermissions = JSON.parse(rawUpdatedPermissions.toString());

  const { assets, portfolios, transactionGroups, transactions } =
    getPermissions(updatedPermissions);

  // A permissions change is a new membership interval: close the current one, open a fresh one
  // carrying the new permissions, so the change is first-class history rather than an overwrite.
  await rotateIdentityKey(
    {
      address,
      role: KeyRole.Secondary,
      reason: eventId,
      eventIdx,
      permissions: { assets, portfolios, transactions, transactionGroups },
    },
    blockId
  );
};

export const handleSecondaryKeysRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, eventId } = extractArgs(event);
  const { signers: rawAccounts } = decodeEvent(event);

  const addresses = legacyRemovedAddresses(rawAccounts);

  await Promise.all(
    addresses.flatMap(address => [
      Account.remove(address),
      closeIdentityKeys({ address, role: KeyRole.Secondary, removedReason: eventId }, blockId),
    ])
  );
};

export const handleSignerLeft = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, eventId } = extractArgs(event);
  const { signer: rawSigner } = decodeEvent(event);

  const address = legacySignerLeftAddress(rawSigner);

  await Promise.all([
    Account.remove(address),
    closeIdentityKeys({ address, role: KeyRole.Secondary, removedReason: eventId }, blockId),
  ]);
};

export const handleSecondaryKeysFrozen = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, eventId } = extractArgs(event);

  const did = getTextValue(decodeEvent(event).did);

  const identity = await getIdentity(did);

  identity.secondaryKeysFrozen = true;
  identity.updatedBlockId = blockId;
  identity.eventId = eventId;

  await identity.save();
};

export const handleSecondaryKeysUnfrozen = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, eventId } = extractArgs(event);

  const did = getTextValue(decodeEvent(event).did);

  const identity = await getIdentity(did);

  identity.secondaryKeysFrozen = false;
  identity.updatedBlockId = blockId;
  identity.eventId = eventId;

  await identity.save();
};

export const handleSecondaryKeysAdded = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const { eventId, createdBlockId: blockId, datetime, eventIdx } = getEventParams(args);

  const promises = [];
  const { did: rawDid, secondaryKeys: rawAccounts } = decodeEvent(event);

  const did = getTextValue(rawDid);

  const { id: identityId } = await getIdentity(did);

  legacySecondaryKeyEntries(rawAccounts).forEach(({ address, permissions }) => {
    const { assets, portfolios, transactions, transactionGroups } = getPermissions(permissions);

    promises.push(
      createAccount(
        {
          address,
          identityId,
          keyRole: KeyRoleEnum.SecondaryKey,
          eventId,
          datetime,
        },
        blockId
      ),
      openIdentityKey(
        {
          identityId,
          address,
          role: KeyRole.Secondary,
          permissions: { assets, portfolios, transactions, transactionGroups },
          addedReason: eventId,
          eventIdx,
        },
        blockId
      )
    );
  });

  await Promise.all(promises);
};

export const handlePrimaryKeyUpdated = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const { eventId, createdBlockId: blockId, datetime, eventIdx } = getEventParams(args);

  const { did: rawDid, newPrimaryKey: rawNewKey } = decodeEvent(event);

  const did = getTextValue(rawDid);
  const address = getTextValue(rawNewKey);

  const identity = await getIdentity(did);
  const account = await Account.get(identity.primaryAccount);

  identity.primaryAccount = address;
  identity.updatedBlockId = blockId;
  identity.eventId = eventId;

  // unlink the old primary key from the identity — `keyRole` rides the same write
  account.identityId = undefined;
  account.keyRole = KeyRoleEnum.Unlinked;
  account.eventId = eventId;
  account.updatedBlockId = blockId;

  await Promise.all([
    createAccount(
      {
        address,
        identityId: identity.id,
        keyRole: KeyRoleEnum.PrimaryKey,
        eventId,
        datetime,
      },
      blockId
    ),
    identity.save(),
    account.save(),
    // close the old primary's membership interval — the rotation history lives on `IdentityKey`
    closeIdentityKeys(
      { address: account.id, role: KeyRole.Primary, removedReason: eventId },
      blockId
    ),
  ]);

  // ...and open the new primary's. The rotation record G3 asks for: both rows stay queryable, the
  // old row's `validToBlock` equals the new one's `validFromBlock`.
  await openIdentityKey(
    { identityId: identity.id, address, role: KeyRole.Primary, addedReason: eventId, eventIdx },
    blockId
  );
};

export const handleSecondaryKeyLeftIdentity = async (event: SubstrateEvent): Promise<void> => {
  const { eventId, blockId } = extractArgs(event);

  const { account: rawAccount } = decodeEvent(event);

  const address = getTextValue(rawAccount);

  const accountEntity = await Account.get(address);

  accountEntity.identityId = undefined;
  accountEntity.keyRole = KeyRoleEnum.Unlinked;
  accountEntity.eventId = eventId;
  accountEntity.updatedBlockId = blockId;

  await Promise.all([
    accountEntity.save(),
    closeIdentityKeys({ address, role: KeyRole.Secondary, removedReason: eventId }, blockId),
  ]);
};

export const handleCustomClaimTypeCreated = async (event: SubstrateEvent): Promise<void> => {
  const { blockId } = extractArgs(event);
  const {
    did: rawDid,
    customClaimTypeId: rawCustomClaimTypeId,
    name: rawName,
  } = decodeEvent(event);

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
