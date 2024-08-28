import { SubstrateEvent } from '@subql/types';
import { Proposal, ProposalStateEnum, ProposalVote } from '../../../types';
import {
  bytesToString,
  getBigIntValue,
  getBooleanValue,
  getProposerValue,
  getTextValue,
  serializeAccount,
} from '../../../utils';
import { extractArgs } from '../common';

export const handleProposalCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [rawDid, rawProposer, rawPipId, rawBalance, rawUrl, rawDescription] = params;

  await Proposal.create({
    id: getTextValue(rawPipId),
    proposer: getProposerValue(rawProposer),
    ownerId: getTextValue(rawDid),
    state: ProposalStateEnum.Pending,
    balance: getBigIntValue(rawBalance),
    url: bytesToString(rawUrl),
    description: bytesToString(rawDescription),
    snapshotted: false,
    totalAyeWeight: BigInt(0),
    totalNayWeight: BigInt(0),
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const handleProposalStateUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawPipId, rawState] = params;

  const pipId = getTextValue(rawPipId);
  const proposal = await Proposal.get(pipId);

  proposal.state = getTextValue(rawState) as ProposalStateEnum;
  proposal.updatedBlockId = blockId;

  await proposal.save();
};

export const handleVoted = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawAccount, rawPipId, rawVote, rawWeight] = params;

  const account = serializeAccount(rawAccount);
  const pipId = getTextValue(rawPipId);
  const vote = getBooleanValue(rawVote);
  const weight = getBigIntValue(rawWeight);

  let proposal: Proposal = null;
  let proposalVote: ProposalVote = null;
  [proposal, proposalVote] = await Promise.all([
    Proposal.get(pipId),
    ProposalVote.get(`${pipId}/${account}`),
  ]);

  if (proposalVote) {
    // when vote is changed, remove the previous weights
    if (proposalVote.vote) {
      proposal.totalAyeWeight -= proposalVote.weight;
    } else {
      proposal.totalNayWeight -= proposalVote.weight;
    }
    proposalVote.vote = vote;
    proposalVote.weight = weight;
    proposalVote.updatedBlockId = blockId;
  } else {
    proposalVote = ProposalVote.create({
      id: `${pipId}/${account}`,
      proposalId: pipId,
      account,
      vote,
      weight,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    });
  }

  if (vote) {
    proposal.totalAyeWeight += weight;
  } else {
    proposal.totalNayWeight += weight;
  }
  proposal.updatedBlockId = blockId;

  await Promise.all([proposal.save(), proposalVote.save()]);
};

export const handleSnapshotTaken = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const pips = params[2].toJSON() as any;
  const promises = [];
  pips.forEach(pip => {
    const job = async () => {
      const proposal = await Proposal.get(pip.id);
      proposal.snapshotted = true;
      proposal.updatedBlockId = blockId;
      return proposal.save();
    };
    promises.push(job());
  });
  await Promise.all(promises);
};
