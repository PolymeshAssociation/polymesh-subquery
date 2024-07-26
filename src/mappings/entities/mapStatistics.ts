import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import {
  Asset,
  ClaimTypeEnum,
  StatOpTypeEnum,
  StatType,
  TransferCompliance,
  TransferComplianceExemption,
  TransferComplianceTypeEnum,
  TransferRestrictionTypeEnum,
} from '../../types';
import {
  capitalizeFirstLetter,
  getExemptKeyValue,
  getExemptionsValue,
  getTransferManagerValue,
  hexToString,
  serializeTicker,
} from '../util';
import { Attributes, extractArgs } from './common';

const getStatisticsScope = (item: Codec): { assetId: string } => {
  const { ticker } = JSON.parse(item.toString());
  return { assetId: hexToString(ticker) };
};

interface MeshStatType {
  op: string;
  claimIssuer: string[] | null;
}

const transferRestrictionSpecVersion = 5000000;

const getStatTypes = (item: Codec): Omit<Attributes<StatType>, 'assetId'>[] => {
  const statTypes = JSON.parse(item.toString()) as MeshStatType[];
  return statTypes.map(({ op: opType, claimIssuer }) => {
    /**
     * claimIssuer -> Option<PolymeshPrimitivesIdentityClaimClaimType, PolymeshPrimitivesIdentityId>
     * E.g. - [{ accredited: null }, '0x0100000000000000000000000000000000000000000000000000000000000000']
     * In case of custom claim type, [{custom: 1}, '0x0100000000000000000000000000000000000000000000000000000000000000']
     */
    if (claimIssuer) {
      const [claimTypeInfo, claimIssuerId] = claimIssuer;
      const claimType = Object.keys(claimTypeInfo)[0];
      let customClaimTypeId;
      if (claimType === 'custom') {
        customClaimTypeId = claimTypeInfo[claimType];
      }
      return {
        opType: opType as StatOpTypeEnum,
        claimType: capitalizeFirstLetter(claimType) as ClaimTypeEnum,
        customClaimTypeId,
        claimIssuerId,
      };
    }
    return {
      opType: opType as StatOpTypeEnum,
    };
  });
};

const upsertStatType = async (
  { assetId, opType, claimType, claimIssuerId, customClaimTypeId }: Attributes<StatType>,
  blockId: string
) => {
  const statTypeId = getStatTypeId(assetId, opType, claimType, claimIssuerId, customClaimTypeId);
  let statType = await StatType.get(statTypeId);
  if (statType) {
    statType.updatedBlockId = blockId;
  } else {
    statType = StatType.create({
      id: statTypeId,
      assetId,
      opType,
      claimType,
      claimIssuerId,
      customClaimTypeId,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    });
  }
  return statType.save();
};

interface MeshStatClaim {
  Accredited?: boolean;
  Affiliate?: boolean;
  Jurisdiction?: string;
}

interface MeshTransferCondition {
  maxInvestorCount: bigint;
  maxInvestorOwnership: bigint;
  claimOwnership: [MeshStatClaim, string, bigint, bigint];
  claimCount: [MeshStatClaim, string, bigint, bigint];
}

const getStatClaim = (statClaim: MeshStatClaim) => {
  const type = Object.keys(statClaim)[0];
  return { type: capitalizeFirstLetter(type) as ClaimTypeEnum, value: statClaim[type] };
};

const getTransferConditions = (item: Codec, assetId: string): Attributes<TransferCompliance>[] => {
  const transferConditions = JSON.parse(item.toString()) as MeshTransferCondition[];
  return transferConditions.map(
    ({ maxInvestorCount, maxInvestorOwnership, claimOwnership, claimCount }) => {
      if (maxInvestorCount) {
        return {
          assetId,
          type: TransferComplianceTypeEnum.MaxInvestorCount,
          statTypeId: getStatTypeId(assetId, StatOpTypeEnum.Count),
          value: BigInt(maxInvestorCount),
        };
      }
      if (maxInvestorOwnership) {
        return {
          assetId,
          type: TransferComplianceTypeEnum.MaxInvestorOwnership,
          statTypeId: getStatTypeId(assetId, StatOpTypeEnum.Balance),
          value: BigInt(maxInvestorOwnership),
        };
      }
      if (claimCount) {
        const { type: claimType, value: claimValue } = getStatClaim(claimCount[0]);
        const claimIssuerId = claimCount[1];
        return {
          assetId,
          type: TransferComplianceTypeEnum.ClaimCount,
          statTypeId: getStatTypeId(assetId, StatOpTypeEnum.Count, claimType, claimIssuerId),
          claimType,
          claimValue,
          claimIssuerId,
          min: BigInt(claimCount[2]),
          max: BigInt(claimCount[3]),
        };
      }
      if (claimOwnership) {
        const { type: claimType, value: claimValue } = getStatClaim(claimOwnership[0]);
        const claimIssuerId = claimOwnership[1];
        return {
          assetId,
          type: TransferComplianceTypeEnum.ClaimOwnership,
          statTypeId: getStatTypeId(assetId, StatOpTypeEnum.Balance, claimType, claimIssuerId),
          claimType,
          claimValue,
          claimIssuerId,
          min: BigInt(claimOwnership[2]),
          max: BigInt(claimOwnership[3]),
        };
      }
    }
  );
};

