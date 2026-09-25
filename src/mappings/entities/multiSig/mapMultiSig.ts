import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import {
  Account,
  AnomalyKind,
  MultiSig,
  MultiSigAdmin,
  MultiSigAdminStatusEnum,
  MultiSigSigner,
  MultiSigSignerStatusEnum,
  SignerTypeEnum,
} from '../../../types';
import {
  getMultiSigSigner,
  getMultiSigSigners,
  getNumberValue,
  getTextValue,
  is7xChain,
} from '../../../utils';
import { ledgerAccount, resolveKeyRole } from '../../../utils/accounts';
import { recordAnomaly } from '../../../utils/anomaly';
import { ResolveIdentityArgs, resolveIdentity } from '../identities/mapIdentities';
import { Attributes, extractArgs } from '../common';
import { MultiSigSignerProps } from '../../../types/models/MultiSigSigner';

/**
 * Creates a `MultiSig` and, first, the `Account` row it links to — a multisig is an account, so
 * the multisig address is both the `Account` id and the `MultiSig` id.
 */
export const createMultiSig = async (
  address: string,
  creatorId: string | undefined,
  creatorAccountId: string | undefined,
  signaturesRequired: number,
  blockId: string,
  datetime: Date,
  blockEventId: string
): Promise<void> => {
  await ledgerAccount(address, blockId, datetime, blockEventId);

  await MultiSig.create({
    id: `${address}`,
    accountId: address,
    creatorId,
    creatorAccountId,
    signaturesRequired,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();
};

/**
 * Re-derives an account's role from the chain's key record and saves it if it changed.
 *
 * `keyRole` is a cache of what `identity.keyRecords` says, so anything that can change a key's
 * standing — a signer accepting, being removed, or an offer lapsing — re-reads it rather than
 * writing a role the event only implies. The read is memoised for the block.
 */
const refreshKeyRole = async (
  account: Account,
  blockId: string,
  blockEventId: string
): Promise<void> => {
  const role = await resolveKeyRole(account.id, blockId);

  if (account.keyRole !== role) {
    account.keyRole = role;
    account.updatedEventId = blockEventId;

    await account.save();
  }
};

/**
 * The `Account` id for `MultiSigSigner.signerAccount`, creating the account row if it is new.
 *
 * Only `Account` signers get one — `SignerTypeEnum` also has `Identity` on pre-7.x runtimes,
 * which a relation cannot point at, so `signerValue` stays canonical and this returns undefined
 * for those. A signer key is an account with no identity of its own, so `ledgerAccount` gives it
 * a bare row.
 *
 * `keyRole` comes from the chain's key record rather than from the event. Creating a multisig and
 * authorising a signer are *offers*: the chain writes the signer's key record only once it
 * accepts, and it may never accept. Labelling the account from the offer would relabel a key that
 * is currently an identity's primary or secondary key, and nothing would put it back when the
 * offer lapsed.
 */
export const linkSignerAccount = async (
  signerType: SignerTypeEnum,
  signerValue: string,
  blockId: string,
  datetime: Date,
  blockEventId: string
): Promise<string | undefined> => {
  if (signerType !== SignerTypeEnum.Account) {
    return undefined;
  }

  const account = await ledgerAccount(signerValue, blockId, datetime, blockEventId);

  await refreshKeyRole(account, blockId, blockEventId);

  return signerValue;
};

export const createMultiSigSigner = async (
  multiSigAddress: string,
  signerType: SignerTypeEnum,
  signerValue: string,
  status: MultiSigSignerStatusEnum,
  blockId: string,
  datetime: Date,
  blockEventId: string
): Promise<void> => {
  const signerAccountId = await linkSignerAccount(
    signerType,
    signerValue,
    blockId,
    datetime,
    blockEventId
  );

  await MultiSigSigner.create({
    id: `${multiSigAddress}/${signerType}/${signerValue}`,
    multisigId: multiSigAddress,
    signerType,
    signerValue,
    signerAccountId,
    status,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();
};

/**
 * Records the identity administering a multisig.
 *
 * The DID comes from chain storage or from an event payload, neither of which says whether the
 * index holds that identity — and `admin` is a non-null relation, so a DID the index has never
 * seen would make the field unresolvable for every consumer selecting it. The identity is
 * resolved (and read from the chain if need be) first; a DID that resolves to nothing leaves no
 * row rather than a broken one.
 */
export const createMultiSigAdmin = async (
  multisigId: string,
  adminDid: string,
  blockId: string,
  blockEventId: string,
  identityContext: ResolveIdentityArgs
): Promise<void> => {
  const adminId = await resolveIdentity(adminDid, identityContext);

  if (!adminId) {
    return;
  }

  await MultiSigAdmin.create({
    id: `${multisigId}/${adminId}`,
    multisigId,
    adminId,
    status: MultiSigAdminStatusEnum.Authorized,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();
};

const getMultiSigSignerDetails = (
  params: Codec[],
  block: SubstrateBlock
): Omit<Attributes<MultiSigSigner>, 'status'> => {
  const [, rawMultiSigAddress, rawSigner] = params;
  const multisigId = getTextValue(rawMultiSigAddress);
  const signer = getMultiSigSigner(rawSigner, block);
  return {
    multisigId,
    ...signer,
  };
};

const getMultiSigSignersDetails = (
  params: Codec[],
  block: SubstrateBlock
): Omit<Attributes<MultiSigSigner>, 'status'>[] => {
  const [, rawMultiSigAddress, rawSigners] = params;
  const multisigId = getTextValue(rawMultiSigAddress);
  const signers = getMultiSigSigners(rawSigners, block);
  return signers.map(signer => ({
    multisigId,
    ...signer,
  }));
};

const handleMultiSigSignerStatus = async (
  event: SubstrateEvent,
  status: MultiSigSignerStatusEnum
): Promise<void> => {
  const { params, block, blockId, blockEventId, eventId, eventIdx } = extractArgs(event);

  const { multisigId, signerType, signerValue } = getMultiSigSignerDetails(params, block);
  const multiSigSigner = await MultiSigSigner.get(`${multisigId}/${signerType}/${signerValue}`);

  if (!multiSigSigner) {
    await recordAnomaly({
      kind: AnomalyKind.MissingReferencedEntity,
      detail: `${eventId} named signer ${signerValue} of multisig ${multisigId}, which is not indexed`,
      block,
      eventIdx,
    });

    return;
  }

  multiSigSigner.status = status;
  multiSigSigner.updatedEventId = blockEventId;
  await multiSigSigner.save();

  // The signer's standing just changed, so its account's cached role is re-read: accepting makes
  // it a signer key, being removed takes the role away again.
  const account = multiSigSigner.signerAccountId
    ? await Account.get(multiSigSigner.signerAccountId)
    : undefined;

  if (account) {
    await refreshKeyRole(account, blockId, blockEventId);
  }
};

export const handleMultiSigCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block, blockEventId, eventId, eventIdx } = extractArgs(event);
  const [rawDid, rawMultiSigAddress, rawCreator, rawSigners, rawSignaturesRequired] = params;

  const creator = getTextValue(rawDid);
  const creatorAccountId = getTextValue(rawCreator);
  const multiSigAddress = getTextValue(rawMultiSigAddress);
  const signers = getMultiSigSigners(rawSigners, block);
  const signaturesRequired = getNumberValue(rawSignaturesRequired);

  const multiSigPromise = createMultiSig(
    multiSigAddress,
    creator,
    creatorAccountId,
    signaturesRequired,
    blockId,
    block.timestamp,
    blockEventId
  );

  const signerParams: MultiSigSignerProps[] = await Promise.all(
    signers.map(
      async ({ signerType, signerValue }) =>
        ({
          id: `${multiSigAddress}/${signerType}/${signerValue}`,
          multisigId: multiSigAddress,
          signerType,
          signerValue,
          signerAccountId: await linkSignerAccount(
            signerType,
            signerValue,
            blockId,
            block.timestamp,
            blockEventId
          ),
          status: MultiSigSignerStatusEnum.Authorized,
          createdEventId: blockEventId,
          updatedEventId: blockEventId,
        } satisfies MultiSigSignerProps)
    )
  );

  const promises = [multiSigPromise, store.bulkCreate('MultiSigSigner', signerParams)];

  if (!is7xChain(block)) {
    promises.push(
      createMultiSigAdmin(multiSigAddress, creator, blockId, blockEventId, {
        reason: eventId,
        eventIdx,
        block,
        blockEventId,
      })
    );
  }

  await Promise.all(promises);
};

export const handleMultiSigAddedAdmin = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, blockEventId, block, eventId, eventIdx } = extractArgs(event);
  const [, rawMultiSigAddress, rawAdminDid] = params;

  const admin = getTextValue(rawAdminDid);
  const multisigId = getTextValue(rawMultiSigAddress);

  await createMultiSigAdmin(multisigId, admin, blockId, blockEventId, {
    reason: eventId,
    eventIdx,
    block,
    blockEventId,
  });
};

export const handleMultiSigRemovedAdmin = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockEventId } = extractArgs(event);
  const [, rawMultiSigAddress, rawAdminDid] = params;

  const admin = getTextValue(rawAdminDid);
  const multisigId = getTextValue(rawMultiSigAddress);

  const multiSigAdmin = await MultiSigAdmin.get(`${multisigId}/${admin}`);

  if (multiSigAdmin) {
    multiSigAdmin.status = MultiSigAdminStatusEnum.Removed;
    multiSigAdmin.updatedEventId = blockEventId;
    await multiSigAdmin.save();
  }
};

