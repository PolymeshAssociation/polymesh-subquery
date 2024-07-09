import { Codec } from '@polkadot/types/types';
import { Attributes } from '../mappings/entities/common';
import {
  ClaimTypeEnum,
  Compliance,
  TransferComplianceExemption,
  TransferManager,
  TransferRestrictionTypeEnum,
} from '../types';
import { capitalizeFirstLetter, hexToString } from './common';

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

export const getExemptKeyValue = (
  item: Codec
): Omit<Attributes<TransferComplianceExemption>, 'exemptedEntityId'> => {
  const {
    asset: { ticker },
    op: opType,
    claimType: claimTypeValue,
  } = JSON.parse(item.toString());

  let claimType;
  if (!claimTypeValue || typeof claimTypeValue === 'string') {
    claimType = claimTypeValue;
  } else {
    // from 5.1.0 chain version, Custom(CustomClaimTypeId) was added to the ClaimTypeEnum, polkadot now reads values as {"accredited": undefined}
    claimType = capitalizeFirstLetter(Object.keys(claimTypeValue)[0]) as ClaimTypeEnum;
  }

  return {
    assetId: hexToString(ticker),
    opType,
    claimType,
  };
};

export const getExemptionsValue = (exemptions: Codec): string[] => {
  return exemptions.toJSON() as string[];
};
