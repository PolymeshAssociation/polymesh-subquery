import '@polkadot/types-augment';
import '@polymeshassociation/polymesh-types/polkadot/types-lookup';
import '@polymeshassociation/polymesh-types/polkadot/augment-api';
import { ApiPromise, HttpProvider, WsProvider } from '@polkadot/api';
import type { ApiDecoration } from '@polkadot/api/types';
import chainTypes from '../../src/chainTypes';

/** The value after `--name`, or `undefined` */
export const argOf = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

export const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

/**
 * An API on an archive node, over HTTP or WebSocket as the URL says, with the chain types the
 * indexer is built with: without them, no storage key decodes under metadata before v14.
 */
export const connect = (rpc: string): Promise<ApiPromise> =>
  ApiPromise.create({
    provider: rpc.startsWith('http') ? new HttpProvider(rpc) : new WsProvider(rpc),
    noInitWarn: true,
    types: chainTypes.types as never,
    typesBundle: chainTypes.typesBundle as never,
  });

export const atHeight = async (
  api: ApiPromise,
  height: number
): Promise<{ at: ApiDecoration<'promise'>; hash: string; spec: number }> => {
  const hash = (await api.rpc.chain.getBlockHash(height)).toHex();
  const [at, version] = await Promise.all([api.at(hash), api.rpc.state.getRuntimeVersion(hash)]);
  return { at, hash, spec: version.specVersion.toNumber() };
};

/** Events every block has plenty of, left out unless asked for */
const ROUTINE = new Set(['system', 'transactionPayment', 'balances', 'protocolFee']);

/** One line per event in block `height`, each with the call of the extrinsic that emitted it */
export const blockEvents = async (
  api: ApiPromise,
  height: number,
  { all = false } = {}
): Promise<string[]> => {
  const { at, hash, spec } = await atHeight(api, height);
  const [records, block] = await Promise.all([
    at.query.system.events(),
    api.rpc.chain.getBlock(hash),
  ]);

  const lines = [`block ${height}, spec ${spec}`];
  records.forEach(({ phase, event }, index) => {
    if (!all && ROUTINE.has(event.section)) {
      return;
    }
    const extrinsic = phase.isApplyExtrinsic
      ? block.block.extrinsics[phase.asApplyExtrinsic.toNumber()]
      : undefined;
    const origin = extrinsic
      ? `ext${phase.asApplyExtrinsic.toNumber()} ${extrinsic.method.section}.${
          extrinsic.method.method
        }`
      : phase.type;
    const data = JSON.stringify(event.data.toHuman()).slice(0, 700);
    lines.push(`  #${index} ${origin} ${event.section}.${event.method} ${data}`);
  });

  return lines;
};
