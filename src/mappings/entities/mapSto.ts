import { SubstrateEvent } from '@subql/types';
import { Investment, Sto, StoStatus } from '../../types';
import {
  coerceHexToString,
  getBigIntValue,
  getDateValue,
  getFundraiserDetails,
  getNumberValue,
  getTextValue,
  serializeTicker,
} from '../util';
import { extractArgs } from './common';

export const handleFundraiserCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
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

export const handleStoFrozen = async (event: SubstrateEvent): Promise<void> => {
  await handleFundraiserStatus(event, StoStatus.Frozen);
};

export const handleStoUnfrozen = async (event: SubstrateEvent): Promise<void> => {
  await handleFundraiserStatus(event, StoStatus.Live);
};
export const handleStoClosed = async (event: SubstrateEvent): Promise<void> => {
  await handleFundraiserStatus(event, StoStatus.Closed);
};

const handleFundraiserStatus = async (event: SubstrateEvent, status: StoStatus): Promise<void> => {
  const { params, extrinsic, block, blockId } = extractArgs(event);
  const [, rawStoId] = params;
  const offeringAssetId = serializeTicker(extrinsic.extrinsic.args[0]);
  const stoId = getNumberValue(rawStoId);

  const sto = await Sto.get(`${offeringAssetId}/${stoId}`);

  if (!sto) {
    throw new Error(`Sto with id ${offeringAssetId}/${stoId} was not found`);
  }

  sto.status = status;
  if (status === StoStatus.Closed) {
    // if sto is closed before the configured end time, status should be set as `ClosedEarly`
    if (sto.end && block.timestamp < sto.end) {
      sto.status = StoStatus.ClosedEarly;
    }
  }
  sto.updatedBlockId = blockId;
  await sto.save();
};

export const handleFundraiserWindowModified = async (event: SubstrateEvent): Promise<void> => {
  const { params, extrinsic, blockId } = extractArgs(event);
  const [, rawStoId, , , rawStart, rawEnd] = params;
  const offeringAssetId = serializeTicker(extrinsic.extrinsic.args[0]);
  const stoId = getNumberValue(rawStoId);

  const sto = await Sto.get(`${offeringAssetId}/${stoId}`);

  if (sto) {
    sto.start = getDateValue(rawStart);
    sto.end = getDateValue(rawEnd);
    sto.updatedBlockId = blockId;
    await sto.save();
  }
};

export const handleInvested = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, eventIdx, block } = extractArgs(event);
  const [
    rawInvestor,
    rawStoId,
    rawOfferingToken,
    rawRaiseToken,
    rawOfferingTokenAmount,
    rawRaiseTokenAmount,
  ] = params;

  await Investment.create({
    id: `${blockId}/${eventIdx}`,
    investorId: getTextValue(rawInvestor),
    stoId: getNumberValue(rawStoId),
    offeringToken: serializeTicker(rawOfferingToken),
    raiseToken: serializeTicker(rawRaiseToken),
    offeringTokenAmount: getBigIntValue(rawOfferingTokenAmount),
    raiseTokenAmount: getBigIntValue(rawRaiseTokenAmount),
    datetime: block.timestamp,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};
