/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { HandlerArgs, toEnum } from '../mappings/entities/common';
import { CallIdEnum, EventIdEnum, ModuleIdEnum } from '../types';
import { blockTime, camelToSnakeCase, padId } from './common';
import { resolveEthTransact } from './ethExtrinsic';

export type EventParams = {
  id: string;
  moduleId: ModuleIdEnum;
  moduleIdText: string;
  eventId: EventIdEnum;
  eventIdText: string;
  callId?: CallIdEnum;
  callIdText?: string;
  extrinsicId?: string;
  datetime: Date;
  eventIdx: number;
  blockId: string;
  createdEventId: string;
  updatedEventId: string;
  blockEventId: string;
};

export const getEventParams = (args: HandlerArgs): EventParams => {
  const {
    blockId,
    eventId,
    moduleId,
    moduleIdText,
    eventIdText,
    eventIdx,
    block,
    extrinsic,
    blockEventId,
    extrinsicId,
  } = args;
  const datetime = blockTime(block);

  let callId: CallIdEnum | undefined;
  let callIdText: string | undefined;
  if (extrinsic) {
    /**
     * An `eth_transact` extrinsic is a wrapper, so the call it was transformed into is used
     * instead. It is memoized per extrinsic, so resolving it once per event is cheap
     */
    const resolved = resolveEthTransact(extrinsic);

    callIdText = resolved?.callId ?? camelToSnakeCase(extrinsic.extrinsic.method.method);
    callId = toEnum(CallIdEnum, callIdText, CallIdEnum.unknown, {
      enumName: 'CallIdEnum',
      block: args.block,
      eventIdx,
    });
  }

  return {
    id: blockEventId,
    moduleId,
    eventId,
    moduleIdText,
    eventIdText,
    extrinsicId,
    callId,
    callIdText,
    datetime,
    eventIdx,
    blockId: padId(blockId),
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
    blockEventId,
  };
};
