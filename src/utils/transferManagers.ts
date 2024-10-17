import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { Attributes } from '../mappings/entities/common';
import {
  ClaimTypeEnum,
  Compliance,
  TransferComplianceExemption,
  TransferManager,
  TransferRestrictionTypeEnum,
} from '../types';
import { getAssetId } from './assets';
import { capitalizeFirstLetter } from './common';

/**
 * Parses a Vec<AssetCompliance>
 */
export const getComplianceValues = (
  requirements: Codec
): Pick<Compliance, 'complianceId' | 'data'>[] => {
  const compliances = JSON.parse(requirements.toString());

  return compliances.map(({ id, ...data }) => ({
    complianceId: Number(id),
    data: JSON.stringify(data),
  }));
};

/**
 * Parses AssetCompliance
 */
export const getComplianceValue = (
  compliance: Codec
): Pick<Compliance, 'complianceId' | 'data'> => {
  const { id, ...data } = JSON.parse(compliance.toString());
  return {
    complianceId: Number(id),
    data: JSON.stringify(data),
  };
};

/**
 * Parses AssetTransferManager
 */
export const getTransferManagerValue = (
  manager: Codec
): Pick<TransferManager, 'type' | 'value'> => {
  const { countTransferManager, percentageTransferManager } = JSON.parse(JSON.stringify(manager));

  if (countTransferManager) {
    return {
      type: TransferRestrictionTypeEnum.Count,
      value: Number(countTransferManager),
    };
  }

  if (percentageTransferManager) {
    return {
      type: TransferRestrictionTypeEnum.Percentage,
      value: Number(percentageTransferManager),
    };
  }

  throw new Error('Unknown transfer restriction type found');
};

export const getExemptKeyValue = async (
  item: Codec,
  block: SubstrateBlock
): Promise<Omit<Attributes<TransferComplianceExemption>, 'exemptedEntityId'>> => {
  const exemptKey = JSON.parse(item.toString());

  const { op, operationType, claimType: claimTypeValue } = exemptKey;

  const opType = operationType ?? op;
  let assetId: string;

  if ('assetId' in exemptKey) {
    assetId = exemptKey.assetId;
  } else {
    assetId = exemptKey.asset.ticker;
  }

  let claimType;
  if (!claimTypeValue || typeof claimTypeValue === 'string') {
    claimType = claimTypeValue;
  } else {
    // from 5.1.0 chain version, Custom(CustomClaimTypeId) was added to the ClaimTypeEnum, polkadot now reads values as {"accredited": undefined}
    claimType = capitalizeFirstLetter(Object.keys(claimTypeValue)[0]) as ClaimTypeEnum;
  }

  return {
    assetId: await getAssetId(assetId, block),
    opType,
    claimType,
  };
};

export const getExemptionsValue = (exemptions: Codec): string[] => {
  return exemptions.toJSON() as string[];
};
