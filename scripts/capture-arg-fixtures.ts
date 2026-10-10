/**
 * Captures real events and calls, with their metadata, for the canonical-encoding contract test:
 * from the first block at or after each given height with at least `--min` distinct non-system
 * events, one of them from a `--want` pallet, the encoded form of every event and of the block's
 * calls. The wanted pallets default to Polymesh's own, whose events carry identities and assets.
 *
 *   yarn ts-node scripts/capture-arg-fixtures.ts --rpc <archive node> [--min 4] [--want a,b] <height> …
 *
 * The output is the contract: re-run it only to add an era, and review every changed value.
 */
import '@polkadot/types-augment';
import '@polymeshassociation/polymesh-types/polkadot/types-lookup';
import '@polymeshassociation/polymesh-types/polkadot/augment-api';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { GenericCall, GenericEvent } from '@polkadot/types';
import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { stringCamelCase } from '@polkadot/util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import chainTypes from '../src/chainTypes';
import { argumentNames, metadataTypeNames } from '../src/decode';
import { encodeArgs } from '../src/mappings/args/encode';

const DIR = join(__dirname, '..', 'tests', 'fixtures', 'args');

const argOf = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

/** Keyed as the indexer keys them: by the metadata's names, else the registered shape's. */
const eventArgs = (event: GenericEvent, specVersion: number) => {
  const substrate = { event, block: { specVersion } } as unknown as SubstrateEvent;
  return encodeArgs(
    event.data as unknown as Codec[],
    argumentNames(substrate),
    metadataTypeNames(substrate)
  );
};

const callArgs = (call: GenericCall) =>
  encodeArgs(
    call.args,
    call.meta.args.map(({ name }) => stringCamelCase(name.toString())),
    call.meta.args.map(({ type }) => type.toString())
  ).args;

const main = async () => {
  const rpc = argOf('rpc');
  const min = Number(argOf('min', '4'));
  const want = new Set(
    (argOf('want', 'asset,identity,settlement,portfolio,complianceManager,sto,nft') ?? '').split(
      ','
    )
  );
  const heights = process.argv
    .slice(2)
    .filter((a, i, all) => /^\d+$/.test(a) && !all[i - 1]?.startsWith('--'))
    .map(Number);
  if (!rpc || heights.length === 0) {
    console.error(
      'usage: capture-arg-fixtures.ts --rpc <archive node> [--min 4] [--want a,b] <height> …'
    );
    process.exit(1);
  }

  const api = await ApiPromise.create({
    provider: new WsProvider(rpc),
    noInitWarn: true,
    types: chainTypes.types as never,
    typesBundle: chainTypes.typesBundle as never,
  });
  // the indexer's spec-version normalisation reads the global SubQuery injects
  (globalThis as unknown as { api: ApiPromise }).api = api;
  mkdirSync(join(DIR, 'metadata'), { recursive: true });

  for (const start of heights) {
    for (let n = start; ; n += 1) {
      const hash = await api.rpc.chain.getBlockHash(n);
      const at = await api.at(hash);
      const records = (await at.query.system.events()) as unknown as {
        event: GenericEvent;
        toHex(): string;
      }[];
      const interesting = records.filter(({ event }) => event.section !== 'system');
      if (
        new Set(interesting.map(({ event }) => `${event.section}.${event.method}`)).size < min ||
        !interesting.some(({ event }) => want.has(event.section))
      ) {
        continue;
      }

      const version = await api.rpc.state.getRuntimeVersion(hash);
      const specVersion = version.specVersion.toNumber();
      const metadata = await api.rpc.state.getMetadata(hash);
      const block = await api.rpc.chain.getBlock(hash);

      writeFileSync(join(DIR, 'metadata', `${specVersion}.bin.gz`), gzipSync(metadata.toU8a()));
      writeFileSync(
        join(DIR, `${specVersion}.json`),
        `${JSON.stringify(
          {
            specVersion,
            specName: version.specName.toString(),
            block: n,
            events: records.map(record => {
              const { args, refs } = eventArgs(record.event, specVersion);
              return {
                section: record.event.section,
                method: record.event.method,
                recordHex: record.toHex(),
                args,
                refs,
              };
            }),
            calls: block.block.extrinsics.map(extrinsic => ({
              section: extrinsic.method.section,
              method: extrinsic.method.method,
              callHex: extrinsic.method.toHex(),
              args: callArgs(extrinsic.method as unknown as GenericCall),
            })),
          },
          null,
          2
        )}\n`
      );
      console.log(`spec ${specVersion}: block ${n}, ${records.length} events`);
      break;
    }
  }

  await api.disconnect();
};

main().catch(e => {
  console.error(e);
  process.exit(1);
});
