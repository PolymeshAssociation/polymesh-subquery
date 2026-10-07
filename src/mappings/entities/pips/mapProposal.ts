import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { Proposal, ProposalStateEnum, ProposalVote } from '../../../types';
import {
  bytesToString,
  getAllByFields,
  getBigIntValue,
  getBooleanValue,
  getNumberValue,
  getProposerValue,
  getTextValue,
  padNumericId,
  serializeAccount,
} from '../../../utils';
import { extractArgs, getOrAnomaly } from '../common';

/**
 * A PIP id is a bare numeric sequence. Zero-pad it (D12 / A14) so `Proposal.id` and
 * `ProposalVote.proposalId` sort numerically under `ID_DESC`. Every construction and every
 * lookup routes through here.
 */
const processPipId = (rawPipId: Codec): string => padNumericId(getTextValue(rawPipId));

/**
 * The block the PIP's expiry was scheduled for, if it was.
 *
 * `propose` schedules the expiry before it emits `ProposalCreated`, so `ExpiryScheduled` comes
 * earlier in the same extrinsic, before its PIP exists. Nothing is scheduled for a PIP without an
 * expiry, and `ExpirySchedulingFailed` replaces it when the scheduler refuses.
 */
const scheduledExpiry = (event: SubstrateEvent, pipId: string): number | undefined => {
  const records = (event.block.events ?? []) as unknown as {
    phase: { toString: () => string };
    event: { section: string; method: string; data: Codec[] };
  }[];
  const phase = records[event.idx]?.phase.toString();

  for (let i = event.idx - 1; i >= 0 && records[i].phase.toString() === phase; i -= 1) {
    const { section, method, data } = records[i].event;

    if (section === 'pips' && method === 'ExpiryScheduled' && processPipId(data[1]) === pipId) {
      return getNumberValue(data[2]);
    }
  }

  return undefined;
};

export const handleProposalCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockEventId } = extractArgs(event);
  const [rawDid, rawProposer, rawPipId, rawBalance, rawUrl, rawDescription] = params;
  const id = processPipId(rawPipId);

  await Proposal.create({
    id,
    proposer: getProposerValue(rawProposer),
    ownerId: getTextValue(rawDid),
    state: ProposalStateEnum.Pending,
    balance: getBigIntValue(rawBalance),
    url: bytesToString(rawUrl),
    description: bytesToString(rawDescription),
    snapshotted: false,
    expiresAt: scheduledExpiry(event, id),
    totalAyeWeight: BigInt(0),
    totalNayWeight: BigInt(0),
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();
};

export const handleProposalStateUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockEventId } = extractArgs(event);
  const [, rawPipId, rawState] = params;

  const proposal = await getProposal(rawPipId, event);

  if (!proposal) {
    return;
  }

  proposal.state = getTextValue(rawState) as ProposalStateEnum;
  proposal.updatedEventId = blockEventId;

  await proposal.save();
};

export const handleVoted = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockEventId } = extractArgs(event);
  const [, rawAccount, rawPipId, rawVote, rawWeight] = params;

  const account = serializeAccount(rawAccount);
  const pipId = processPipId(rawPipId);
  const vote = getBooleanValue(rawVote);
  const weight = getBigIntValue(rawWeight);

  const [proposal, existingVote] = await Promise.all([
    getProposal(rawPipId, event),
    ProposalVote.get(`${pipId}/${account}`),
  ]);

  if (!proposal) {
    return;
  }

  let proposalVote = existingVote;

  if (proposalVote) {
    // when vote is changed, remove the previous weights
    if (proposalVote.vote) {
      proposal.totalAyeWeight -= proposalVote.weight;
    } else {
      proposal.totalNayWeight -= proposalVote.weight;
    }
    proposalVote.vote = vote;
    proposalVote.weight = weight;
    proposalVote.updatedEventId = blockEventId;
  } else {
    proposalVote = ProposalVote.create({
      id: `${pipId}/${account}`,
      proposalId: pipId,
      account,
      vote,
      weight,
      createdEventId: blockEventId,
      updatedEventId: blockEventId,
    });
  }

  if (vote) {
    proposal.totalAyeWeight += weight;
  } else {
    proposal.totalNayWeight += weight;
  }
  proposal.updatedEventId = blockEventId;

  await Promise.all([proposal.save(), proposalVote.save()]);
};

