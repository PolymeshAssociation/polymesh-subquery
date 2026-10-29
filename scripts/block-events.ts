/**
 * Prints one block's events, each with the call of the extrinsic that emitted it. The `system`,
 * `transactionPayment`, `balances` and `protocolFee` events every block has are left out unless
 * `--all` is given.
 *
 *   yarn ts-node scripts/block-events.ts --rpc <archive node> --block N [--all]
 */
import { argOf, blockEvents, connect, hasFlag } from './lib/chain';

const main = async (): Promise<void> => {
  const rpc = argOf('rpc');
  const block = Number(argOf('block'));
  if (!rpc || !Number.isInteger(block)) {
    console.error('usage: block-events.ts --rpc <archive node> --block N [--all]');
    process.exit(2);
  }

  const api = await connect(rpc);
  (await blockEvents(api, block, { all: hasFlag('all') })).forEach(line => console.log(line));
  await api.disconnect();
};

main().catch(e => {
  console.error(e);
  process.exit(2);
});
