import { SubstrateEvent } from '@subql/types';
import { EventIdEnum, StatOpTypeEnum, StatType } from 'polymesh-subql/types';
import { legacyAssets } from './legacyStats';

// Assets issued in previous specs will have the statistic `Count` implicitly enabled for the asset
const legacyStatsSpec = 5000002;

export async function mapCodeUpdated(event: SubstrateEvent): Promise<void> {
  const block = event.block;
  const blockId = block.block.header.number.toString();
  const specVersionId = block.specVersion;
  const eventType = event.event.method;

  if (eventType === EventIdEnum.CodeUpdated && specVersionId === legacyStatsSpec) {
    const chain = await api.rpc.system.chain();

    const newStats = legacyAssets[chain.toString()]?.map((assetId: string) =>
      StatType.create({
        id: `${assetId}/Count`,
        assetId,
        opType: StatOpTypeEnum.Count,
        claimType: null,
        claimIssuerId: null,
        createdBlockId: blockId,
        updatedBlockId: blockId,
      }).save()
    );

    await Promise.all(newStats);
  }
}
