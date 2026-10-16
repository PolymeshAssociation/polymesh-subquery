import { AffirmStatusEnum } from '../../../types/enums';
import { InstructionAffirmation } from '../../../types/models/InstructionAffirmation';
import { InstructionParty } from '../../../types/models/InstructionParty';
import { HolderRef, holderAffirmationId, mediatorAffirmationId } from '../../../utils/settlements';

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

/** A mediator's approval row as the chain starts it: pending. */
export const pendingMediatorAffirmation = (
  instructionId: string,
  did: string,
  blockEventId: string
): InstructionAffirmation =>
  InstructionAffirmation.create({
    id: mediatorAffirmationId(instructionId, did),
    instructionId,
    partyId: getPartyId(instructionId, did, undefined, true),
    identityId: did,
    isMediator: true,
    isAutomaticallyAffirmed: false,
    status: AffirmStatusEnum.Pending,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  });

/**
 * The row with `id`, read or, when no earlier event wrote one, made by `pending` and given its
 * party, so that `partyId` never points at nothing. Unsaved.
 */
const existingOrNew = async (
  id: string,
  pending: () => InstructionAffirmation,
  blockEventId: string
): Promise<InstructionAffirmation> => {
  const existing = await InstructionAffirmation.get(id);
  if (existing) {
    return existing;
  }

  const row = pending();
  if (!(await InstructionParty.get(row.partyId))) {
    await InstructionParty.create({
      id: row.partyId,
      instructionId: row.instructionId,
      isMediator: row.isMediator,
      identityId: row.identityId,
      accountId: row.identityId ? undefined : row.accountId,
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
  applyHolderAffirmation(
    await existingOrNew(
      holderAffirmationId(instructionId, holder),
      () => pendingHolderAffirmation(instructionId, holder, change.blockEventId),
      change.blockEventId
    ),
    change
  );

/**
 * Sets a mediator's approval from its affirmation (`Affirmed`, with its expiry) or withdrawal
 * (`Pending`, no expiry). Unsaved.
 */
export const setMediatorAffirmation = async (
  instructionId: string,
  did: string,
  change: Omit<HolderAffirmationChange, 'isAutomaticallyAffirmed'> & { expiry?: Date }
): Promise<InstructionAffirmation> => {
  const row = applyHolderAffirmation(
    await existingOrNew(
      mediatorAffirmationId(instructionId, did),
      () => pendingMediatorAffirmation(instructionId, did, change.blockEventId),
      change.blockEventId
    ),
    { ...change, isAutomaticallyAffirmed: false }
  );
  row.expiry = change.expiry;
  return row;
};
