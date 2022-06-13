import { Codec } from '@polkadot/types/types';
import { StatType, TransferCompliance, TransferComplianceExemption } from '../../types';
import { capitalizeFirstLetter, getExemptKeyValue, hexToString } from '../util';
import {
  Attributes,
  EventIdEnum,
  HandlerArgs,
  ModuleIdEnum,
  StatOpType,
  TransferComplianceType,
} from './common';

const getStatisticsScope = (item: Codec): { assetId: string } => {
  const { ticker } = JSON.parse(item.toString());
  return { assetId: hexToString(ticker) };
};

interface MeshStatType {
  op: string;
  claimIssuer: string[] | null;
}

const getStatTypes = (item: Codec): Pick<StatType, 'opType' | 'claimType' | 'claimIssuerId'>[] => {
  const statTypes = JSON.parse(item.toString()) as MeshStatType[];
  return statTypes.map(({ op: opType, claimIssuer }) => {
    let claimType: string = null;
    let claimIssuerId: string = null;
    if (claimIssuer) {
      claimType = claimIssuer[0];
      claimIssuerId = claimIssuer[1];
    }
    return {
      opType,
      claimType,
      claimIssuerId,
    };
  });
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
  return { type: capitalizeFirstLetter(type), value: statClaim[type] };
};

const getTransferConditions = (item: Codec, assetId: string): Attributes<TransferCompliance>[] => {
  const transferConditions = JSON.parse(item.toString()) as MeshTransferCondition[];
  return transferConditions.map(
    ({ maxInvestorCount, maxInvestorOwnership, claimOwnership, claimCount }) => {
      if (maxInvestorCount) {
        return {
          assetId,
          type: TransferComplianceType.MaxInvestorCount,
          statTypeId: getStatTypeId(assetId, StatOpType.Count),
          value: BigInt(maxInvestorCount),
        };
      }
      if (maxInvestorOwnership) {
        return {
          assetId,
          type: TransferComplianceType.MaxInvestorOwnership,
          statTypeId: getStatTypeId(assetId, StatOpType.Balance),
          value: BigInt(maxInvestorOwnership),
        };
      }
      if (claimCount) {
        const { type: claimType, value: claimValue } = getStatClaim(claimCount[0]);
        const claimIssuerId = claimCount[1];
        return {
          assetId,
          type: TransferComplianceType.ClaimCount,
          statTypeId: getStatTypeId(assetId, StatOpType.Count, claimType, claimIssuerId),
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
          type: TransferComplianceType.ClaimOwnership,
          statTypeId: getStatTypeId(assetId, StatOpType.Balance, claimType, claimIssuerId),
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
  claimIssuerId?: string
) => {
  let statTypeId = `${assetId}/${opType}`;
  if (claimType) {
    statTypeId += `/${claimType}/${claimIssuerId}`;
  }
  return statTypeId;
};

const handleStatTypeAdded = async (blockId: string, params: Codec[]) => {
  const [, rawStatisticsScope, rawStatType] = params;

  const { assetId } = getStatisticsScope(rawStatisticsScope);
  const statTypes = getStatTypes(rawStatType);

  const promises = [];
  statTypes.forEach(({ opType, claimType, claimIssuerId }) => {
    const upsert = async () => {
      const statTypeId = getStatTypeId(assetId, opType, claimType, claimIssuerId);
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
          createdBlockId: blockId,
          updatedBlockId: blockId,
        });
      }
      return statType.save();
    };
    promises.push(upsert());
  });

  await Promise.all(promises);
};

const handleStatTypeRemoved = async (params: Codec[]) => {
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

const handleSetTransferCompliance = async (blockId: string, params: Codec[]): Promise<void> => {
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

const handleExemptionsAdded = async (blockId: string, params: Codec[]) => {
  const [, rawExemptKey, rawExemptions] = params;

  const exemptKey = getExemptKeyValue(rawExemptKey);
  const exemptedEntities = rawExemptions.toJSON() as string[];

  const { assetId, opType, claimType } = exemptKey;
  let exemption = await TransferComplianceExemption.get(`${assetId}/${opType}/${claimType}`);
  if (exemption) {
    Object.assign(exemption, {
      exemptedEntities: [...new Set([...exemption.exemptedEntities, ...exemptedEntities])],
      updatedBlockId: blockId,
    });
  } else {
    exemption = TransferComplianceExemption.create({
      id: `${assetId}/${opType}/${claimType}`,
      ...exemptKey,
      exemptedEntities,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    });
  }
  await exemption.save();
};

const handleExemptionsRemoved = async (blockId: string, params: Codec[]) => {
  const [, rawExemptKey, rawExemptions] = params;

  const { assetId, opType, claimType } = getExemptKeyValue(rawExemptKey);
  const exemptedEntities = rawExemptions.toJSON() as string[];

  const exemption = await TransferComplianceExemption.get(`${assetId}/${opType}/${claimType}`);
  if (exemption) {
    const remainingEntities = exemption.exemptedEntities.filter(
      entity => !exemptedEntities.includes(entity)
    );
    if (remainingEntities.length) {
      Object.assign(exemption, {
        exemptedEntities: remainingEntities,
        updatedBlockId: blockId,
      });
      await exemption.save();
    } else {
      await TransferComplianceExemption.remove(`${assetId}/${opType}/${claimType}`);
    }
  }
};

export async function mapStatistics({
  blockId,
  eventId,
  moduleId,
  params,
}: HandlerArgs): Promise<void> {
  if (moduleId === ModuleIdEnum.Statistics) {
    if (eventId === EventIdEnum.StatTypesAdded) {
      await handleStatTypeAdded(blockId, params);
    }
    if (eventId === EventIdEnum.StatTypesRemoved) {
      await handleStatTypeRemoved(params);
    }
    if (eventId === EventIdEnum.SetAssetTransferCompliance) {
      await handleSetTransferCompliance(blockId, params);
    }
    if (eventId === EventIdEnum.TransferConditionExemptionsAdded) {
      await handleExemptionsAdded(blockId, params);
    }
    if (eventId === EventIdEnum.TransferConditionExemptionsRemoved) {
      await handleExemptionsRemoved(blockId, params);
    }
  }
}
