import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import {
  CallIdEnum,
  ModuleIdEnum,
  MultiSigProposal,
  MultiSigProposalParams,
  MultiSigProposalStatusEnum,
  MultiSigProposalVote,
  MultiSigProposalVoteActionEnum,
  SingleProposal,
} from '../../../types';
import {
  camelToSnakeCase,
  capitalizeFirstLetter,
  getBooleanValue,
  getMultiSigSigner,
  getNumberValue,
  getTextValue,
  is7xChain,
} from '../../../utils';
import { extractArgs } from '../common';

export const handleMultiSigProposalAdded = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, extrinsic, eventIdx, block } = extractArgs(event);

  const [rawDid, rawMultiSigAddress, rawProposalId] = params;

  const creatorId = getTextValue(rawDid);
  const multisigId = getTextValue(rawMultiSigAddress);
  const proposalId = getNumberValue(rawProposalId);
  const creatorAccount = extrinsic?.extrinsic.signer?.toString();

  const proposalParams: MultiSigProposalParams = {
    isBatch: false,
    isBridge: false,
  };

  const args = (extrinsic?.extrinsic?.toHuman() as any).method.args;

  const callToProposalParam = (call: any): SingleProposal => {
    return {
      module: capitalizeFirstLetter(call.section) as ModuleIdEnum,
      call: camelToSnakeCase(call.method) as CallIdEnum,
      args: JSON.stringify(call.args),
    };
  };

  if (args?.bridge_txs) {
    // for extrinsic bridge.batch_propose_bridge_tx
    proposalParams.bridge = args.bridge_txs;
    proposalParams.isBridge = true;
    proposalParams.isBatch = true;
  } else if (args?.bridge_tx) {
    // for extrinsic bridge.propose_bridge_tx
    proposalParams.bridge = [args.bridge_tx];
    proposalParams.isBridge = true;
  } else if (args?.proposal?.method === 'batch') {
    proposalParams.isBatch = true;
    proposalParams.proposals = args?.proposal?.args?.calls?.map(callToProposalParam);
    proposalParams.expiry = args.expiry;
    proposalParams.autoClose = args.auto_close;
  } else {
    const proposal: SingleProposal = callToProposalParam(args.proposal);

    proposalParams.proposals = [proposal];
    proposalParams.expiry = args.expiry;
    proposalParams.autoClose = args.auto_close;
  }

  await MultiSigProposal.create({
    id: `${multisigId}/${proposalId}`,
    multisigId,
    proposalId,
    creatorId,
    creatorAccount,
    approvalCount: 0,
    rejectionCount: 0,
    params: proposalParams,
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

export const handleMultiSigProposalApproved = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block } = extractArgs(event);
  if (is7xChain(block)) {
    const [, rawMultiSigAddress, rawProposalId] = params;
    await handleMultiSigProposalStatus(
      rawMultiSigAddress,
      rawProposalId,
      MultiSigProposalStatusEnum.Approved,
      blockId
    );
  } else {
    await handleMultiSigVoteApproved(event);
  }
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
  const proposalIndex = getNumberValue(rawProposalId);
  const { signerType, signerValue } = getMultiSigSigner(rawSigner, block);

  const signerId = `${multisigId}/${signerType}/${signerValue}`;
  const proposalId = `${multisigId}/${proposalIndex}`;
  const voteId = `${proposalId}/${signerValue}`;

  const [proposal, previousVote] = await Promise.all([
    MultiSigProposal.get(proposalId),
    MultiSigProposalVote.get(voteId),
  ]);

  let vote = previousVote;
  if (vote) {
    if (vote.action === MultiSigProposalVoteActionEnum.Approved) {
      proposal.approvalCount--;
    } else if (vote.action === MultiSigProposalVoteActionEnum.Rejected) {
      proposal.rejectionCount--;
    }

    vote.action = action;
  } else {
    vote = MultiSigProposalVote.create({
      id: voteId,
      proposalId,
      signerId,
      action,
      datetime: block.timestamp,
      eventIdx,
      extrinsicIdx: extrinsic?.idx,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    });
  }

  if (action === MultiSigProposalVoteActionEnum.Approved) {
    proposal.approvalCount++;
  } else {
    proposal.rejectionCount++;
  }

  await Promise.all([vote.save(), proposal.save()]);
};

export const handleMultiSigVoteApproved = async (event: SubstrateEvent): Promise<void> => {
  await handleMultiSigProposalVoteAction(event, MultiSigProposalVoteActionEnum.Approved);
};

export const handleMultiSigVoteRejected = async (event: SubstrateEvent): Promise<void> => {
  await handleMultiSigProposalVoteAction(event, MultiSigProposalVoteActionEnum.Rejected);
};

// triggered on major chain upgrades only
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
