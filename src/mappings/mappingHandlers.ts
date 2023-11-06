import { EventRecord } from '@polkadot/types/interfaces';
import { SubstrateBlock, SubstrateExtrinsic } from '@subql/types';
import { CallIdEnum, Event, EventIdEnum, Extrinsic } from '../types';
import { ModuleIdEnum } from './../types/enums';
import { mapBlock } from './entities/mapBlock';
import { handleEvent } from './entities/mapEvent';
import { createExtrinsic, wrapExtrinsics } from './entities/mapExtrinsic';
import { camelToSnakeCase, logError } from './util';

export async function handleBlock(substrateBlock: SubstrateBlock): Promise<void> {
  const blockId = substrateBlock.block.header.number.toNumber();
  try {
    const block = await mapBlock(substrateBlock);

    await block.save();

    const wrappedExtrinsics = wrapExtrinsics(substrateBlock);

    const { events, countExtrinsicsSuccess } = await getEvents(substrateBlock, wrappedExtrinsics);

    const { extrinsics, countExtrinsicsSigned, countExtrinsicsUnsigned } =
      getExtrinsics(wrappedExtrinsics);

    Object.assign(block, {
      countExtrinsicsSigned,
      countExtrinsicsSuccess,
      countExtrinsicsUnsigned,
    });

    await Promise.all([
      store.bulkCreate('Extrinsic', extrinsics),
      store.bulkCreate('Event', events),
      block.save(),
    ]);
    logger.debug(`Processed block - ${block.id} for all events and extrinsics`);
  } catch (error) {
    logError(`Received an error while processing block ${blockId}: ${error.toString()}`);
    throw error;
  }
}

async function getEvents(
  substrateBlock: SubstrateBlock,
  wrappedExtrinsics
): Promise<{
  events: Event[];
  countExtrinsicsSuccess: number;
}> {
  let countExtrinsicsSuccess = 0;
  const events: Event[] = [];
  for (const [i, event] of substrateBlock.events.entries()) {
    if (
      event.event.section.toLowerCase() === ModuleIdEnum.system &&
      event.event.method === EventIdEnum.ExtrinsicSuccess
    ) {
      countExtrinsicsSuccess++;
    } else {
      let extrinsic: SubstrateExtrinsic;
      if (event.phase.isApplyExtrinsic) {
        extrinsic = wrappedExtrinsics.find(({ idx }) => event.phase.asApplyExtrinsic.eqn(idx));
      }
      const dbEvent = await handleEvent(event as EventRecord, i, substrateBlock, extrinsic);
      events.push(dbEvent);
    }
  }
  return {
    events,
    countExtrinsicsSuccess,
  };
}

function getExtrinsics(wrappedExtrinsics): {
  extrinsics: Extrinsic[];
  countExtrinsicsSigned: number;
  countExtrinsicsUnsigned: number;
} {
  let countExtrinsicsUnsigned = 0;
  let countExtrinsicsSigned = 0;
  const extrinsics: Extrinsic[] = [];
  for (const ext of wrappedExtrinsics) {
    if (ext.extrinsic.isSigned) {
      countExtrinsicsSigned++;
    } else {
      countExtrinsicsUnsigned++;
    }
    if (
      ext.extrinsic.method.section.toLowerCase() !== ModuleIdEnum.timestamp ||
      camelToSnakeCase(ext.extrinsic.method.method) !== CallIdEnum.set
    ) {
      // skip all timestamp.set extrinsics
      extrinsics.push(createExtrinsic(ext));
    }
  }
  return {
    extrinsics,
    countExtrinsicsSigned,
    countExtrinsicsUnsigned,
  };
}
