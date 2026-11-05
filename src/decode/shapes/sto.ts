import { LAST_V6, V7, V7_3 } from './consts';
import { registerShape } from './registry';

/**
 * `sto` pallet parameter shapes, up to the runtime that names them.
 *
 * 7.3.0 declares every `sto` event with named fields and adds the offering asset to each, so from
 * there the names come from the metadata. These are those names for the earlier, tuple-style eras:
 * an event that gained `offeringAsset` has no such field before it, and the rest keep their names.
 * The agent is `agentDid`.
 *
 * Before 7.0.0 the assets an `Invested` holds are tickers, so they are keyed `offeringTicker` and
 * `fundingTicker`, and `offeringAsset` and `fundingAsset` from 7.0.0 (the chain also moved the
 * fundraiser id in the order at 7.3.0, which the metadata then reflects).
 */
const LAST_BEFORE_NAMED = V7_3 - 1;

const fundraiserEvent = ['agentDid', 'fundraiserId'];

registerShape('sto', 'FundraiserClosed', [
  { from: 0, to: LAST_BEFORE_NAMED, fields: fundraiserEvent },
]);
registerShape('sto', 'FundraiserFrozen', [
  { from: 0, to: LAST_BEFORE_NAMED, fields: fundraiserEvent },
]);
registerShape('sto', 'FundraiserUnfrozen', [
  { from: 0, to: LAST_BEFORE_NAMED, fields: fundraiserEvent },
]);
registerShape('sto', 'FundraiserCreated', [
  {
    from: 0,
    to: LAST_BEFORE_NAMED,
    fields: ['agentDid', 'fundraiserId', 'fundraiserName', 'fundraiser'],
  },
]);
registerShape('sto', 'FundraiserWindowModified', [
  {
    from: 0,
    to: LAST_BEFORE_NAMED,
    fields: ['agentDid', 'fundraiserId', 'oldStart', 'oldEnd', 'newStart', 'newEnd'],
  },
]);

const invested = (offering: string, funding: string): string[] => [
  'investorDid',
  'fundraiserId',
  offering,
  funding,
  'offeringAmount',
  'raiseAmount',
];

registerShape('sto', 'Invested', [
  { from: 0, to: LAST_V6, fields: invested('offeringTicker', 'fundingTicker') },
  { from: V7, to: LAST_BEFORE_NAMED, fields: invested('offeringAsset', 'fundingAsset') },
]);
