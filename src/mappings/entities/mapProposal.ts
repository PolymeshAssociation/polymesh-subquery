import { Codec } from "@polkadot/types/types";
import { SubstrateEvent } from "@subql/types";
import { Proposal, ProposalVote } from "../../types";
import { getFirstValueFromJson, getTextValue } from "../util";
import { EventIdEnum, ModuleIdEnum } from "./common";

enum ProposalState {
  Pending = "Pending",
  Rejected = "Rejected",
  Scheduled = "Scheduled",
  Failed = "Failed",
  Executed = "Executed",
  Expired = "Expired",
}

/**
 * Subscribes to events related to proposals
 */
export async function mapProposal(
  blockId: number,
  eventId: EventIdEnum,
  moduleId: ModuleIdEnum,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> {
  if (moduleId !== ModuleIdEnum.Pips) return;

  if (eventId === EventIdEnum.ProposalCreated) {
    await Proposal.create({
      id: getTextValue(params[2]),
      proposer: getFirstValueFromJson(params[1]),
      blockId,
      identityId: getTextValue(params[0]),
      state: ProposalState.Pending,
      balance: getTextValue(params[3]),
      url: getTextValue(params[4]),
      description: getTextValue(params[5]),
      snapshotted: false,
      totalAyeWeight: 0,
      totalNayWeight: 0,
      lastStateUpdatedAt: blockId,
    }).save();
  }

  if (eventId === EventIdEnum.ProposalStateUpdated) {
    const pipId = getTextValue(params[1]);
    const proposal = await Proposal.get(pipId);
    proposal.state = getTextValue(params[2]);
    proposal.lastStateUpdatedAt = blockId;
    await proposal.save();
  }

  if (eventId === EventIdEnum.Voted) {
    const account = getTextValue(params[1]);
    const pipId = getTextValue(params[2]);
    const vote = getTextValue(params[3]);
    const weight = getTextValue(params[4]);

    const promises = [
      (async () => {
        const proposal = await Proposal.get(pipId);
        if (vote) {
          proposal.totalAyeWeight += BigInt(weight);
        } else {
          proposal.totalNayWeight += BigInt(weight);
        }
        await proposal.save();
      })(),
    ];

    promises.push(
      ProposalVote.create({
        id: `${blockId}/${event.idx}`,
        proposalId: pipId,
        blockId,
        eventIdx: event.idx,
        account,
        vote,
        weight,
      }).save()
    );
    await Promise.all(promises);
  }

  if (eventId === EventIdEnum.SnapshotTaken) {
    const pips = params[2].toJSON() as any;
    const promises = [];
    pips.forEach((pip) => {
      const job = async () => {
        const proposal = await Proposal.get(pip.id);
        proposal.snapshotted = true;
        return proposal.save();
      };
      promises.push(job());
    });
    await Promise.all(promises);
  }
}
