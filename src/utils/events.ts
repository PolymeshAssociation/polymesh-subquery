/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { JSONStringifyExceptStringAndNull, camelToSnakeCase, padId } from './common';
import { HandlerArgs } from '../mappings/entities/common';
import { CallIdEnum, ModuleIdEnum, EventIdEnum } from 'src/types';

export const extractEventArg = (arg: any, exists: boolean) => {
  if (arg !== undefined && arg !== null && arg?.value != null) {
    return JSONStringifyExceptStringAndNull(arg?.value);
  } else if (exists) {
    return 'null';
  } else {
    return null;
  }
};

export const extractEventArgs = (args: any[]) => {
  const [arg0, arg1, arg2, arg3] = args;
  return {
    eventArg_0: extractEventArg(arg0, args.length > 0),
    eventArg_1: extractEventArg(arg1, args.length > 1),
    eventArg_2: extractEventArg(arg2, args.length > 2),
    eventArg_3: extractEventArg(arg3, args.length > 3),
  };
};

type EventParams = {
  id: string;
  moduleId: ModuleIdEnum;
  eventId: EventIdEnum;
  callId?: CallIdEnum;
  extrinsicId?: string;
  datetime: Date;
  eventIdx: number;
  createdBlockId: string;
  updatedBlockId: string;
  blockEventId: string;
};

export const getEventParams = (args: HandlerArgs): EventParams => {
  const {
    blockId,
    eventId,
    moduleId,
    eventIdx,
    block: { timestamp: datetime },
    extrinsic,
    blockEventId,
    extrinsicId,
  } = args;

  return {
    id: blockEventId,
    moduleId,
    eventId,
    extrinsicId,
    callId: extrinsic
      ? (camelToSnakeCase(extrinsic.extrinsic.method.method) as CallIdEnum)
      : undefined,
    datetime,
    eventIdx,
    createdBlockId: padId(blockId),
    updatedBlockId: padId(blockId),
    blockEventId,
  };
};

export const extractTransferTo = (args: any[]) =>
  JSONStringifyExceptStringAndNull(args[3]?.value?.did);
