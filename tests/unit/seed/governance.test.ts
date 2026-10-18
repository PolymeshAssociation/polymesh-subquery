/**
 * Multisigs with their signers, admins, proposals and votes; PIPs and their votes; and subsidies.
 */
import { SEED_EVENT_ID } from '../../../src/mappings/consts';
import { seed } from '../../../src/seed/seeder';
import { SEEDERS } from '../../../src/seed/seeders';
import { accountRows } from '../../../src/seed/seeders/identities';
import { snapshotAtParent } from '../../../src/seed/snapshot';
import { fakeChain, FakeChain, genesisChain } from './fakeChain';
import { byId, golden } from './goldens';

const MS = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const SIGNER = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const PROPOSER = '5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y';
const PAYER = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';
const OTHER_USER = '5HGjWAeFDfFCWPsjFQdVV2Msvz2XtMktvgocEZcCj68kUMaw';
const ADMIN = `0x${'01'.repeat(32)}`;
const OWNER = `0x${'02'.repeat(32)}`;

const ENTITIES = [
  'MultiSig',
  'MultiSigSigner',
  'MultiSigAdmin',
  'MultiSigProposal',
  'MultiSigProposalVote',
  'Proposal',
  'ProposalVote',
  'Subsidy',
];

const seedGovernance = (chain: FakeChain, blockId = '0000001000') =>
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
  it.each(['MultiSig', 'MultiSigSigner', 'MultiSigAdmin'])(
    'seeds the %s rows the genesis handler wrote',
    async entity => {
      const chain = genesisChain(chainName);
      await seedGovernance(chain, '0000000000');

      expect(byId(chain.rows(entity))).toEqual(byId(golden(chainName)[entity]));
    }
  );
});

