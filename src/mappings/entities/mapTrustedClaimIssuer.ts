import { Codec } from '@polkadot/types/types';
import { EventIdEnum, ModuleIdEnum, TrustedClaimIssuer } from '../../types';
import { getTextValue, serializeTicker } from '../util';
import { HandlerArgs } from './common';

export async function mapTrustedClaimIssuer({
  blockId,
  eventId,
  moduleId,
  params,
  eventIdx,
}: HandlerArgs): Promise<void> {
  if (moduleId !== ModuleIdEnum.compliancemanager) {
    return;
  }

  if (eventId === EventIdEnum.TrustedDefaultClaimIssuerAdded) {
    const ticker = serializeTicker(params[1]);
    const issuer = (params[2] as unknown as { issuer: Codec }).issuer.toString();

    await TrustedClaimIssuer.create({
      id: `${ticker}/${issuer}`,
      eventIdx,
      assetId: ticker,
      issuer,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  }

  if (eventId === EventIdEnum.TrustedDefaultClaimIssuerRemoved) {
    const ticker = serializeTicker(params[1]);
    const issuer = getTextValue(params[2]);
    await TrustedClaimIssuer.remove(`${ticker}/${issuer}`);
  }
}
