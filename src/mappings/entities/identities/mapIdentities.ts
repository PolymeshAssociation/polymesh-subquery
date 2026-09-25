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
  AnomalyKind,
  AssetPermissions,
  ChildIdentity,
  CustomClaimType,
  Event,
  EventIdEnum,
  Identity,
  IdentityKeyRole,
  AccountKeyRole,
  PortfolioPermissions,
  TransactionPermissions,
} from '../../../types';
import {
  MeshPortfolio,
  bytesToString,
  extractString,
  getEventParams,
  getNumberValue,
  getTextValue,
  meshPortfolioToAssetHolder,
} from '../../../utils';
import { upsertAccount } from '../../../utils/accounts';
import { recordAnomaly } from '../../../utils/anomaly';
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

export const createIdentity = async (
  args: Attributes<Identity>,
  blockEventId: string
): Promise<void> =>
  Identity.create({
    id: args.did,
    ...args,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
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
        secondaryKeysFrozen: false,
      },
      blockEventId
    );

    await createPortfolio(
      {
        identityId: did,
        number: 0,
      },
      blockEventId
    );
  }
};

export interface ResolveIdentityArgs {
  /** What referenced the DID — an event id, or a description of the path for a non-event caller */
  reason: string;
  eventIdx: number;
  /** Absent on the genesis scan, which runs outside any block's event stream */
  block?: SubstrateBlock;
  blockEventId: string;
}

/**
 * The identity a DID names, created from chain state when the index has never seen it.
 *
 * A relation cannot point at a row that is not there. Historical tracking emits no foreign keys,
 * so a dangling reference is accepted on write and only fails at query time — where a non-null
 * relation resolves to nothing and errors the field and everything selecting it. The index does
 * not necessarily hold every identity: the genesis scan seeds a fixed handful, and an index
 * started from a later block seeds none, so a handler can legitimately meet a DID registered
 * before its coverage begins.
 *
 * The chain is the fallback rather than a zero-filled placeholder row, which would put a
 * permanently wrong primary key in the index and never be corrected. A DID the chain does not
 * know either is recorded and dropped.
 */
export const resolveIdentity = async (
  did: string,
  { reason, eventIdx, block, blockEventId }: ResolveIdentityArgs
): Promise<string | undefined> => {
  if (await Identity.get(did)) {
    return did;
  }

  const record = await api.query.identity.didRecords(did);

  const detail = `${reason} referenced identity ${did}, which is neither indexed nor on chain`;

  if (record.isEmpty) {
    if (block) {
      await recordAnomaly({
        kind: AnomalyKind.MissingReferencedEntity,
        detail,
        block,
        eventIdx,
      });
    } else {
      // The genesis scan reads the DIDs it resolves out of chain storage itself, so it cannot
      // normally get here, and it has no block to attribute a row to.
      logger.warn(detail);
    }

    return undefined;
  }

  await createIdentity(
    {
      did,
      primaryAccount: extractString(record.toJSON(), 'primary_key') ?? '',
      secondaryKeysFrozen: false,
    },
    blockEventId
  );

  await createPortfolio({ identityId: did, number: 0 }, blockEventId);

  return did;
};

export const handleDidCreated = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);

  const { eventId, eventIdx, blockEventId } = getEventParams(args);

  const { did: rawDid, primaryKey: rawAddress } = decodeEvent(event);

  const did = getTextValue(rawDid);
  const address = getTextValue(rawAddress);

  let defaultPortfolio;
  const identity = await Identity.get(did);
  if (identity) {
    identity.primaryAccount = address;
    identity.updatedEventId = blockEventId;
    await identity.save();

    const portfolio = await getPortfolio({ identityId: did, number: 0 });

    portfolio.updatedEventId = blockEventId;
    defaultPortfolio = portfolio.save();
  } else {
    await createIdentity(
      {
        did,
        primaryAccount: address,
        secondaryKeysFrozen: false,
      },
      blockEventId
    );

    defaultPortfolio = createPortfolio(
      {
        identityId: did,
        number: 0,
      },
      blockEventId
    );
  }

  const account = upsertAccount(
    {
      identityId: did,
      keyRole: AccountKeyRole.PrimaryKey,
      address,
    },
    blockEventId
  );

  await Promise.all([account, defaultPortfolio]);

  // The primary key's membership record — a primary key always has full permission, so no
  // `permissions` snapshot is kept.
  await openIdentityKey(
    { identityId: did, address, role: IdentityKeyRole.PrimaryKey, addedReason: eventId, eventIdx },
    blockEventId
  );
};

