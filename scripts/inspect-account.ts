/**
 * Prints what the chain holds for one or more accounts at a block: `system.account`, the locks,
 * the holds (from v8, summed from the raw bytes so a list today's metadata can't decode still
 * reads), and, for a stash, its controller, ledger and payee. The first thing to look at once a
 * check names an account.
 *
 *   yarn ts-node scripts/inspect-account.ts --rpc <archive node> --block N <account>…
 */
import { Option, Raw } from '@polkadot/types';
import { compactFromU8a, hexToString, u8aToBn } from '@polkadot/util';
import { argOf, atHeight, connect } from './lib/chain';

const HOLD_BYTES = 18;

/** `balances.holds` from the raw bytes: each entry's pallet name and amount */
const holdsOf = (raw: Uint8Array, pallets: Map<number, string>): string[] => {
  const [offset, count] = compactFromU8a(raw);
  return Array.from({ length: count.toNumber() }, (_, index) => {
    const start = offset + index * HOLD_BYTES;
    const amount = u8aToBn(raw.subarray(start + 2, start + HOLD_BYTES)).toString();
    return `${pallets.get(raw[start]) ?? `pallet ${raw[start]}`}: ${amount}`;
  });
};

const main = async (): Promise<void> => {
  const rpc = argOf('rpc');
  const block = Number(argOf('block'));
  const accounts = process.argv
    .slice(2)
    .filter((arg, i, all) => !arg.startsWith('--') && !all[i - 1]?.startsWith('--'));
  if (!rpc || !Number.isInteger(block) || accounts.length === 0) {
    console.error('usage: inspect-account.ts --rpc <archive node> --block N <account>…');
    process.exit(2);
  }

  const api = await connect(rpc);
  const { at, hash, spec } = await atHeight(api, block);
  const pallets = new Map(
    at.registry.metadata.pallets.map(pallet => [pallet.index.toNumber(), pallet.name.toString()])
  );
  const holdsItem = (at.query.balances as unknown as Record<string, unknown>).holds as
    | { key: (who: string) => string }
    | undefined;

  console.log(`block ${block}, spec ${spec}`);
  for (const account of accounts) {
    const [info, locks, controller, payee] = await Promise.all([
      at.query.system.account(account),
      at.query.balances.locks(account),
      at.query.staking.bonded(account),
      at.query.staking.payee(account),
    ]);
    console.log(`\n${account}`);
    console.log(`  account ${JSON.stringify(info.data.toJSON())}`);
    console.log(
      `  locks ${JSON.stringify(
        locks.map(lock => ({ id: hexToString(lock.id.toHex()), amount: lock.amount.toString() }))
      )}`
    );

    if (holdsItem) {
      const raw = (await api.rpc.state.getStorage(
        holdsItem.key(account),
        hash
      )) as unknown as Option<Raw>;
      console.log(
        `  holds ${JSON.stringify(raw.isSome ? holdsOf(raw.unwrap().toU8a(true), pallets) : [])}`
      );
    }

    if (controller.isSome) {
      const ledger = await at.query.staking.ledger(controller.unwrap());
      console.log(`  controller ${controller.unwrap().toString()}`);
      console.log(`  ledger ${JSON.stringify(ledger.toJSON())}`);
      console.log(`  payee ${JSON.stringify(payee.toJSON())}`);
    }
  }

  await api.disconnect();
};

main().catch(e => {
  console.error(e);
  process.exit(2);
});
