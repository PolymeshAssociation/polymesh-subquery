import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import {
  AnomalyKind,
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
  extractString,
  getBooleanValue,
  getFirstKeyFromJson,
  getMultiSigSigner,
  getNumberValue,
  getAllByFields,
  getTextValue,
  is7xChain,
} from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';
import { extractArgs, getOrAnomaly } from '../common';

/** One call a proposal dispatches, from its `toHuman()` form */
const callToProposalParam = (call: any): SingleProposal => ({
  module: call.section.toLowerCase() as ModuleIdEnum,
  call: camelToSnakeCase(call.method) as CallIdEnum,
  args: JSON.stringify(call.args),
});

/** The calls a proposal dispatches, from its call's `toHuman()` form: a batch's calls, or the one */
export const proposalParamsOf = (
  call: any
): Pick<MultiSigProposalParams, 'isBatch' | 'isBridge' | 'proposals'> =>
  call?.method?.startsWith('batch')
    ? // batch, batch_atomic, batch_all, batch_optimistic
      { isBatch: true, isBridge: false, proposals: call?.args?.calls?.map(callToProposalParam) }
    : { isBatch: false, isBridge: false, proposals: [callToProposalParam(call)] };

/**
 * The calls proposing to `multisigId` in a call tree, in `toHuman()` form: the extrinsic's own call,
 * or calls inside a wrapper such as `utility.batch` or `relayer.relay_tx`. A proposal's own call is
 * searched too, as a multisig can be proposed to by another multisig's execution.
 */
const proposingCalls = (node: any, multisigId: string): any[] => {
  if (!node || typeof node !== 'object') {
    return [];
  }
  if (node.section?.toLowerCase() === 'multisig' && node.args?.multisig === multisigId) {
    if (node.args.proposal) {
      return [node];
    }
  }
  return Object.values(node).flatMap(value => proposingCalls(value, multisigId));
};

export const handleMultiSigProposalAdded = async (event: SubstrateEvent): Promise<void> => {
  const { block, eventIdx, extrinsic, blockEventId, extrinsicId } = extractArgs(event);

  const {
    callerDid: rawDid,
    multisig: rawMultiSigAddress,
    proposalId: rawProposalId,
  } = decodeEvent(event);

  const creatorId = getTextValue(rawDid);
  const multisigId = getTextValue(rawMultiSigAddress);
  const proposalId = getNumberValue(rawProposalId);
  const creatorAccount = extrinsic?.extrinsic.signer?.toString();

  const proposalParams: MultiSigProposalParams = {
    isBatch: false,
    isBridge: false,
  };

  const method = (extrinsic?.extrinsic?.toHuman() as any)?.method;
  const args = method?.args;

  const underlyingCall = camelToSnakeCase(extrinsic?.extrinsic.method.method || 'default');

  if (underlyingCall === CallIdEnum.approve_join_identity) {
    /**
     * in case of `ProposalAdded` being triggered by `approve_join_identity` extrinsic,
     * there are no proposal args in the extrinsics params, instead only an `auth_id` is present.
     */
    proposalParams.proposals = [
      {
        module: ModuleIdEnum.multisig,
        call: CallIdEnum.join_identity,
        args: JSON.stringify({ authId: extractString(args, 'auth_id') }),
      },
    ];
  } else if (args?.bridge_txs) {
    // for extrinsic bridge.batch_propose_bridge_tx
    proposalParams.bridge = args.bridge_txs;
    proposalParams.isBridge = true;
    proposalParams.isBatch = true;
  } else if (args?.bridge_tx) {
    // for extrinsic bridge.propose_bridge_tx
    proposalParams.bridge = [args.bridge_tx];
    proposalParams.isBridge = true;
  } else {
    const proposing = proposingCalls(method, multisigId);
    if (proposing.length === 1) {
      const { proposal, expiry, auto_close: autoClose } = proposing[0].args;
      Object.assign(proposalParams, proposalParamsOf(proposal));
      proposalParams.expiry = expiry;
      proposalParams.autoClose = autoClose;
    } else {
      await recordAnomaly({
        kind: AnomalyKind.UnreadableValue,
        detail: `ProposalAdded ${multisigId}/${proposalId}: ${proposing.length} calls in its extrinsic propose to this multisig, so its params can't be read`,
        block,
        eventIdx,
      });
    }
  }

  await MultiSigProposal.create({
    id: `${multisigId}/${proposalId}`,
    multisigId,
    proposalId,
    creatorId,
    creatorAccountId: creatorAccount,
    approvalCount: 0,
    rejectionCount: 0,
    params: proposalParams,
    status: MultiSigProposalStatusEnum.Active,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
    extrinsicId,
  }).save();
};

const handleMultiSigProposalStatus = async (
  event: SubstrateEvent,
  rawMultiSigAddress: Codec,
  rawProposalId: Codec,
  status: MultiSigProposalStatusEnum,
  blockEventId: string
): Promise<void> => {
  const multisigId = getTextValue(rawMultiSigAddress);
  const proposalId = getNumberValue(rawProposalId);

  const proposal = await getOrAnomaly(
    id => MultiSigProposal.get(id),
    `${multisigId}/${proposalId}`,
    'MultiSigProposal',
    event
  );
  if (!proposal) {
    return;
  }

  proposal.status = status;
  proposal.updatedEventId = blockEventId;

  await proposal.save();
};