export const handleChildDidCreated = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const { blockEventId } = getEventParams(args);

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
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
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
  const { blockEventId, eventId, eventIdx, block } = extractArgs(event);

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
      role: IdentityKeyRole.SecondaryKey,
      reason: eventId,
      eventIdx,
      permissions: { assets, portfolios, transactions, transactionGroups },
      block,
    },
    blockEventId
  );
};

interface UnlinkArgs {
  eventId: EventIdEnum;
  blockEventId: string;
  block: SubstrateBlock;
  eventIdx: number;
}

/**
 * Detaches a key from its identity, keeping the account row.
 *
 * Deleting the row instead would orphan everything that points at it — the membership interval
 * this event closes, the account's balance and every ledger entry — and the account is a non-null
 * relation on all of them, so those fields stop resolving. A primary-key rotation goes through
 * here too: the chain announces the incoming key as removed a moment before it becomes the
 * identity's primary key, and deleting it there costs the row its original provenance when the
 * next event recreates it.
 */
const unlinkAccount = async (
  address: string,
  { eventId, blockEventId, block, eventIdx }: UnlinkArgs
): Promise<void> => {
  const account = await Account.get(address);

  if (!account) {
    await recordAnomaly({
      kind: AnomalyKind.MissingReferencedEntity,
      detail: `${eventId} named account ${address}, which is not indexed`,
      block,
      eventIdx,
    });

    return;
  }

  account.identityId = undefined;
  account.keyRole = AccountKeyRole.Unlinked;
  account.updatedEventId = blockEventId;

  await account.save();
};

export const handleSecondaryKeysRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { eventId, blockEventId, block, eventIdx } = extractArgs(event);
  const { signers: rawAccounts } = decodeEvent(event);

  const addresses = legacyRemovedAddresses(rawAccounts);

  await Promise.all(
    addresses.flatMap(address => [
      unlinkAccount(address, { eventId, blockEventId, block, eventIdx }),
      closeIdentityKeys({ address, role: IdentityKeyRole.SecondaryKey, removedReason: eventId }, blockEventId),
    ])
  );
};

export const handleSignerLeft = async (event: SubstrateEvent): Promise<void> => {
  const { eventId, blockEventId, block, eventIdx } = extractArgs(event);
  const { signer: rawSigner } = decodeEvent(event);

  const address = legacySignerLeftAddress(rawSigner);

  await Promise.all([
    unlinkAccount(address, { eventId, blockEventId, block, eventIdx }),
    closeIdentityKeys({ address, role: IdentityKeyRole.SecondaryKey, removedReason: eventId }, blockEventId),
  ]);
};

export const handleSecondaryKeysFrozen = async (event: SubstrateEvent): Promise<void> => {
  const { blockEventId } = extractArgs(event);

  const did = getTextValue(decodeEvent(event).did);

  const identity = await getIdentity(did);

  identity.secondaryKeysFrozen = true;
  identity.updatedEventId = blockEventId;

  await identity.save();
};

export const handleSecondaryKeysUnfrozen = async (event: SubstrateEvent): Promise<void> => {
  const { blockEventId } = extractArgs(event);

  const did = getTextValue(decodeEvent(event).did);

  const identity = await getIdentity(did);

  identity.secondaryKeysFrozen = false;
  identity.updatedEventId = blockEventId;

  await identity.save();
};