export const handleMultiSigSignerAuthorized = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block, blockEventId } = extractArgs(event);

  const { multisigId, signerType, signerValue } = getMultiSigSignerDetails(params, block);

  await createMultiSigSigner(
    multisigId,
    signerType,
    signerValue,
    MultiSigSignerStatusEnum.Authorized,
    blockId,
    block.timestamp,
    blockEventId
  );
};

export const handleMultiSigSignersAuthorized = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block, blockEventId } = extractArgs(event);

  const signerDetails = getMultiSigSignersDetails(params, block);

  const signerParams: MultiSigSignerProps[] = await Promise.all(
    signerDetails.map(
      async ({ multisigId, signerType, signerValue }) =>
        ({
          id: `${multisigId}/${signerType}/${signerValue}`,
          multisigId,
          signerType,
          signerValue,
          signerAccountId: await linkSignerAccount(
            signerType,
            signerValue,
            blockId,
            block.timestamp,
            blockEventId
          ),
          status: MultiSigSignerStatusEnum.Authorized,
          createdEventId: blockEventId,
          updatedEventId: blockEventId,
        } satisfies MultiSigSignerProps)
    )
  );

  await store.bulkCreate('MultiSigSigner', signerParams);
};

export const handleMultiSigSignerAdded = async (event: SubstrateEvent): Promise<void> => {
  await handleMultiSigSignerStatus(event, MultiSigSignerStatusEnum.Approved);
};