const getStatTypeId = (
  assetId: string,
  opType: string,
  claimType?: string,
  claimIssuerId?: string,
  customClaimTypeId?: string
) => {
  let statTypeId = `${assetId}/${opType}`;
  if (claimType) {
    if (claimType === ClaimTypeEnum.Custom) {
      statTypeId += `/${claimType}/${customClaimTypeId}/${claimIssuerId}`;
    } else {
      statTypeId += `/${claimType}/${claimIssuerId}`;
    }
  }
  return statTypeId;
};

export const handleStatTypeAdded = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const [, rawStatisticsScope, rawStatType] = params;

  const { assetId } = getStatisticsScope(rawStatisticsScope);
  const statTypes = getStatTypes(rawStatType);

  const promises = [];
  statTypes.forEach(statType => {
    const upsert = async () => {
      return upsertStatType({ assetId, ...statType }, blockId);
    };
    promises.push(upsert());
  });

  await Promise.all(promises);
};

export const handleStatTypeRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { params } = extractArgs(event);

  const [, rawStatisticsScope, rawStatType] = params;

  const { assetId } = getStatisticsScope(rawStatisticsScope);
  const statTypes = getStatTypes(rawStatType);

  await Promise.all(
    statTypes.map(({ opType, claimType, claimIssuerId }) => {
      const statTypeId = getStatTypeId(assetId, opType, claimType, claimIssuerId);
      return StatType.remove(statTypeId);
    })
  );
};

export const handleSetTransferCompliance = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const [, rawStatisticsScope, rawTransferConditions] = params;

  const { assetId } = getStatisticsScope(rawStatisticsScope);

  const transferConditions = getTransferConditions(rawTransferConditions, assetId);

  const existingTransferCompliances = await TransferCompliance.getByAssetId(assetId);

  const removedConditions = existingTransferCompliances
    .filter(
      ({ statTypeId: existingStatTypeId }) =>
        !transferConditions.some(({ statTypeId }) => statTypeId === existingStatTypeId)
    )
    .map(({ id }) => TransferCompliance.remove(id));

  const newConditions = [];

  transferConditions.forEach(condition => {
    const upsert = async () => {
      const { statTypeId } = condition;
      let transferCompliance = await TransferCompliance.get(statTypeId);
      if (transferCompliance) {
        Object.assign(transferCompliance, {
          ...condition,
          updatedBlockId: blockId,
        });
      } else {
        transferCompliance = TransferCompliance.create({
          id: statTypeId,
          ...condition,
          createdBlockId: blockId,
          updatedBlockId: blockId,
        });
      }
      return transferCompliance.save();
    };
    newConditions.push(upsert());
  });

  await Promise.all([...removedConditions, ...newConditions]);
};

export const handleStatisticExemptionsAdded = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const [, rawExemptKey, rawExemptions] = params;

  const exemptKey = getExemptKeyValue(rawExemptKey);
  const exemptedEntities = rawExemptions.toJSON() as string[];

  const { assetId, opType, claimType } = exemptKey;

  const promises = [];
  exemptedEntities.forEach(entity => {
    const upsert = async () => {
      const exemptionId = `${assetId}/${opType}/${claimType}/${entity}`;
      let exemption = await TransferComplianceExemption.get(exemptionId);
      if (exemption) {
        exemption.updatedBlockId = blockId;
      } else {
        exemption = TransferComplianceExemption.create({
          id: exemptionId,
          ...exemptKey,
          exemptedEntityId: entity,
          createdBlockId: blockId,
          updatedBlockId: blockId,
        });
      }
      return exemption.save();
    };
    promises.push(upsert());
  });

  await Promise.all(promises);
};

