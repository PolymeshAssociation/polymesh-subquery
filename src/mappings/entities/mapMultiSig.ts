import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import {
  MultiSig,
  MultiSigProposal,
  MultiSigProposalStatusEnum,
  MultiSigProposalVote,
  MultiSigSigner,
  MultiSigSignerStatusEnum,
} from '../../types';
import {
  getBooleanValue,
  getMultiSigSigner,
  getMultiSigSigners,
  getNumberValue,
  getTextValue,
} from '../util';
import { MultiSigProposalVoteActionEnum, SignerTypeEnum } from './../../types/enums';
import { Attributes, extractArgs } from './common';

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

export const handleMultiSigCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [rawDid, rawMultiSigAddress, rawCreator, rawSigners, rawSignaturesRequired] = params;

  const creator = getTextValue(rawDid);
  const creatorAccountId = getTextValue(rawCreator);
  const multiSigAddress = getTextValue(rawMultiSigAddress);
  const signers = getMultiSigSigners(rawSigners);
  const signaturesRequired = getNumberValue(rawSignaturesRequired);

  const multiSigPromise = createMultiSig(
    multiSigAddress,
    creator,
    creatorAccountId,
    signaturesRequired,
    blockId
  );

  const signerPromises = signers.map(({ signerType, signerValue }) =>
    MultiSigSigner.create({
      id: `${multiSigAddress}/${signerType}/${signerValue}`,
      multisigId: multiSigAddress,
      signerType,
      signerValue,
      status: MultiSigSignerStatusEnum.Authorized,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save()
  );

  await Promise.all([multiSigPromise, ...signerPromises]);
};

const getMultiSigSignerDetails = (params: Codec[]): Omit<Attributes<MultiSigSigner>, 'status'> => {
  const [, rawMultiSigAddress, rawSigner] = params;
  const multisigId = getTextValue(rawMultiSigAddress);
  const signer = getMultiSigSigner(rawSigner);
  return {
    multisigId,
    ...signer,
  };
};

export const handleMultiSigSignerAuthorized = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const { multisigId, signerType, signerValue } = getMultiSigSignerDetails(params);
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

export const handleMultiSigSignerAdded = async (event: SubstrateEvent): Promise<void> => {
  await handleMultiSigSignerStatus(event, MultiSigSignerStatusEnum.Approved);
};

export const handleMultiSigSignerRemoved = async (event: SubstrateEvent): Promise<void> => {
  await handleMultiSigSignerStatus(event, MultiSigSignerStatusEnum.Removed);
};

const handleMultiSigSignerStatus = async (
  event: SubstrateEvent,
  status: MultiSigSignerStatusEnum
): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const { multisigId, signerType, signerValue } = getMultiSigSignerDetails(params);
  const multiSigSigner = await MultiSigSigner.get(`${multisigId}/${signerType}/${signerValue}`);
  Object.assign(multiSigSigner, {
    status,
    updatedBlockId: blockId,
  });
  await multiSigSigner.save();
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

export const handleMultiSigProposalAdded = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, extrinsic, eventIdx, block } = extractArgs(event);

  const [rawDid, rawMultiSigAddress, rawProposalId] = params;

  const creatorId = getTextValue(rawDid);
  const multisigId = getTextValue(rawMultiSigAddress);
  const proposalId = getNumberValue(rawProposalId);
  const creatorAccount = extrinsic?.extrinsic.signer.toString();

  await MultiSigProposal.create({
    id: `${multisigId}/${proposalId}`,
    multisigId,
    proposalId,
    creatorId,
    creatorAccount,
    approvalCount: 0,
    rejectionCount: 0,
    eventIdx,
    extrinsicIdx: extrinsic?.idx,
    datetime: block.timestamp,
    status: MultiSigProposalStatusEnum.Active,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

const handleMultiSigProposalStatus = async (
  rawMultiSigAddress: Codec,
  rawProposalId: Codec,
  status: MultiSigProposalStatusEnum,
  blockId: string
): Promise<void> => {
  const multisigId = getTextValue(rawMultiSigAddress);
  const proposalId = getNumberValue(rawProposalId);

  const proposal = await MultiSigProposal.get(`${multisigId}/${proposalId}`);

  Object.assign(proposal, {
    status,
    updatedBlockId: blockId,
  });

  await proposal.save();
};

export const handleMultiSigProposalRejected = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawMultiSigAddress, rawProposalId] = params;
  await handleMultiSigProposalStatus(
    rawMultiSigAddress,
    rawProposalId,
    MultiSigProposalStatusEnum.Rejected,
    blockId
  );
};

export const handleMultiSigProposalExecuted = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const [, rawMultiSigAddress, rawProposalId, rawSuccess] = params;

  const success = getBooleanValue(rawSuccess);

  let status = MultiSigProposalStatusEnum.Success;
  if (!success) {
    status = MultiSigProposalStatusEnum.Failed;
  }

  await handleMultiSigProposalStatus(rawMultiSigAddress, rawProposalId, status, blockId);
};

const handleMultiSigProposalVoteAction = async (
  event: SubstrateEvent,
  action: MultiSigProposalVoteActionEnum
) => {
  const { params, blockId, eventIdx, block, extrinsic } = extractArgs(event);
  const [, rawMultiSigAddress, rawSigner, rawProposalId] = params;

  const multisigId = getTextValue(rawMultiSigAddress);
  const proposalId = getNumberValue(rawProposalId);
  const { signerType, signerValue } = getMultiSigSigner(rawSigner);

  const proposal = await MultiSigProposal.get(`${multisigId}/${proposalId}`);

  if (action === MultiSigProposalVoteActionEnum.Approved) {
    proposal.approvalCount++;
  } else {
    proposal.rejectionCount++;
  }

  await Promise.all([
    MultiSigProposalVote.create({
      id: `${blockId}/${eventIdx}`,
      proposalId: `${multisigId}/${proposalId}`,
      signerId: `${multisigId}/${signerType}/${signerValue}`,
      action,
      datetime: block.timestamp,
      eventIdx,
      extrinsicIdx: extrinsic?.idx,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save(),
    proposal.save(),
  ]);
};

export const handleMultiSigVoteApproved = async (event: SubstrateEvent): Promise<void> => {
  await handleMultiSigProposalVoteAction(event, MultiSigProposalVoteActionEnum.Approved);
};

export const handleMultiSigVoteRejected = async (event: SubstrateEvent): Promise<void> => {
  await handleMultiSigProposalVoteAction(event, MultiSigProposalVoteActionEnum.Rejected);
};

export const handleMultiSigProposalDeleted = async (blockId: string): Promise<void> => {
  const activeProposals = await store.getByFields<MultiSigProposal>('MultiSigProposal', [
    ['status', '=', MultiSigProposalStatusEnum.Active],
  ]);

  const queryMultiParams = activeProposals.map(proposal => [
    api.query.multiSig.proposalDetail,
    [proposal.multisigId, proposal.proposalId],
  ]);

  const proposalDetails = await api.queryMulti(queryMultiParams as any);

  const deletedProposals = [];
  proposalDetails.forEach((proposal, index) => {
    if (proposal.isEmpty) {
      deletedProposals.push(activeProposals[index]);
    }
  });

  if (deletedProposals.length) {
    deletedProposals.forEach(proposal => {
      Object.assign(proposal, {
        status: MultiSigProposalStatusEnum.Deleted,
        updatedBlockId: blockId,
      });
    });
    await store.bulkUpdate('MultiSigProposal', deletedProposals);
  }
};
