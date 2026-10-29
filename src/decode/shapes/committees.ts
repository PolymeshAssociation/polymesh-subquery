import { LAST_V6, V7 } from './consts';
import { registerShape, stable } from './registry';

/**
 * The governance committees' and their membership pallets' parameter shapes.
 *
 * The three committees are instances of one pallet, and so are the three memberships and the DID
 * registrars, so each group shares its shapes. Only `ReleaseCoordinatorUpdated` changed arity: it
 * dropped the caller's identity at 7.0.0.
 */
const COMMITTEES = ['polymeshCommittee', 'technicalCommittee', 'upgradeCommittee'];
const MEMBERSHIPS = [
  'committeeMembership',
  'technicalCommitteeMembership',
  'upgradeCommitteeMembership',
  'didRegistrars',
];

COMMITTEES.forEach(committee => {
  registerShape(
    committee,
    'Approved',
    stable(['callerDid', 'proposalHash', 'yesVotes', 'noVotes', 'seats'])
  );
  registerShape(committee, 'Executed', stable(['callerDid', 'proposalHash', 'result']));
  registerShape(committee, 'ExpiresAfterUpdated', stable(['callerDid', 'expiresAfter']));
  registerShape(
    committee,
    'FinalVotes',
    stable(['callerDid', 'proposalIndex', 'proposalHash', 'yesVoters', 'noVoters'])
  );
  registerShape(committee, 'Proposed', stable(['callerDid', 'proposalIndex', 'proposalHash']));
  registerShape(
    committee,
    'Rejected',
    stable(['callerDid', 'proposalHash', 'yesVotes', 'noVotes', 'seats'])
  );
  registerShape(committee, 'ReleaseCoordinatorUpdated', [
    { from: 0, to: LAST_V6, fields: ['callerDid', 'releaseCoordinator'] },
    { from: V7, fields: ['releaseCoordinator'] },
  ]);
  registerShape(
    committee,
    'VoteRetracted',
    stable(['callerDid', 'proposalIndex', 'proposalHash', 'aye'])
  );
  registerShape(
    committee,
    'VoteThresholdUpdated',
    stable(['callerDid', 'numerator', 'denominator'])
  );
  registerShape(
    committee,
    'Voted',
    stable(['callerDid', 'proposalIndex', 'proposalHash', 'aye', 'yesVotes', 'noVotes', 'seats'])
  );
});

MEMBERSHIPS.forEach(membership => {
  registerShape(membership, 'ActiveLimitChanged', stable(['callerDid', 'newLimit', 'oldLimit']));
  registerShape(membership, 'MemberAdded', stable(['callerDid', 'memberDid']));
  registerShape(membership, 'MemberRemoved', stable(['callerDid', 'memberDid']));
  registerShape(membership, 'MemberRevoked', stable(['callerDid', 'memberDid']));
  registerShape(membership, 'MembersReset', stable(['callerDid', 'members']));
  registerShape(membership, 'MembersSwapped', stable(['callerDid', 'removedDid', 'addedDid']));
});
