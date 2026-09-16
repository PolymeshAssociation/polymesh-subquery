import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import {
  KeyRoleEnum,
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
import { ledgerAccount } from '../../../utils/accounts';
import { Attributes, extractArgs } from '../common';
import { MultiSigSignerProps } from '../../../types/models/MultiSigSigner';

/**
 * Creates a `MultiSig` and, first, the `Account` row it links to — a multisig is an account
 * (defect G5). The multisig address is both the `Account` id and the `MultiSig` id.
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
 * The `Account` id for `MultiSigSigner.signerAccount`, creating the account row if it is new.
 *
 * Only `Account` signers get one — `SignerTypeEnum` also has `Identity` on pre-7.x runtimes,
 * which a relation cannot point at, so `signerValue` stays canonical and this returns undefined
 * for those. A signer key is an account with no identity of its own, so `ledgerAccount` gives it
 * a bare row; `keyRole` is set to `MultiSigSigner` from here because the event is proof of the
 * role even before the chain writes the key record (which happens when the signer accepts). The
 * genesis/seed scan later confirms it authoritatively from `multiSig.multiSigSigners`.
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

  if (account.keyRole !== KeyRoleEnum.MultiSigSigner) {
    account.keyRole = KeyRoleEnum.MultiSigSigner;
    account.updatedEventId = blockEventId;
    await account.save();
  }

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

export const createMultiSigAdmin = (
  multisigId: string,
  adminId: string,
  blockId: string,
  blockEventId: string
): Promise<void> =>
  MultiSigAdmin.create({
    id: `${multisigId}/${adminId}`,
    multisigId,
    adminId,
    status: MultiSigAdminStatusEnum.Authorized,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();

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
  const { params, block, blockEventId } = extractArgs(event);

  const { multisigId, signerType, signerValue } = getMultiSigSignerDetails(params, block);
  const multiSigSigner = await MultiSigSigner.get(`${multisigId}/${signerType}/${signerValue}`);
  multiSigSigner.status = status;
  multiSigSigner.updatedEventId = blockEventId;
  await multiSigSigner.save();
};

export const handleMultiSigCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block, blockEventId } = extractArgs(event);
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
    promises.push(createMultiSigAdmin(multiSigAddress, creator, blockId, blockEventId));
  }

  await Promise.all(promises);
};

export const handleMultiSigAddedAdmin = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, blockEventId } = extractArgs(event);
  const [, rawMultiSigAddress, rawAdminDid] = params;

  const admin = getTextValue(rawAdminDid);
  const multisigId = getTextValue(rawMultiSigAddress);

  await createMultiSigAdmin(multisigId, admin, blockId, blockEventId);
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
