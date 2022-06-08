import { Codec } from '@polkadot/types/types';
import { TrustedClaimIssuerTicker } from '../../types';
import { getTextValue, serializeTicker } from '../util';
import { EventIdEnum, HandlerArgs, ModuleIdEnum } from './common';

export async function mapTrustedClaimIssuerTicker({
  blockId,
  eventId,
  moduleId,
  params,
}: HandlerArgs): Promise<void> {
  if (moduleId !== ModuleIdEnum.Compliancemanager) {
    return;
  }

  if (eventId === EventIdEnum.TrustedDefaultClaimIssuerAdded) {
    const ticker = serializeTicker(params[1]);
    const issuer = (params[2] as unknown as { issuer: Codec }).issuer.toString();

    await TrustedClaimIssuerTicker.create({
      id: `${ticker}/${issuer}`,
      ticker,
      issuer,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  }

  if (eventId === EventIdEnum.TrustedDefaultClaimIssuerRemoved) {
    const ticker = serializeTicker(params[1]);
    const issuer = getTextValue(params[2]);
    await TrustedClaimIssuerTicker.remove(`${ticker}/${issuer}`);
  }
}
