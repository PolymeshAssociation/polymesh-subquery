import { AffirmStatusEnum } from '../../../types/enums';
import { InstructionAffirmation } from '../../../types/models/InstructionAffirmation';
import { InstructionParty } from '../../../types/models/InstructionParty';
import { HolderRef, holderAffirmationId } from '../../../utils/settlements';

/** A party is keyed by its identity, or by its account when the account has no identity. */
export const getPartyId = (
  instructionId: string,
  identityId: string | undefined,
  accountId: string | undefined,
  isMediator: boolean
): string => `${instructionId}/${identityId ?? accountId}/${isMediator}`;

/** A holder's approval row as the chain starts it: pending, with nobody having acted on it. */
export const pendingHolderAffirmation = (
  instructionId: string,
  holder: HolderRef,
  blockEventId: string
): InstructionAffirmation =>
  InstructionAffirmation.create({
    id: holderAffirmationId(instructionId, holder),
    instructionId,
    partyId: getPartyId(instructionId, holder.identityId, holder.accountId, false),
    identityId: holder.identityId,
    accountId: holder.accountId,
    portfolioId: holder.portfolioId,
    isMediator: false,
    isAutomaticallyAffirmed: false,
    status: AffirmStatusEnum.Pending,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  });

export interface HolderAffirmationChange {
  status: AffirmStatusEnum;
  isAutomaticallyAffirmed: boolean;
  /** the event's caller */
  affirmedById: string;
  /** the extrinsic's signer; undefined when there is none */
  signerId: string | undefined;
  blockEventId: string;
}

/** Applies an affirm, auto-affirm or withdraw event to a holder's row. */
export const applyHolderAffirmation = (
  row: InstructionAffirmation,
  { status, isAutomaticallyAffirmed, affirmedById, signerId, blockEventId }: HolderAffirmationChange
): InstructionAffirmation => {
  row.status = status;
  row.isAutomaticallyAffirmed = isAutomaticallyAffirmed;
  row.affirmedById = affirmedById;
  row.signerId = signerId;
  row.updatedEventId = blockEventId;
  return row;
};

/**
 * A holder's row, read or, when the instruction's creation didn't write one, created with its
 * party so that `partyId` never points at nothing. Unsaved.
 */
const holderRow = async (
  instructionId: string,
  holder: HolderRef,
  blockEventId: string
): Promise<InstructionAffirmation> => {
  const existing = await InstructionAffirmation.get(holderAffirmationId(instructionId, holder));
  if (existing) {
    return existing;
  }

  const row = pendingHolderAffirmation(instructionId, holder, blockEventId);
  if (!(await InstructionParty.get(row.partyId))) {
    await InstructionParty.create({
      id: row.partyId,
      instructionId,
      isMediator: false,
      identityId: holder.identityId,
      accountId: holder.identityId ? undefined : holder.accountId,
      createdEventId: blockEventId,
      updatedEventId: blockEventId,
    }).save();
  }
  return row;
};

/** Sets a holder's approval from an affirm, auto-affirm or withdraw event. Unsaved. */
export const setHolderAffirmation = async (
  instructionId: string,
  holder: HolderRef,
  change: HolderAffirmationChange
): Promise<InstructionAffirmation> =>
  applyHolderAffirmation(await holderRow(instructionId, holder, change.blockEventId), change);
