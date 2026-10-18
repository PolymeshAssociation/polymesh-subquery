import { ethereumEncode } from '@polkadot/util-crypto';
import { EvmAccountMapping } from '../../types';
import { Seeder } from '../seeder';

/**
 * Each EVM address `revive.originalAccount` maps to an account, checksummed so it joins against
 * `Account.evmAddress`. 8.0's genesis config can seed the map directly, and mapping or unmapping
 * emits no event, so the seed and the extrinsic handler are its only sources.
 */
export const evmAccountMappingSeeder: Seeder<EvmAccountMapping> = {
  entity: 'EvmAccountMapping',
  reads: ['revive.originalAccount'],
  accounts: ['accountId'],
  async *rows(snap, ctx) {
    for await (const page of snap.pages('revive.originalAccount')) {
      yield page.flatMap(({ args, value }) => {
        if (!value) {
          return [];
        }
        const id = ethereumEncode(args[0].toString());
        const address = value.toString();
        return [
          EvmAccountMapping.create({
            id,
            evmAddress: id,
            address,
            accountId: address,
            mapped: true,
            datetime: ctx.datetime,
            createdBlockId: ctx.blockId,
            updatedBlockId: ctx.blockId,
          }),
        ];
      });
    }
  },
};
