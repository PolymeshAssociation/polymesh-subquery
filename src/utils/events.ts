/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { SubstrateExtrinsic } from '@subql/types';
import { JSONStringifyExceptStringAndNull, camelToSnakeCase, padId } from './common';
import { HandlerArgs } from '../mappings/entities/common';
import { CallIdEnum, ModuleIdEnum, EventIdEnum } from 'src/types';
import { PolyxTransactionProps } from '../types/models/PolyxTransaction';

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

const getExtrinsicDetails = (
  blockId: string,
  extrinsic?: SubstrateExtrinsic
): Pick<PolyxTransactionProps, 'callId' | 'extrinsicId'> => {
  let callId: CallIdEnum;
  let extrinsicId: string;
  if (extrinsic) {
    callId = camelToSnakeCase(extrinsic.extrinsic.method.method) as CallIdEnum;
    extrinsicId = `${blockId}/${extrinsic.idx}`;
  }
  return { callId, extrinsicId };
};

type EventParams = {
  id: string;
  moduleId: ModuleIdEnum;
  eventId: EventIdEnum;
  callId?: CallIdEnum;
  extrinsicId?: string;
  datetime: Date;
  eventIdx;
  createdBlockId: string;
  updatedBlockId: string;
};

export const getEventParams = (args: HandlerArgs): EventParams => {
  const {
    blockId,
    eventId,
    moduleId,
    eventIdx,
    block: { timestamp: datetime },
    extrinsic,
  } = args;

  return {
    id: `${blockId}/${eventIdx}`,
    moduleId,
    eventId,
    ...getExtrinsicDetails(blockId, extrinsic),
    datetime,
    eventIdx,
    createdBlockId: padId(blockId),
    updatedBlockId: padId(blockId),
  };
};

export const extractTransferTo = (args: any[]) =>
  JSONStringifyExceptStringAndNull(args[3]?.value?.did);
