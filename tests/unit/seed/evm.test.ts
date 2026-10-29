/** EVM account mappings, from `revive.originalAccount`, which 8.0's genesis config can seed */
import { SEED_EVENT_ID } from '../../../src/mappings/consts';
import { seed } from '../../../src/seed/seeder';
import { SEEDERS } from '../../../src/seed/seeders';
import { accountRows } from '../../../src/seed/seeders/identities';
import { snapshotAtParent } from '../../../src/seed/snapshot';
import { fakeChain } from './fakeChain';

const ADDRESS = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const H160 = '0x1e01653f2113f7a9760876d5f3970e8fe9790073';

it('maps each EVM address to its account, checksummed, with the account named', async () => {
  const chain = fakeChain(8_000_020);
  chain.put('revive.originalAccount', [H160], ADDRESS);
  const datetime = new Date('2026-01-01T00:00:00Z');

  await seed(
    snapshotAtParent(chain.block),
    {
      block: chain.block,
      blockId: '0000001000',
      eventId: SEED_EVENT_ID,
      datetime,
      specVersion: 8_000_020,
    },
    { seeders: SEEDERS.filter(({ entity }) => entity === 'EvmAccountMapping'), accountRows }
  );

  const checksummed = '0x1e01653F2113F7A9760876d5F3970e8Fe9790073';
  expect(chain.rows('EvmAccountMapping')).toEqual([
    expect.objectContaining({
      id: checksummed,
      evmAddress: checksummed,
      address: ADDRESS,
      accountId: ADDRESS,
      mapped: true,
      datetime,
      createdBlockId: '0000001000',
      updatedBlockId: '0000001000',
    }),
  ]);
  expect(chain.rows('Account').map(({ id }) => id)).toEqual([ADDRESS]);
});
