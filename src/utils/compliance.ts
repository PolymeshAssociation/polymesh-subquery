import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { Attributes } from '../mappings/entities/common';
import { ClaimTypeEnum, Compliance, TransferComplianceExemption } from '../types';
import { getAssetId } from './assets';
import { capitalizeFirstLetter } from './common';

/**
 * Parses a Vec<AssetCompliance>
 */
/**
 * Compliance JSON in the current form, whatever metadata decoded it: polkadot-js gives field names
 * snake_case before metadata v14, and a claim type its bare name until 5.4 gave `ClaimType` a
 * variant with data (`Custom`), `{ variant: null }` after. The bytes are the same either way.
 */
export const currentComplianceForm = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(currentComplianceForm);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, member]) => {
      const name = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
      if (name === 'specific' && Array.isArray(member)) {
        return [
          name,
          member.map(claimType =>
            typeof claimType === 'string'
              ? { [`${claimType[0].toLowerCase()}${claimType.slice(1)}`]: null }
              : claimType
          ),
        ];
      }
      return [name, currentComplianceForm(member)];
    })
  );
};

export const getComplianceValues = (
  requirements: Codec
): Pick<Compliance, 'complianceId' | 'data'>[] => {
  const compliances = JSON.parse(requirements.toString());

  return compliances.map(({ id, ...data }) => ({
    complianceId: Number(id),
    data: JSON.stringify(currentComplianceForm(data)),
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
    data: JSON.stringify(currentComplianceForm(data)),
  };
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
