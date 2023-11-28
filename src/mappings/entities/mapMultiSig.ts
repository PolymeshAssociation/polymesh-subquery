import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateExtrinsic } from '@subql/types';
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
import {
  getBooleanValue,
  getMultiSigSigner,
  getMultiSigSigners,
  getNumberValue,
  getTextValue,
} from '../util';
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
  eventIdx: number,
  block: SubstrateBlock,
  extrinsic: SubstrateExtrinsic
) => {
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

const handleMultiSigProposalRejected = async (blockId: string, params: Codec[]) => {
  const [, rawMultiSigAddress, rawProposalId] = params;

  await handleMultiSigProposalStatus(
    rawMultiSigAddress,
    rawProposalId,
    MultiSigProposalStatusEnum.Rejected,
    blockId
  );
};

const handleMultiSigProposalExecuted = async (blockId: string, params: Codec[]) => {
  const [, rawMultiSigAddress, rawProposalId, rawSuccess] = params;

  const success = getBooleanValue(rawSuccess);

  let status = MultiSigProposalStatusEnum.Success;
  if (!success) {
    status = MultiSigProposalStatusEnum.Failed;
  }

  await handleMultiSigProposalStatus(rawMultiSigAddress, rawProposalId, status, blockId);
};

const handleMultiSigProposalVoteAction = async (
  blockId: string,
  params: Codec[],
  eventIdx: number,
  block: SubstrateBlock,
  action: MultiSigProposalVoteActionEnum,
  extrinsic?: SubstrateExtrinsic
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

export const handleMultiSigProposalDeleted = async (blockId: string): Promise<void> => {
  const activeProposals = await store.getByFields<MultiSigProposal>('MultiSigProposal', [
    ['status', '=', MultiSigProposalStatusEnum.Active],
  ]);

  logger.info('-------------------------------');
  logger.info(JSON.stringify(activeProposals));
  logger.info('-------------------------------');

  const queryMultiParams = activeProposals.map(proposal => [
    api.query.multisig.proposalDetail,
    [proposal.multisigId, proposal.proposalId],
  ]);

  const proposalDetails = await api.queryMulti(queryMultiParams as any);

  const deletedProposals = [];
  proposalDetails.forEach((proposal, index) => {
    logger.info(JSON.stringify(activeProposals[index].id));
    logger.info(JSON.stringify(proposal.toString()));
    logger.info('--------------');
    if (proposal.isEmpty) {
      deletedProposals.push(activeProposals[index]);
    }
  });

  logger.info('-------------------------------');
  logger.info(JSON.stringify(deletedProposals));
  logger.info('-------------------------------');

  if (deletedProposals.length) {
    activeProposals.forEach(proposal => {
      Object.assign(proposal, {
        status: MultiSigProposalStatusEnum.Deleted,
        updatedBlockId: blockId,
      });
    });
    await store.bulkUpdate('MultiSigProposal', activeProposals);
  }
};

/**
 * Subscribes to events related to MultiSigs
 */
export async function mapMultiSig({
  blockId,
  eventId,
  moduleId,
  params,
  eventIdx,
  block,
  extrinsic,
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
      return handleMultiSigProposalAdded(blockId, params, eventIdx, block, extrinsic);
    case EventIdEnum.ProposalRejected:
      return handleMultiSigProposalRejected(blockId, params);
    case EventIdEnum.ProposalExecuted:
      return handleMultiSigProposalExecuted(blockId, params);
    case EventIdEnum.ProposalApproved:
      return handleMultiSigProposalVoteAction(
        blockId,
        params,
        eventIdx,
        block,
        MultiSigProposalVoteActionEnum.Approved,
        extrinsic
      );
    case EventIdEnum.ProposalRejectionVote:
      return handleMultiSigProposalVoteAction(
        blockId,
        params,
        eventIdx,
        block,
        MultiSigProposalVoteActionEnum.Rejected,
        extrinsic
      );
  }
}
