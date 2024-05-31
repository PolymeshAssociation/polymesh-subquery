import genesisHandler from './migrations/genesisHandler';
import { logError } from './util';

export async function handleGenesis(): Promise<void> {
  await genesisHandler().catch(e => logError(e));
}
