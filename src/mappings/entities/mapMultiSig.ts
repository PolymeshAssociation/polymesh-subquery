import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import {
  EventIdEnum,
  ModuleIdEnum,
  MultiSig,
  MultiSigProposal,
  MultiSigProposalStatusEnum,
  MultiSigProposalVote,
  MultiSigSigner,
  MultiSigSignerStatusEnum,
} from '../../types';
import { getMultiSigSigner, getMultiSigSigners, getNumberValue, getTextValue } from '../util';
import { MultiSigProposalVoteActionEnum, SignerTypeEnum } from './../../types/enums';
import { Attributes, HandlerArgs } from './common';

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

const handleMultiSigCreated = async (blockId: string, params: Codec[]) => {
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

const handleMultiSigSignerAuthorized = async (blockId: string, params: Codec[]) => {
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

const handleMultiSigSignerStatus = async (
  blockId: string,
  params: Codec[],
  status: MultiSigSignerStatusEnum
) => {
  const { multisigId, signerType, signerValue } = getMultiSigSignerDetails(params);

  const multiSigSigner = await MultiSigSigner.get(`${multisigId}/${signerType}/${signerValue}`);

  Object.assign(multiSigSigner, {
    status,
    updatedBlockId: blockId,
  });

  await multiSigSigner.save();
};

const handleMultiSigSignaturesRequiredChanged = async (blockId: string, params: Codec[]) => {
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

const handleMultiSigProposalAdded = async (
  blockId: string,
  params: Codec[],
  event: SubstrateEvent
) => {
  const [rawDid, rawMultiSigAddress, rawProposalId] = params;

  const creatorId = getTextValue(rawDid);
  const multisigId = getTextValue(rawMultiSigAddress);
  const proposalId = getNumberValue(rawProposalId);
  const creatorAccount = event.extrinsic.extrinsic.signer.toString();

  await MultiSigProposal.create({
    id: `${multisigId}/${proposalId}`,
    multisigId,
    proposalId,
    creatorId,
    creatorAccount,
    approvalCount: 0,
    rejectionCount: 0,
    eventIdx: event.idx,
    extrinsicIdx: event.extrinsic?.idx,
    datetime: event.block.timestamp,
    status: MultiSigProposalStatusEnum.Active,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

const handleMultiSigProposalStatus = async (
  blockId: string,
  params: Codec[],
  status: MultiSigProposalStatusEnum
) => {
  const [, rawMultiSigAddress, rawProposalId] = params;

  const multisigId = getTextValue(rawMultiSigAddress);
  const proposalId = getNumberValue(rawProposalId);

  const proposal = await MultiSigProposal.get(`${multisigId}/${proposalId}`);

  Object.assign(proposal, {
    status,
    updatedBlockId: blockId,
  });

  await proposal.save();
};

const handleMultiSigProposalVoteAction = async (
  blockId: string,
  params: Codec[],
  event: SubstrateEvent,
  action: MultiSigProposalVoteActionEnum
) => {
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
      id: `${blockId}/${event.idx}`,
      proposalId: `${multisigId}/${proposalId}`,
      signerId: `${multisigId}/${signerType}/${signerValue}`,
      action,
      datetime: event.block.timestamp,
      eventIdx: event.idx,
      extrinsicIdx: event.extrinsic.idx,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save(),
    proposal.save(),
  ]);
};

/**
 * Subscribes to events related to MultiSigs
 */
export async function mapMultiSig({
  blockId,
  eventId,
  moduleId,
  params,
  event,
}: HandlerArgs): Promise<void> {
  if (moduleId !== ModuleIdEnum.multisig) {
    return;
  }

  switch (eventId) {
    case EventIdEnum.MultiSigCreated:
      return handleMultiSigCreated(blockId, params);
    case EventIdEnum.MultiSigSignaturesRequiredChanged:
      return handleMultiSigSignaturesRequiredChanged(blockId, params);
    case EventIdEnum.MultiSigSignerAuthorized:
      return handleMultiSigSignerAuthorized(blockId, params);
    case EventIdEnum.MultiSigSignerAdded:
      return handleMultiSigSignerStatus(blockId, params, MultiSigSignerStatusEnum.Approved);
    case EventIdEnum.MultiSigSignerRemoved:
      return handleMultiSigSignerStatus(blockId, params, MultiSigSignerStatusEnum.Removed);

    case EventIdEnum.ProposalAdded:
      return handleMultiSigProposalAdded(blockId, params, event);
    case EventIdEnum.ProposalRejected:
      return handleMultiSigProposalStatus(blockId, params, MultiSigProposalStatusEnum.Rejected);
    case EventIdEnum.ProposalExecuted:
      return handleMultiSigProposalStatus(blockId, params, MultiSigProposalStatusEnum.Success);
    case EventIdEnum.ProposalApproved:
      return handleMultiSigProposalVoteAction(
        blockId,
        params,
        event,
        MultiSigProposalVoteActionEnum.Approved
      );
    case EventIdEnum.ProposalRejectionVote:
      return handleMultiSigProposalVoteAction(
        blockId,
        params,
        event,
        MultiSigProposalVoteActionEnum.Rejected
      );
  }
}