/**
 * From v7 `ProposalApproved` means the proposal reached its threshold. Before v7 the same name was
 * one signer's approving vote, which v7 calls `ProposalApprovalVote`, so it is counted as a vote.
 */
export const handleMultiSigProposalApproved = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  if (is7xChain(block)) {
    const { multisig: rawMultiSigAddress, proposalId: rawProposalId } = decodeEvent(event);
    await handleMultiSigProposalStatus(
      event,
      rawMultiSigAddress,
      rawProposalId,
      MultiSigProposalStatusEnum.Approved,
      blockEventId
    );
  } else {
    await handleMultiSigVoteApproved(event);
  }
};

export const handleMultiSigProposalRejected = async (event: SubstrateEvent): Promise<void> => {
  const { blockEventId } = extractArgs(event);
  const { multisig: rawMultiSigAddress, proposalId: rawProposalId } = decodeEvent(event);
  await handleMultiSigProposalStatus(
    event,
    rawMultiSigAddress,
    rawProposalId,
    MultiSigProposalStatusEnum.Rejected,
    blockEventId
  );
};

export const handleMultiSigProposalExecuted = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);

  const {
    multisig: rawMultiSigAddress,
    proposalId: rawProposalId,
    result: rawSuccess,
  } = decodeEvent(event);

  let success: boolean;
  if (is7xChain(block)) {
    success = getFirstKeyFromJson(rawSuccess) === 'ok';
  } else {
    success = getBooleanValue(rawSuccess);
  }

  let status = MultiSigProposalStatusEnum.Success;
  if (!success) {
    status = MultiSigProposalStatusEnum.Failed;
  }

  await handleMultiSigProposalStatus(
    event,
    rawMultiSigAddress,
    rawProposalId,
    status,
    blockEventId
  );
};

const handleMultiSigProposalVoteAction = async (
  event: SubstrateEvent,
  action: MultiSigProposalVoteActionEnum
) => {
  const { block, blockEventId } = extractArgs(event);
  const {
    multisig: rawMultiSigAddress,
    signer: rawSigner,
    proposalId: rawProposalId,
  } = decodeEvent(event);

  const multisigId = getTextValue(rawMultiSigAddress);
  const proposalIndex = getNumberValue(rawProposalId);
  const { signerType, signerValue } = getMultiSigSigner(rawSigner, block);

  const signerId = `${multisigId}/${signerType}/${signerValue}`;
  const proposalId = `${multisigId}/${proposalIndex}`;
  const voteId = `${proposalId}/${signerValue}`;

  const [proposal, previousVote] = await Promise.all([
    getOrAnomaly(id => MultiSigProposal.get(id), proposalId, 'MultiSigProposal', event),
    MultiSigProposalVote.get(voteId),
  ]);

  // A vote counts toward a proposal, so without the proposal there is nothing to count it on —
  // reported rather than left to fail the block on the first count.
  if (!proposal) {
    return;
  }

  let vote = previousVote;
  if (vote) {
    if (vote.action === MultiSigProposalVoteActionEnum.Approved) {
      proposal.approvalCount--;
    } else if (vote.action === MultiSigProposalVoteActionEnum.Rejected) {
      proposal.rejectionCount--;
    }

    vote.action = action;
    vote.updatedEventId = blockEventId;
  } else {
    vote = MultiSigProposalVote.create({
      id: voteId,
      proposalId,
      signerId,
      action,
      createdEventId: blockEventId,
      updatedEventId: blockEventId,
    });
  }

  if (action === MultiSigProposalVoteActionEnum.Approved) {
    proposal.approvalCount++;
  } else {
    proposal.rejectionCount++;
  }

  proposal.updatedEventId = blockEventId;

  await Promise.all([vote.save(), proposal.save()]);
};

export const handleMultiSigVoteApproved = async (event: SubstrateEvent): Promise<void> => {
  await handleMultiSigProposalVoteAction(event, MultiSigProposalVoteActionEnum.Approved);
};

export const handleMultiSigVoteRejected = async (event: SubstrateEvent): Promise<void> => {
  await handleMultiSigProposalVoteAction(event, MultiSigProposalVoteActionEnum.Rejected);
};

/**
 * Marks deleted every pending proposal. Multisig's `on_runtime_upgrade` clears every proposal, its
 * votes and its state, with no event, when the upgrade raises the transaction version above the one
 * it stored (v3.0.0 to v8.1.2); the caller decides that.
 */
export const deletePendingProposals = async (blockEventId: string): Promise<void> => {
  const pending = await getAllByFields<MultiSigProposal>('MultiSigProposal', [
    ['status', '=', MultiSigProposalStatusEnum.Active],
  ]);

  if (pending.length) {
    pending.forEach(proposal => {
      proposal.status = MultiSigProposalStatusEnum.Deleted;
      proposal.updatedEventId = blockEventId;
    });
    await store.bulkUpdate('MultiSigProposal', pending);
  }
};
