import { AffirmStatusEnum } from '../../../types/enums';
import { InstructionAffirmation } from '../../../types/models/InstructionAffirmation';
import { InstructionParty } from '../../../types/models/InstructionParty';
import { HolderRef, holderAffirmationId, mediatorAffirmationId } from '../../../utils/settlements';

/** A party is an identity: as a holder through its portfolios and accounts, or as a mediator. */
export const getPartyId = (
  instructionId: string,
  identityId: string,
  isMediator: boolean
): string => `${instructionId}/${identityId}/${isMediator}`;

/** A holder whose identity the index knows, as every holder's must be */
export type ResolvedHolder = HolderRef & { identityId: string };

export const isResolved = (holder: HolderRef): holder is ResolvedHolder => !!holder.identityId;

/** A holder's approval row as the chain starts it: pending, with nobody having acted on it. */
export const pendingHolderAffirmation = (
  instructionId: string,
  holder: ResolvedHolder,
  blockEventId: string
): InstructionAffirmation =>
  InstructionAffirmation.create({
    id: holderAffirmationId(instructionId, holder),
    instructionId,
    partyId: getPartyId(instructionId, holder.identityId, false),
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
    partyId: getPartyId(instructionId, did, true),
    identityId: did,
    isMediator: true,
    isAutomaticallyAffirmed: false,
    status: AffirmStatusEnum.Pending,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  });

/** A new row, with its party created if no earlier event created it, so `partyId` never dangles. */
const withParty = async (
  row: InstructionAffirmation,
  blockEventId: string
): Promise<InstructionAffirmation> => {
  if (!(await InstructionParty.get(row.partyId))) {
    await InstructionParty.create({
      id: row.partyId,
      instructionId: row.instructionId,
      isMediator: row.isMediator,
      identityId: row.identityId,
      createdEventId: blockEventId,
      updatedEventId: blockEventId,
    }).save();
  }
  return row;
};

/**
 * Sets a holder's approval from an affirm, auto-affirm or withdraw event. Unsaved. `undefined` when
 * the holder has no row and no identity in the index, so no party to record it under.
 */
export const setHolderAffirmation = async (
  instructionId: string,
  holder: HolderRef,
  change: HolderAffirmationChange
): Promise<InstructionAffirmation | undefined> => {
  const row =
    (await InstructionAffirmation.get(holderAffirmationId(instructionId, holder))) ??
    (isResolved(holder)
      ? await withParty(
          pendingHolderAffirmation(instructionId, holder, change.blockEventId),
          change.blockEventId
        )
      : undefined);
  return row && applyHolderAffirmation(row, change);
};

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
    (await InstructionAffirmation.get(mediatorAffirmationId(instructionId, did))) ??
      (await withParty(
        pendingMediatorAffirmation(instructionId, did, change.blockEventId),
        change.blockEventId
      )),
    { ...change, isAutomaticallyAffirmed: false }
  );
  row.expiry = change.expiry;
  return row;
};
