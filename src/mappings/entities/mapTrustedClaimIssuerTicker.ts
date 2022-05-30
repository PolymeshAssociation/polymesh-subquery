import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { TrustedClaimIssuerTicker } from '../../types';
import { serializeTicker } from '../util';
import { EventIdEnum, ModuleIdEnum } from './common';

export async function mapTrustedClaimIssuerTicker(
  _: number,
  eventId: EventIdEnum,
  moduleId: ModuleIdEnum,
  params: Codec[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  __: SubstrateEvent
): Promise<void> {
  if (moduleId !== ModuleIdEnum.Compliancemanager) {
    return;
  }
  if (eventId === EventIdEnum.TrustedDefaultClaimIssuerAdded) {
    const rawTicker = params[1];
    const ticker = serializeTicker(rawTicker);
    const issuer = (params[2] as unknown as { issuer: Codec }).issuer.toString();
    await TrustedClaimIssuerTicker.create({
      id: `${ticker}/${issuer}`,
      ticker,
      issuer,
    }).save();
  }
  if (eventId === EventIdEnum.TrustedDefaultClaimIssuerRemoved) {
    const rawTicker = params[1];
    const ticker = serializeTicker(rawTicker);
    const issuer = params[2].toString();
    await TrustedClaimIssuerTicker.remove(`${ticker}/${issuer}`);
  }
}