describe('from 8.0', () => {
  let chain: FakeChain;
  const rows = (entity: string) => byId(chain.rows(entity));

  beforeAll(async () => {
    chain = fakeChain(8_001_020);
    const remark = chain.call('system', 'remark', '0x01');
    chain.put('identity.keyRecords', [PROPOSER], { PrimaryKey: OWNER });

    chain.put('multiSig.multiSigSignsRequired', [MS], 1);
    chain.put('multiSig.multiSigSigners', [MS, SIGNER], true);
    chain.put('multiSig.adminDid', [MS], ADMIN);
    chain.put('multiSig.proposals', [MS, 2], remark);
    chain.put('multiSig.proposalStates', [MS, 2], { Active: { until: 1_900_000_000_000 } });
    chain.put('multiSig.proposalVoteCounts', [MS, 2], { approvals: 1, rejections: 0 });
    chain.put('multiSig.votes', [[MS, 2], SIGNER], true);
    // a vote on a proposal the chain pruned, which it leaves behind
    chain.put('multiSig.votes', [[MS, 1], SIGNER], true);

    chain.put('pips.proposals', [5], {
      id: 5,
      proposal: remark,
      proposer: { Community: PROPOSER },
    });
    chain.put('pips.deposits', [5, PROPOSER], { owner: PROPOSER, amount: 2_000 });
    chain.put('pips.proposalMetadata', [5], {
      id: 5,
      url: 'https://pip',
      description: 'A PIP',
      createdAt: 10,
      transactionVersion: 1,
      expiry: { Some: 900 },
    });
    chain.put('pips.proposalStates', [5], 'Pending');
    chain.put('pips.proposalResult', [5], {
      ayesCount: 2,
      ayesStake: 3_000,
      naysCount: 0,
      naysStake: 0,
    });
    chain.put('pips.proposalVotes', [5, PROPOSER], [true, 2_000]);
    chain.put('pips.proposals', [6], {
      id: 6,
      proposal: remark,
      proposer: { Committee: { Technical: null } },
    });
    chain.put('pips.proposalStates', [6], 'Scheduled');

    chain.put('relayer.subsidies', [SIGNER], { payingKey: PAYER, remaining: 500 });
    chain.put('relayer.pendingSubsidies', [PROPOSER, PAYER], 100);
    // an offer from before 8.0, still an authorization
    chain.put('identity.authorizations', [{ Account: MS }, 9], {
      authorizationData: { OldAddRelayerPayingKey: [MS, PAYER, 70] },
      authorizedBy: ADMIN,
      expiry: null,
      authId: 9,
      count: 50,
    });

    // more offers from before 8.0: as the handlers keep a pair, the latest of two pending is the
    // one shown, whichever the chain stores first, and an 8.x offer wins over an older one
    const payingKeyOffer = (user: string, authId: number, limit: number) =>
      chain.put('identity.authorizations', [{ Account: user }, authId], {
        authorizationData: { OldAddRelayerPayingKey: [user, PAYER, limit] },
        authorizedBy: ADMIN,
        expiry: null,
        authId,
        count: 50,
      });
    payingKeyOffer(MS, 3, 30);
    payingKeyOffer(OTHER_USER, 21, 210);
    payingKeyOffer(OTHER_USER, 4, 40);
    payingKeyOffer(PROPOSER, 14, 999);

    // an offer of a seat on an account that is no multisig, which can't be accepted
    chain.put('identity.authorizations', [{ Account: OTHER_USER }, 13], {
      authorizationData: { AddMultiSigSigner: PAYER },
      authorizedBy: ADMIN,
      expiry: null,
      authId: 13,
      count: 50,
    });

    // an offer to an identity from before 7.0, which 7.0's account-only signers left unacceptable
    chain.put('identity.authorizations', [{ Identity: OWNER }, 12], {
      authorizationData: { AddMultiSigSigner: MS },
      authorizedBy: ADMIN,
      expiry: null,
      authId: 12,
      count: 50,
    });

    // a signer offered and not yet accepted, and an offer to a signer already accepted
    chain.put('identity.authorizations', [{ Account: PROPOSER }, 10], {
      authorizationData: { AddMultiSigSigner: MS },
      authorizedBy: ADMIN,
      expiry: null,
      authId: 10,
      count: 50,
    });
    chain.put('identity.authorizations', [{ Account: SIGNER }, 11], {
      authorizationData: { AddMultiSigSigner: MS },
      authorizedBy: ADMIN,
      expiry: null,
      authId: 11,
      count: 50,
    });

    await seedGovernance(chain);
  });

  it('seeds a signer offered and not yet accepted as authorized, as the offer recorded it', () => {
    expect(rows('MultiSigSigner')[`${MS}/Account/${PROPOSER}`]).toMatchObject({
      multisigId: MS,
      signerType: 'Account',
      signerValue: PROPOSER,
      signerAccountId: PROPOSER,
      status: 'Authorized',
    });
    expect(rows('MultiSigSigner')[`${MS}/Account/${SIGNER}`].status).toBe('Approved');
  });

  it('seeds each multisig with its signers and admin', () => {
    expect(rows('MultiSig')[MS]).toMatchObject({ accountId: MS, signaturesRequired: 1 });
    expect(rows('MultiSigSigner')[`${MS}/Account/${SIGNER}`]).toMatchObject({
      signerType: 'Account',
      signerAccountId: SIGNER,
      status: 'Approved',
    });
    expect(rows('MultiSigAdmin')[`${MS}/${ADMIN}`]).toMatchObject({
      adminId: ADMIN,
      status: 'Authorized',
    });
  });

  it('seeds each pending multisig proposal with its call, expiry and counts', () => {
    expect(rows('MultiSigProposal')[`${MS}/2`]).toMatchObject({
      status: 'Active',
      approvalCount: 1,
      params: {
        isBatch: false,
        expiry: '1900000000000',
        proposals: [{ module: 'system', call: 'remark' }],
      },
    });
  });

  it('seeds a vote only on a proposal the chain still holds', () => {
    expect(Object.keys(rows('MultiSigProposalVote'))).toEqual([`${MS}/2/${SIGNER}`]);
  });

  it("seeds each PIP, a community one owned by its proposer key's identity", () => {
    expect(rows('Proposal')['0000000005']).toMatchObject({
      proposer: { type: 'Community', value: PROPOSER },
      ownerId: OWNER,
      state: 'Pending',
      balance: '2000',
      url: 'https://pip',
      expiresAt: 900,
      totalAyeWeight: '3000',
    });
    expect(rows('Proposal')['0000000006']).toMatchObject({ state: 'Scheduled' });
    expect(rows('Proposal')['0000000006'].ownerId).toBeUndefined();
  });

  it("seeds the PIP votes, the proposer's deposit among them", () => {
    expect(rows('ProposalVote')[`0000000005/${PROPOSER}`]).toMatchObject({
      vote: true,
      weight: '2000',
    });
  });

  it('seeds no offer of a seat on an account that is no multisig', () => {
    expect(rows('MultiSigSigner')[`${PAYER}/Account/${OTHER_USER}`]).toBeUndefined();
  });

  it('seeds no offer to an identity, which 7.0 made unacceptable', () => {
    expect(rows('MultiSigSigner')[`${MS}/Identity/${OWNER}`]).toBeUndefined();
  });

  it('seeds accepted and pending subsidies, and the offers still waiting as authorizations', () => {
    expect(rows('Subsidy')[`${SIGNER}/${PAYER}`]).toMatchObject({
      allowance: '500',
      isAccepted: true,
    });
    expect(rows('Subsidy')[`${PROPOSER}/${PAYER}`]).toMatchObject({
      allowance: '100',
      isAccepted: false,
    });
    expect(rows('Subsidy')[`${MS}/${PAYER}`]).toMatchObject({ allowance: '70', isAccepted: false });
    expect(rows('Subsidy')[`${SIGNER}/${PAYER}`].totalDebited).toBeUndefined();
  });

  it('seeds the latest of the offers pending for a pair, an 8.x offer over an older one', () => {
    expect(rows('Subsidy')[`${MS}/${PAYER}`].allowance).toBe('70');
    expect(rows('Subsidy')[`${OTHER_USER}/${PAYER}`].allowance).toBe('210');
    expect(rows('Subsidy')[`${PROPOSER}/${PAYER}`].allowance).toBe('100');
  });
});
