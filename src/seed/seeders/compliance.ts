import { Codec } from '@polkadot/types/types';
import {
  conditionId,
  getStatTypeId,
  getStatTypes,
  getTransferConditions,
} from '../../mappings/entities/assets/mapStatistics';
import {
  Compliance,
  StatType,
  TransferCompliance,
  TransferComplianceExemption,
  TrustedClaimIssuer,
} from '../../types';
import { getAssetIdForLegacyTicker } from '../../utils/assets';
import { memberOf } from '../../utils/codec';
import { getComplianceValues, getExemptKeyValue } from '../../utils/compliance';
import { pageRows, SeedContext, Seeder } from '../seeder';
import { ChainSnapshot, Entry, StorageRef } from '../snapshot';
import { assetIdOf } from './assetKeys';

/**
 * An asset's transfer restrictions and compliance: its active statistics, transfer conditions and
 * their exemptions, requirements and default trusted issuers, each parsed as the handlers parse the
 * events that set them. From 5.0 to 6.3 the statistics are keyed by a scope over a ticker.
 */

const created = (ctx: SeedContext) => ({
  createdEventId: ctx.eventId,
  updatedEventId: ctx.eventId,
});

/** The rows `build` makes of each value of an item keyed by asset */
async function* perAsset<T>(
  snap: ChainSnapshot,
  item: StorageRef,
  build: (value: Codec, assetId: string) => T[]
): AsyncGenerator<T[]> {
  for await (const page of snap.pages(item)) {
    yield await pageRows(page as Entry[], async ({ args, value }) =>
      value ? build(value, await assetIdOf(args[0])) : []
    );
  }
}

export const statTypeSeeder: Seeder<StatType> = {
  entity: 'StatType',
  reads: ['statistics.activeAssetStats'],
  rows: (snap, ctx) =>
    perAsset(snap, 'statistics.activeAssetStats', (value, assetId) =>
      getStatTypes(value, ctx.block).map(statType =>
        StatType.create({
          id: getStatTypeId(
            assetId,
            statType.opType,
            statType.claimType,
            statType.claimIssuerId,
            statType.customClaimTypeId
          ),
          assetId,
          ...statType,
          ...created(ctx),
        })
      )
    ),
};

export const transferComplianceSeeder: Seeder<TransferCompliance> = {
  entity: 'TransferCompliance',
  reads: ['statistics.assetTransferCompliances'],
  rows: (snap, ctx) =>
    perAsset(snap, 'statistics.assetTransferCompliances', (value, assetId) =>
      getTransferConditions(memberOf(value, 'requirements'), assetId)
        .filter(Boolean)
        .map(condition =>
          TransferCompliance.create({ id: conditionId(condition), ...condition, ...created(ctx) })
        )
    ),
};

export const transferComplianceExemptionSeeder: Seeder<TransferComplianceExemption> = {
  entity: 'TransferComplianceExemption',
  reads: ['statistics.transferConditionExemptEntities'],
  async *rows(snap, ctx) {
    for await (const page of snap.pages('statistics.transferConditionExemptEntities')) {
      yield await pageRows(page, async ({ args, value }) => {
        if (value?.toJSON() !== true) {
          return [];
        }
        const key = await getExemptKeyValue(args[0], ctx.block);
        // before 7.0 the key's asset is a ticker
        const assetId =
          key.assetId.length === 26 ? await getAssetIdForLegacyTicker(key.assetId) : key.assetId;
        const entity = args[1].toString();
        return [
          TransferComplianceExemption.create({
            id: `${assetId}/${key.opType}/${key.claimType}/${entity}`,
            ...key,
            assetId,
            exemptedEntityId: entity,
            ...created(ctx),
          }),
        ];
      });
    }
  },
};

export const complianceSeeder: Seeder<Compliance> = {
  entity: 'Compliance',
  reads: ['complianceManager.assetCompliances'],
  rows: (snap, ctx) =>
    perAsset(snap, 'complianceManager.assetCompliances', (value, assetId) =>
      getComplianceValues(memberOf(value, 'requirements')).map(({ complianceId, data }) =>
        Compliance.create({
          id: `${assetId}/${complianceId}`,
          complianceId,
          data,
          assetId,
          ...created(ctx),
        })
      )
    ),
};

export const trustedClaimIssuerSeeder: Seeder<TrustedClaimIssuer> = {
  entity: 'TrustedClaimIssuer',
  reads: ['complianceManager.trustedClaimIssuer'],
  rows: (snap, ctx) =>
    perAsset(snap, 'complianceManager.trustedClaimIssuer', (value, assetId) =>
      ((value.toJSON() as { issuer: string }[] | null) ?? []).map(({ issuer }) =>
        TrustedClaimIssuer.create({
          id: `${assetId}/${issuer}`,
          assetId,
          issuerId: issuer,
          ...created(ctx),
        })
      )
    ),
};
