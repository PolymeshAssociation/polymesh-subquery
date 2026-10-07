/**
 * Checks the pre-v5.4 fee reconstruction against the chain: for each signed extrinsic in the given
 * blocks, prints the fee `exactFee` computes beside the treasury's cut of what was taken, and
 * the call, the signer, the payer the resolver picks, and how both accounts' free balances moved
 * across the block. The payer's balance should fall by the fee; a signer who isn't the payer
 * should be untouched, unless something else in the block moved it.
 *
 *   yarn ts-node scripts/verify-fee-payer.ts --rpc wss://dev-fsn001.nsite.dev/testnet/ 466634 469641 801695 1056229 1056451
 */
import '@polkadot/types-augment';
import '@polymeshassociation/polymesh-types/polkadot/types-lookup';
import '@polymeshassociation/polymesh-types/polkadot/augment-api';
import { ApiPromise, WsProvider } from '@polkadot/api';
import chainTypes from '../src/chainTypes';
import { resolveFeePayer } from '../src/mappings/entities/identities/feePayer';
import { exactFee } from '../src/mappings/entities/identities/preV54Fees';

type EventRecords = {
  phase: { isApplyExtrinsic: boolean; asApplyExtrinsic: { toNumber(): number } };
  event: { section: string; method: string; data: { toString(): string }[] };
}[];

/** The sandbox's globals: nothing is written, and an anomaly is only printed. */
const installSandboxGlobals = (): void => {
  (globalThis as any).logger = console;
  (globalThis as any).store = {
    get: () => Promise.resolve(undefined),
    getByField: () => Promise.resolve([]),
    getByFields: () => Promise.resolve([]),
    set: (entity: string, _id: string, data: unknown) => {
      console.log(`  [${entity}]`, data);
      return Promise.resolve();
    },
  };
};

/** The fee as the indexer computes it, against the treasury's 80% cut of what was taken. */
const feeCheck = (events: EventRecords, idx: number, extrinsic: unknown): string => {
  const own = events
    .map((record, eventIdx) => ({ phase: record.phase, event: record.event, idx: eventIdx }))
    .filter(r => r.phase.isApplyExtrinsic && r.phase.asApplyExtrinsic.toNumber() === idx);
  const closing = own.find(
    r =>
      r.event.section === 'system' &&
      (r.event.method === 'ExtrinsicSuccess' || r.event.method === 'ExtrinsicFailed')
  );

  if (!closing) {
    return 'fee=?';
  }

  const fee = exactFee({ extrinsic } as any, closing as any);
  const cutRecord = own[own.indexOf(closing) - 1];

  if (
    cutRecord?.event.section !== 'treasury' ||
    cutRecord.event.method !== 'TreasuryReimbursement'
  ) {
    return `fee=${fee} (no cut: nothing charged)`;
  }

  const cut = BigInt(cutRecord.event.data[1].toString());

  return `fee=${fee} cut=${cut} ${(fee * BigInt(8)) / BigInt(10) === cut ? 'ok' : 'MISMATCH'}`;
};

/** Prints every signed extrinsic of block `height`: its fee, its payer and both balances' moves. */
const reportBlock = async (api: ApiPromise, height: number): Promise<void> => {
  const hash = await api.rpc.chain.getBlockHash(height);
  const signed = await api.rpc.chain.getBlock(hash);
  const parentHash = signed.block.header.parentHash;
  const version = await api.rpc.state.getRuntimeVersion(parentHash);
  const apiAt = await api.at(hash);

  (globalThis as any).api = Object.assign(Object.create(apiAt), {
    query: apiAt.query,
    registry: apiAt.registry,
    rpc: api.rpc,
  });

  const free = async (at: typeof hash, who: string) =>
    ((await (await api.at(at)).query.system.account(who)) as any).data.free.toBigInt() as bigint;
  const delta = async (who: string) => (await free(hash, who)) - (await free(parentHash, who));

  console.log(`\n=== block ${height} (spec ${version.specVersion.toNumber()})`);

  const events = (await apiAt.query.system.events()) as unknown as EventRecords;
  const timestamp = new Date(Number((await apiAt.query.timestamp.now()).toString()));

  const describe = async (
    extrinsic: (typeof signed.block.extrinsics)[number],
    idx: number
  ): Promise<string> => {
    const signer = extrinsic.signer.toString();
    const payer = await resolveFeePayer({
      idx,
      extrinsic,
      block: { block: signed.block, specVersion: version.specVersion.toNumber(), timestamp },
    } as any);
    const [signerMove, payerDelta] = await Promise.all([
      delta(signer),
      payer === signer ? undefined : delta(payer),
    ]);
    const payerMove = payerDelta === undefined ? 'payer=signer' : `payer=${payer} Δ${payerDelta}`;

    return `  x${idx} ${extrinsic.method.section}.${
      extrinsic.method.method
    } signer=${signer} Δ${signerMove}  ${payerMove}  ${feeCheck(events, idx, extrinsic)}`;
  };

  const lines = await Promise.all(
    [...signed.block.extrinsics.entries()]
      .filter(([, extrinsic]) => extrinsic.isSigned)
      .map(([idx, extrinsic]) => describe(extrinsic, idx))
  );
  lines.forEach(line => console.log(line));
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const rpcAt = argv.indexOf('--rpc');
  const rpc = rpcAt >= 0 ? argv[rpcAt + 1] : 'wss://dev-fsn001.nsite.dev/testnet/';
  const blocks = argv.filter((arg, i) => /^\d+$/.test(arg) && i !== rpcAt + 1).map(Number);

  // The chain types the indexer is built with: blocks before metadata v14 name Polymesh types
  // (`Signatory`, `IdentityId`, …) that only these define.
  const api = await ApiPromise.create({
    provider: new WsProvider(rpc),
    noInitWarn: true,
    types: chainTypes.types as never,
    typesBundle: chainTypes.typesBundle as never,
  });

  installSandboxGlobals();

  // One block at a time: each installs its own `api` global for the resolver to read.
  await blocks.reduce(
    (previous, height) => previous.then(() => reportBlock(api, height)),
    Promise.resolve()
  );

  await api.disconnect();
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
