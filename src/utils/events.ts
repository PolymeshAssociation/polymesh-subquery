/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { HandlerArgs, toEnum } from '../mappings/entities/common';
import { CallIdEnum, EventIdEnum, ModuleIdEnum } from '../types';
import { JSONStringifyExceptStringAndNull, camelToSnakeCase, padId } from './common';

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
  moduleIdText: string;
  eventId: EventIdEnum;
  eventIdText: string;
  callId?: CallIdEnum;
  callIdText?: string;
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
    moduleIdText,
    eventIdText,
    eventIdx,
    block: { timestamp: datetime },
    extrinsic,
    blockEventId,
    extrinsicId,
  } = args;

  let callId: CallIdEnum | undefined;
  let callIdText: string | undefined;
  if (extrinsic) {
    callIdText = camelToSnakeCase(extrinsic.extrinsic.method.method);
    callId = toEnum(CallIdEnum, callIdText, CallIdEnum.unsupported);
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
    createdBlockId: padId(blockId),
    updatedBlockId: padId(blockId),
    blockEventId,
  };
};

export const extractTransferTo = (args: any[]) =>
  JSONStringifyExceptStringAndNull(args[3]?.value?.did);
