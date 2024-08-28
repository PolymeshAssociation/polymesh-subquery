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
  Object.assign(multiSigSigner, {
    status,
    updatedBlockId: blockId,
  });
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

  const signerParams = signers.map(({ signerType, signerValue }) => ({
    id: `${multiSigAddress}/${signerType}/${signerValue}`,
    multisigId: multiSigAddress,
    signerType,
    signerValue,
    status: MultiSigSignerStatusEnum.Authorized,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }));

  const promises = [multiSigPromise, store.bulkCreate('MultiSigSigner', signerParams)];

  if (!is7xChain(block)) {
    promises.push(
      MultiSigAdmin.create({
        id: `${multiSigAddress}/${creator}`,
        multisigId: multiSigAddress,
        identityId: creator,
        status: MultiSigAdminStatusEnum.Authorized,
        createdBlockId: blockId,
        updatedBlockId: blockId,
      }).save()
    );
  }

  await Promise.all(promises);
};

export const handleMultiSigAddedAdmin = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawMultiSigAddress, rawAdminDid] = params;

  const admin = getTextValue(rawAdminDid);
  const multisigId = getTextValue(rawMultiSigAddress);

  await MultiSigAdmin.create({
    id: `${multisigId}/${admin}`,
    multisigId,
    identityId: admin,
    status: MultiSigAdminStatusEnum.Authorized,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });
};

export const handleMultiSigRemovedAdmin = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawMultiSigAddress, rawAdminDid] = params;

  const admin = getTextValue(rawAdminDid);
  const multisigId = getTextValue(rawMultiSigAddress);

  const multiSigAdmin = await MultiSigAdmin.get(`${multisigId}/${admin}`);

  if (multiSigAdmin) {
    Object.assign(multiSigAdmin, {
      status: MultiSigAdminStatusEnum.Removed,
      updatedBlockId: blockId,
    });

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

  const signerParams = signerDetails.map(({ multisigId, signerType, signerValue }) => ({
    id: `${multisigId}/${signerType}/${signerValue}`,
    multisigId,
    signerType,
    signerValue,
    status: MultiSigSignerStatusEnum.Authorized,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }));

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
  existingSigners.forEach(multiSigSigner =>
    Object.assign(multiSigSigner, {
      status: MultiSigSignerStatusEnum.Removed,
      updatedBlockId: blockId,
    })
  );

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

  Object.assign(multiSig, {
    signaturesRequired,
    updatedBlockId: blockId,
  });

  await multiSig.save();
};
