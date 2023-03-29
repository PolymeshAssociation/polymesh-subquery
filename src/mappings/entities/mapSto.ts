import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { EventIdEnum, Investment, ModuleIdEnum, Sto, StoStatus } from '../../types';
import {
  getFundraiserDetails,
  getNumberValue,
  coerceHexToString,
  getTextValue,
  serializeTicker,
  getDateValue,
  getBigIntValue,
} from '../util';
import { HandlerArgs } from './common';

const handleFundraiserCreated = async (blockId: string, params: Codec[]) => {
  const [, rawStoId, rawStoName, rawFundraiserDetails] = params;
  const fundraiserDetails = getFundraiserDetails(rawFundraiserDetails);
  const stoId = getNumberValue(rawStoId);
  const name = coerceHexToString(getTextValue(rawStoName));

  await Sto.create({
    id: `${fundraiserDetails.offeringAssetId}/${stoId}`,
    stoId,
    name,
    ...fundraiserDetails,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

const handleFundraiserStatus = async (
  blockId: string,
  params: Codec[],
  event: SubstrateEvent,
  status: StoStatus
) => {
  const [, rawStoId] = params;
  const offeringAssetId = serializeTicker(event.extrinsic.extrinsic.args[0]);
  const stoId = getNumberValue(rawStoId);

  const sto = await Sto.get(`${offeringAssetId}/${stoId}`);

  if (!sto) {
    throw new Error(`Sto with id ${offeringAssetId}/${stoId} was not found`);
  }

  sto.status = status;
  if (status === StoStatus.Closed) {
    // if sto is closed before the configured end time, status should be set as `ClosedEarly`
    if (sto.end && event.block.timestamp < sto.end) {
      sto.status = StoStatus.ClosedEarly;
    }
  }
  sto.updatedBlockId = blockId;
  await sto.save();
};

const handleFundraiserWindowModified = async (
  blockId: string,
  params: Codec[],
  event: SubstrateEvent
) => {
  const [, rawStoId, , , rawStart, rawEnd] = params;
  const offeringAssetId = serializeTicker(event.extrinsic.extrinsic.args[0]);
  const stoId = getNumberValue(rawStoId);

  const sto = await Sto.get(`${offeringAssetId}/${stoId}`);

  if (sto) {
    sto.start = getDateValue(rawStart);
    sto.end = getDateValue(rawEnd);
    sto.updatedBlockId = blockId;
    await sto.save();
  }
};

const handleInvested = async (
  blockId: string,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> => {
  const [
    rawInvestor,
    rawStoId,
    rawOfferingToken,
    rawRaiseToken,
    rawOfferingTokenAmount,
    rawRaiseTokenAmount,
  ] = params;

  await Investment.create({
    id: `${blockId}/${event.idx}`,
    investorId: getTextValue(rawInvestor),
    stoId: getNumberValue(rawStoId),
    offeringToken: serializeTicker(rawOfferingToken),
    raiseToken: serializeTicker(rawRaiseToken),
    offeringTokenAmount: getBigIntValue(rawOfferingTokenAmount),
    raiseTokenAmount: getBigIntValue(rawRaiseTokenAmount),
    datetime: event.block.timestamp,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

/**
 * Subscribes to events related to STOs
 */
export async function mapSto({
  blockId,
  eventId,
  moduleId,
  params,
  event,
}: HandlerArgs): Promise<void> {
  if (moduleId !== ModuleIdEnum.sto) {
    return;
  }

  if (eventId === EventIdEnum.FundraiserCreated) {
    await handleFundraiserCreated(blockId, params);
  }

  if (eventId === EventIdEnum.FundraiserFrozen) {
    await handleFundraiserStatus(blockId, params, event, StoStatus.Frozen);
  }

  if (eventId === EventIdEnum.FundraiserUnfrozen) {
    await handleFundraiserStatus(blockId, params, event, StoStatus.Live);
  }

  if (eventId === EventIdEnum.FundraiserClosed) {
    await handleFundraiserStatus(blockId, params, event, StoStatus.Closed);
  }

  if (eventId === EventIdEnum.FundraiserWindowModified) {
    await handleFundraiserWindowModified(blockId, params, event);
  }

  if (eventId === EventIdEnum.Invested) {
    await handleInvested(blockId, params, event);
  }
}