export const handleStatisticExemptionsRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { params } = extractArgs(event);

  const [, rawExemptKey, rawExemptions] = params;

  const { assetId, opType, claimType } = getExemptKeyValue(rawExemptKey);
  const exemptedEntities = rawExemptions.toJSON() as string[];

  await Promise.all(
    exemptedEntities.map(entity =>
      TransferComplianceExemption.remove(`${assetId}/${opType}/${claimType}/${entity}`)
    )
  );
};

export const handleStatisticTransferManagerAdded = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const [, rawTicker, rawManager] = params;

  const assetId = serializeTicker(rawTicker);
  const { type } = getTransferManagerValue(rawManager);

  if (type === TransferRestrictionTypeEnum.Percentage) {
    await upsertStatType(
      { assetId, opType: StatOpTypeEnum.Balance, claimType: null, claimIssuerId: null },
      blockId
    );
  }
};

export const handleTransferManagerExemptionsAdded = async (
  event: SubstrateEvent
): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const [, rawTicker, rawAgentGroup, rawExemptions] = params;

  const ticker = serializeTicker(rawTicker);
  const { type } = getTransferManagerValue(rawAgentGroup);
  const parsedExemptions = getExemptionsValue(rawExemptions);

  const opType =
    type === TransferRestrictionTypeEnum.Percentage ? StatOpTypeEnum.Balance : StatOpTypeEnum.Count;

  const exemptKey = {
    assetId: ticker,
    opType,
    claimType: null,
  };

  const transferComplianceExemptions = await TransferComplianceExemption.getByAssetId(ticker);

  const existingExemptions = transferComplianceExemptions.filter(
    ({ opType: exemptionType, exemptedEntityId }) =>
      exemptionType == opType && parsedExemptions.includes(exemptedEntityId)
  );

  const promises = parsedExemptions.map(exemption => {
    const existingExemption = existingExemptions.find(
      ({ exemptedEntityId }) => exemption === exemptedEntityId
    );

    if (existingExemption) {
      existingExemption.updatedBlockId = blockId;
      return existingExemption.save();
    }

    return TransferComplianceExemption.create({
      id: exemption,
      ...exemptKey,
      exemptedEntityId: exemption,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  });

  await Promise.all(promises);
};

export const handleTransferManagerExemptionsRemoved = async (
  event: SubstrateEvent
): Promise<void> => {
  const { params } = extractArgs(event);

  const [, rawTicker, rawAgentGroup, rawExemptions] = params;

  const ticker = serializeTicker(rawTicker);
  const transferManagerValue = getTransferManagerValue(rawAgentGroup);
  const parsedExemptions = getExemptionsValue(rawExemptions);

  const transferComplianceExemptions = await TransferComplianceExemption.getByAssetId(ticker);

  const selectedOpType =
    transferManagerValue.type === TransferRestrictionTypeEnum.Percentage
      ? StatOpTypeEnum.Balance
      : StatOpTypeEnum.Count;

  const promises = transferComplianceExemptions
    .filter(
      ({ exemptedEntityId, opType }) =>
        opType === selectedOpType && parsedExemptions.includes(exemptedEntityId)
    )
    .map(({ id }) => TransferComplianceExemption.remove(id));

  await Promise.all(promises);
};

export const handleAssetIssuedStatistics = async (event: SubstrateEvent): Promise<void> => {
  const { params, block, blockId } = extractArgs(event);

  const [, rawTicker] = params;

  const assetId = serializeTicker(rawTicker);
  const { specVersion } = block;
  if (specVersion < transferRestrictionSpecVersion) {
    await upsertStatType(
      { assetId, opType: StatOpTypeEnum.Count, claimType: null, claimIssuerId: null },
      blockId
    );
  }
};

export const handleAssetRedeemedStatistics = async (event: SubstrateEvent): Promise<void> => {
  const { params, block } = extractArgs(event);

  const [, rawTicker] = params;
  const ticker = serializeTicker(rawTicker);

  const specVersion = block.specVersion;
  const specName = api.runtimeVersion.specName.toString();
  if (specVersion < transferRestrictionSpecVersion && specName !== 'polymesh_private_dev') {
    const asset = await Asset.getByTicker(ticker);
    if (asset.totalSupply === BigInt(0)) {
      await StatType.remove(`${ticker}/Count`);
    }
  }
};