export const handleSnapshotTaken = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockEventId } = extractArgs(event);
  const snapshotId = getNumberValue(params[1]);
  const pips = params[2].toJSON() as { id: number }[];

  await Promise.all(
    pips.map(async pip => {
      const proposal = await getProposal(pip.id, event);

      if (!proposal) {
        return;
      }

      proposal.snapshotted = true;
      proposal.snapshotId = snapshotId;
      proposal.updatedEventId = blockEventId;
      await proposal.save();
    })
  );
};

/**
 * The PIP an event names, recorded as missing rather than left to fail the block when the index
 * does not have it — a PIP created before an arbitrary start block, for one.
 */
const getProposal = (
  rawPipId: Codec | number,
  event: SubstrateEvent
): Promise<Proposal | undefined> =>
  getOrAnomaly(
    id => Proposal.get(id),
    typeof rawPipId === 'number' ? padNumericId(String(rawPipId)) : processPipId(rawPipId),
    'Proposal',
    event
  );

/** Applies `change` to the PIP an event names, stamping the event as its latest. */
const updateProposal = async (
  rawPipId: Codec | number,
  event: SubstrateEvent,
  change: (proposal: Proposal) => void
): Promise<void> => {
  const proposal = await getProposal(rawPipId, event);

  if (!proposal) {
    return;
  }

  change(proposal);
  proposal.updatedEventId = extractArgs(event).blockEventId;

  await proposal.save();
};

/** Takes a PIP out of the snapshot queue — the queue was cleared, or its result enacted. */
const leaveSnapshot = (proposal: Proposal): void => {
  proposal.snapshotted = false;
  proposal.snapshotId = undefined;
};

/** `PipSkipped(did, pipId, skippedCount)` — the new skip count, not an increment. */
export const handlePipSkipped = async (event: SubstrateEvent): Promise<void> => {
  const [, rawPipId, rawCount] = extractArgs(event).params;

  await updateProposal(rawPipId, event, proposal => {
    proposal.skippedCount = getNumberValue(rawCount);
  });
};

/** `ExecutionScheduled(did, pipId, block)` — when an approved PIP will run. */
export const handleExecutionScheduled = async (event: SubstrateEvent): Promise<void> => {
  const [, rawPipId, rawBlock] = extractArgs(event).params;

  await updateProposal(rawPipId, event, proposal => {
    proposal.executionScheduledAt = getNumberValue(rawBlock);
  });
};

/** `PipClosed(did, pipId, pruned)` — the PIP is closed; whether the chain pruned it does not change the history here. */
export const handlePipClosed = async (event: SubstrateEvent): Promise<void> => {
  const [, rawPipId] = extractArgs(event).params;
  const { blockEventId } = extractArgs(event);

  await updateProposal(rawPipId, event, proposal => {
    proposal.closedEventId = blockEventId;
  });
};

/**
 * `SnapshotResultsEnacted(did, snapshotId?, skipped, rejected, approved)` — every PIP it names
 * leaves the snapshot queue, and a skipped one carries its new skip count. Approval and rejection
 * arrive as their own state updates.
 */
export const handleSnapshotResultsEnacted = async (event: SubstrateEvent): Promise<void> => {
  const [, , rawSkipped, rawRejected, rawApproved] = extractArgs(event).params;
  const skipped = (rawSkipped.toJSON() as [number, number][]) ?? [];
  const decided = [
    ...((rawRejected.toJSON() as number[]) ?? []),
    ...((rawApproved.toJSON() as number[]) ?? []),
  ];

  await Promise.all([
    ...skipped.map(([pipId, count]) =>
      updateProposal(pipId, event, proposal => {
        proposal.skippedCount = count;
        leaveSnapshot(proposal);
      })
    ),
    ...decided.map(pipId => updateProposal(pipId, event, leaveSnapshot)),
  ]);
};

/**
 * `SnapshotCleared(did, snapshotId)` — the queue is emptied. The flag `SnapshotTaken` set on each
 * queued PIP used to stay set for good; it follows the queue now.
 */
export const handleSnapshotCleared = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockEventId } = extractArgs(event);
  const snapshotId = getNumberValue(params[1]);
  const queued = await getAllByFields<Proposal>('Proposal', [['snapshotId', '=', snapshotId]]);

  await Promise.all(
    queued.map(proposal => {
      leaveSnapshot(proposal);
      proposal.updatedEventId = blockEventId;

      return proposal.save();
    })
  );
};