export const handleSecondaryKeysAdded = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const { eventId, createdEventId: blockEventId, eventIdx } = getEventParams(args);

  const promises = [];
  const { did: rawDid, secondaryKeys: rawAccounts } = decodeEvent(event);

  const did = getTextValue(rawDid);

  const { id: identityId } = await getIdentity(did);

  legacySecondaryKeyEntries(rawAccounts).forEach(({ address, permissions }) => {
    const { assets, portfolios, transactions, transactionGroups } = getPermissions(permissions);

    promises.push(
      upsertAccount(
        {
          address,
          identityId,
          keyRole: AccountKeyRole.SecondaryKey,
        },
        blockEventId
      ),
      openIdentityKey(
        {
          identityId,
          address,
          role: IdentityKeyRole.SecondaryKey,
          permissions: { assets, portfolios, transactions, transactionGroups },
          addedReason: eventId,
          eventIdx,
        },
        blockEventId
      )
    );
  });

  await Promise.all(promises);
};

/**
 * `PrimaryKeyUpdated` — the identity's primary key changes hands.
 *
 * This handler is only half of the transition, and reads as if it leaks a membership interval
 * unless the rest is known. Both of the chain's rotation calls promote a key that is already a
 * secondary key of the same identity, and each emits a fixed sequence:
 *
 * ```
 * SecondaryKeysRemoved(did, [new primary])   closes the incoming key's secondary interval
 * PrimaryKeyUpdated(did, old, new)           this handler
 * SecondaryKeysAdded(did, [old primary])     only when the old key is demoted rather than dropped
 * ```
 *
 * Handlers run in event order, so the incoming key's secondary interval is already closed by the
 * time this runs and the demoted key is re-linked after it — no key holds two open intervals at
 * once. Closing the incoming key's interval here as well would close an interval that no longer
 * exists; reordering or removing either sibling handler is what would actually break the rotation.
 */
export const handlePrimaryKeyUpdated = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const { eventId, createdEventId: blockEventId, eventIdx } = getEventParams(args);

  const { did: rawDid, newPrimaryKey: rawNewKey } = decodeEvent(event);

  const did = getTextValue(rawDid);
  const address = getTextValue(rawNewKey);

  const identity = await getIdentity(did);
  // An identity created from a key record alone carries no primary key, so the outgoing account
  // can be absent. The rotation itself still stands: the new key is linked either way.
  const account = identity.primaryAccount ? await Account.get(identity.primaryAccount) : undefined;

  if (!account) {
    await recordAnomaly({
      kind: AnomalyKind.MissingReferencedEntity,
      detail: `${eventId} on identity ${did} found no account for the outgoing primary key`,
      block: args.block,
      eventIdx,
    });
  }

  identity.primaryAccount = address;
  identity.updatedEventId = blockEventId;

  const retireOldKey = account
    ? [
        // unlink the old primary key from the identity — `keyRole` rides the same write
        unlinkAccount(account.id, { eventId, blockEventId, block: args.block, eventIdx }),
        // close its membership interval — the rotation history lives on `IdentityKey`
        closeIdentityKeys(
          { address: account.id, role: IdentityKeyRole.PrimaryKey, removedReason: eventId },
          blockEventId
        ),
      ]
    : [];

  await Promise.all([
    upsertAccount(
      {
        address,
        identityId: identity.id,
        keyRole: AccountKeyRole.PrimaryKey,
      },
      blockEventId
    ),
    identity.save(),
    ...retireOldKey,
  ]);

  // ...and open the new primary's, so both rows stay queryable and the old row's `validToBlock`
  // equals the new one's `validFromBlock`.
  await openIdentityKey(
    { identityId: identity.id, address, role: IdentityKeyRole.PrimaryKey, addedReason: eventId, eventIdx },
    blockEventId
  );
};

export const handleSecondaryKeyLeftIdentity = async (event: SubstrateEvent): Promise<void> => {
  const { eventId, blockEventId, block, eventIdx } = extractArgs(event);

  const { account: rawAccount } = decodeEvent(event);

  const address = getTextValue(rawAccount);

  await Promise.all([
    unlinkAccount(address, { eventId, blockEventId, block, eventIdx }),
    closeIdentityKeys({ address, role: IdentityKeyRole.SecondaryKey, removedReason: eventId }, blockEventId),
  ]);
};

export const handleCustomClaimTypeCreated = async (event: SubstrateEvent): Promise<void> => {
  const { blockEventId } = extractArgs(event);
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
      createdEventId: blockEventId,
      updatedEventId: blockEventId,
    }).save();
  }
};