export const handleMultiSigSignerRemoved = async (event: SubstrateEvent): Promise<void> => {
  await handleMultiSigSignerStatus(event, MultiSigSignerStatusEnum.Removed);
};

export const handleMultiSigSignersRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { params, block, blockEventId } = extractArgs(event);

  const signerDetails = getMultiSigSignersDetails(params, block);

  const multiSigSigners = await Promise.all(
    signerDetails.map(({ multisigId, signerType, signerValue }) =>
      MultiSigSigner.get(`${multisigId}/${signerType}/${signerValue}`)
    )
  );

  const existingSigners = multiSigSigners.filter(multiSigSigner => multiSigSigner);
  existingSigners.forEach(multiSigSigner => {
    multiSigSigner.status = MultiSigSignerStatusEnum.Removed;
    multiSigSigner.updatedEventId = blockEventId;
  });

  await Promise.all(existingSigners.map(existingSigner => existingSigner.save()));
};

export const handleMultiSigSignaturesRequiredChanged = async (
  event: SubstrateEvent
): Promise<void> => {
  const { params, blockEventId } = extractArgs(event);

  const [, rawMultiSigAddress, rawSignaturesRequired] = params;

  const multiSigAddress = getTextValue(rawMultiSigAddress);
  const signaturesRequired = getNumberValue(rawSignaturesRequired);

  const multiSig = await MultiSig.get(multiSigAddress);

  multiSig.signaturesRequired = signaturesRequired;
  multiSig.updatedEventId = blockEventId;

  await multiSig.save();
};
