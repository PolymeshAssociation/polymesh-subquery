import { Codec } from '@polkadot/types/types';
import { EventIdEnum, ModuleIdEnum, Proposal, ProposalStateEnum, ProposalVote } from '../../types';
import {
  getBigIntValue,
  getBooleanValue,
  getFirstValueFromJson,
  getTextValue,
  serializeAccount,
} from '../util';
import { HandlerArgs } from './common';

const handleProposalCreated = async (blockId: string, params: Codec[]): Promise<void> => {
  const [rawDid, rawProposer, rawPipId, rawBalance, rawUrl, rawDescription] = params;

  await Proposal.create({
    id: getTextValue(rawPipId),
    proposer: getFirstValueFromJson(rawProposer),
    ownerId: getTextValue(rawDid),
    state: ProposalStateEnum.Pending,
    balance: getBigIntValue(rawBalance),
    url: getTextValue(rawUrl),
    description: getTextValue(rawDescription),
    snapshotted: false,
    totalAyeWeight: BigInt(0),
    totalNayWeight: BigInt(0),
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

const handleProposalStateUpdated = async (blockId: string, params: Codec[]): Promise<void> => {
  const [, rawPipId, rawState] = params;

  const pipId = getTextValue(rawPipId);
  const proposal = await Proposal.get(pipId);

  proposal.state = getTextValue(rawState) as ProposalStateEnum;
  proposal.updatedBlockId = blockId;

  await proposal.save();
};

const handleVoted = async (blockId: string, params: Codec[]): Promise<void> => {
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

const handleSnapshotTaken = async (blockId: string, params: Codec[]): Promise<void> => {
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

/**
 * Subscribes to events related to proposals
 */
export async function mapProposal({
  blockId,
  eventId,
  moduleId,
  params,
}: HandlerArgs): Promise<void> {
  if (moduleId === ModuleIdEnum.pips) {
    if (eventId === EventIdEnum.ProposalCreated) {
      await handleProposalCreated(blockId, params);
    }

    if (eventId === EventIdEnum.ProposalStateUpdated) {
      await handleProposalStateUpdated(blockId, params);
    }

    if (eventId === EventIdEnum.Voted) {
      await handleVoted(blockId, params);
    }

    if (eventId === EventIdEnum.SnapshotTaken) {
      await handleSnapshotTaken(blockId, params);
    }
  }
}
