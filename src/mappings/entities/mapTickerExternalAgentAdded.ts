import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { TickerExternalAgentAdded } from '../../types';
import { serializeTicker } from '../util';
import { EventIdEnum, ModuleIdEnum } from './common';

export async function mapTickerExternalAgentAdded(
  blockId: string,
  eventId: string,
  moduleId: string,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> {
  if (moduleId === ModuleIdEnum.Externalagents && eventId === EventIdEnum.AgentAdded) {
    const callerDid = params[0].toString();
    const ticker = serializeTicker(params[1]);
    await TickerExternalAgentAdded.create({
      id: `${ticker}/${callerDid}`,
      ticker,
      callerDid,
      blockId,
      eventIdx: event.idx,
      datetime: event.block.timestamp,
    }).save();
  }
  if (moduleId === ModuleIdEnum.Externalagents && eventId === EventIdEnum.AgentRemoved) {
    const agent = params[2].toString();
    const ticker = serializeTicker(params[1]);
    await TickerExternalAgentAdded.remove(`${ticker}/${agent}`);
  }
}
