/**
 * Staking: the validators, and the active era with its elected set.
 */
import { SEED_EVENT_ID } from '../../../src/mappings/consts';
import { seed } from '../../../src/seed/seeder';
import { SEEDERS } from '../../../src/seed/seeders';
import { accountRows } from '../../../src/seed/seeders/identities';
import { snapshotAtParent } from '../../../src/seed/snapshot';
import { fakeChain, FakeChain, genesisChain } from './fakeChain';
import { byId, golden } from './goldens';

const STASH = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const DID = `0x${'01'.repeat(32)}`;
const ENTITIES = ['Era', 'ValidatorEra', 'Account', 'Identity'];

const seedStaking = (chain: FakeChain, blockId = '0000001000') =>
  seed(
    snapshotAtParent(chain.block),
    {
      block: chain.block,
      blockId,
      eventId: SEED_EVENT_ID,
      datetime: new Date(0),
      specVersion: chain.specVersion,
    },
    { seeders: SEEDERS.filter(({ entity }) => ENTITIES.includes(entity)), accountRows }
  );

describe.each(['testnet', 'mainnet'] as const)('the %s genesis', chainName => {
  let chain: FakeChain;

  beforeAll(async () => {
    chain = genesisChain(chainName);
    await seedStaking(chain, '0000000000');
  });

  it.each(['Era', 'ValidatorEra'])('seeds the %s rows the genesis election wrote', entity => {
    expect(byId(chain.rows(entity))).toEqual(byId(golden(chainName)[entity]));
  });
});

describe('from 8.0', () => {
  let chain: FakeChain;
  const rows = (entity: string) => byId(chain.rows(entity));

  beforeAll(async () => {
    chain = fakeChain(8_001_020);
    chain.put('identity.keyRecords', [STASH], { PrimaryKey: DID });
    chain.put('staking.activeEra', [], { index: 12, start: 1_700_000_000_000 });
    chain.put('staking.erasStakersOverview', [12, STASH], {
      total: 1_100,
      own: 800,
      nominatorCount: 1,
      pageCount: 1,
    });
    chain.put('staking.erasValidatorPrefs', [12, STASH], {
      commission: 50_000_000,
      blocked: false,
    });
    await seedStaking(chain);
  });

  it('seeds the active era with its elected set', () => {
    expect(rows('Era')['0000000012']).toMatchObject({ eraIndex: 12, validatorCount: 1 });
    expect(rows('ValidatorEra')[`0000000012/${STASH}`]).toMatchObject({
      ownStake: '800',
      totalStake: '1100',
      nominatorCount: 1,
      commission: '50000000',
      identityId: DID,
    });
  });
});

// testnet 24,730,587, the first block of 8.0: its active era was elected under 7.4
describe('the first era of 8.0', () => {
  it('reads an era elected before 8.0 from erasStakers, which 8.0 still holds', async () => {
    const chain = fakeChain(8_000_020);
    chain.put('identity.keyRecords', [STASH], { PrimaryKey: DID });
    chain.put('staking.activeEra', [], { index: 6901, start: 1_700_000_000_000 });
    chain.put('staking.erasStakers', [6901, STASH], { total: 900, own: 900, others: [] });
    await seedStaking(chain);

    expect(byId(chain.rows('ValidatorEra'))[`0000006901/${STASH}`]).toMatchObject({
      totalStake: '900',
    });
  });
});
