import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import {
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
import { Attributes, extractArgs } from '../common';
import { MultiSigSignerProps } from 'src/types/models/MultiSigSigner';
import { MultiSigAdminProps } from 'src/types/models/MultiSigAdmin';
import { MultiSigProps } from 'src/types/models/MultiSig';

export const createMultiSig = (
  address: string,
  creatorId: string,
  creatorAccountId: string,
  signaturesRequired: number,
  blockId: string
): Promise<void> =>
  MultiSig.create({
    id: `${address}`,
    address,
    creatorId,
    creatorAccountId,
    signaturesRequired,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();

export const createMultiSigSigner = (
  multiSigAddress: string,
  signerType: SignerTypeEnum,
  signerValue: string,
  status: MultiSigSignerStatusEnum,
  blockId: string
): Promise<void> =>
  MultiSigSigner.create({
    id: `${multiSigAddress}/${signerType}/${signerValue}`,
    multisigId: multiSigAddress,
    signerType,
    signerValue,
    status,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();

export const createMultiSigAdmin = (
  multisigId: string,
  identityId: string,
  blockId: string
): Promise<void> =>
  MultiSigAdmin.create({
    id: `${multisigId}/${identityId}`,
    multisigId,
    identityId,
    status: MultiSigAdminStatusEnum.Authorized,
    createdBlockId: blockId,
    updatedBlockId: blockId,
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
  const { params, blockId, block } = extractArgs(event);

  const { multisigId, signerType, signerValue } = getMultiSigSignerDetails(params, block);
  const multiSigSigner = await MultiSigSigner.get(`${multisigId}/${signerType}/${signerValue}`);
  multiSigSigner.status = status;
  multiSigSigner.updatedBlockId = blockId;
  await multiSigSigner.save();
};

export const handleMultiSigCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block } = extractArgs(event);
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
    blockId
  );

  const signerParams: MultiSigSignerProps[] = signers.map(
    ({ signerType, signerValue }) =>
      ({
        id: `${multiSigAddress}/${signerType}/${signerValue}`,
        multisigId: multiSigAddress,
        signerType,
        signerValue,
        status: MultiSigSignerStatusEnum.Authorized,
        createdBlockId: blockId,
        updatedBlockId: blockId,
      } satisfies MultiSigSignerProps)
  );

  const promises = [multiSigPromise, store.bulkCreate('MultiSigSigner', signerParams)];

  if (!is7xChain(block)) {
    promises.push(createMultiSigAdmin(multiSigAddress, creator, blockId));
  }

  await Promise.all(promises);
};

export const handleMultiSigAddedAdmin = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawMultiSigAddress, rawAdminDid] = params;

  const admin = getTextValue(rawAdminDid);
  const multisigId = getTextValue(rawMultiSigAddress);

  await createMultiSigAdmin(multisigId, admin, blockId);
};

export const handleMultiSigRemovedAdmin = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawMultiSigAddress, rawAdminDid] = params;

  const admin = getTextValue(rawAdminDid);
  const multisigId = getTextValue(rawMultiSigAddress);

  const multiSigAdmin = await MultiSigAdmin.get(`${multisigId}/${admin}`);

  if (multiSigAdmin) {
    multiSigAdmin.status = MultiSigAdminStatusEnum.Removed;
    multiSigAdmin.updatedBlockId = blockId;
    await multiSigAdmin.save();
  }
};

export const handleMultiSigSignerAuthorized = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block } = extractArgs(event);

  const { multisigId, signerType, signerValue } = getMultiSigSignerDetails(params, block);
  await MultiSigSigner.create({
    id: `${multisigId}/${signerType}/${signerValue}`,
    multisigId,
    signerType,
    signerValue,
    status: MultiSigSignerStatusEnum.Authorized,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const handleMultiSigSignersAuthorized = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block } = extractArgs(event);

  const signerDetails = getMultiSigSignersDetails(params, block);

  const signerParams: MultiSigSignerProps[] = signerDetails.map(
    ({ multisigId, signerType, signerValue }) =>
      ({
        id: `${multisigId}/${signerType}/${signerValue}`,
        multisigId,
        signerType,
        signerValue,
        status: MultiSigSignerStatusEnum.Authorized,
        createdBlockId: blockId,
        updatedBlockId: blockId,
      } satisfies MultiSigSignerProps)
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
  const { params, blockId, block } = extractArgs(event);

  const signerDetails = getMultiSigSignersDetails(params, block);

  const multiSigSigners = await Promise.all(
    signerDetails.map(({ multisigId, signerType, signerValue }) =>
      MultiSigSigner.get(`${multisigId}/${signerType}/${signerValue}`)
    )
  );

  const existingSigners = multiSigSigners.filter(multiSigSigner => multiSigSigner);
  existingSigners.forEach(multiSigSigner => {
    multiSigSigner.status = MultiSigSignerStatusEnum.Removed;
    multiSigSigner.updatedBlockId = blockId;
  });

  await Promise.all(existingSigners.map(existingSigner => existingSigner.save()));
};

export const handleMultiSigSignaturesRequiredChanged = async (
  event: SubstrateEvent
): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const [, rawMultiSigAddress, rawSignaturesRequired] = params;

  const multiSigAddress = getTextValue(rawMultiSigAddress);
  const signaturesRequired = getNumberValue(rawSignaturesRequired);

  const multiSig = await MultiSig.get(multiSigAddress);

  multiSig.signaturesRequired = signaturesRequired;
  multiSig.updatedBlockId = blockId;

  await multiSig.save();
};
