/**
 * Every place a handler reads the chain instead of the index, and the gap in the event data each
 * fills. The seed writes every row the chain holds at the start, and events keep them, so a read
 * that stands in for a row is a bug in the seed or a handler; a new read must name its gap here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..');

/** The chain-read helpers themselves */
const HELPERS = ['src/utils/storageAtParent.ts', 'src/utils/legacyQuery.ts'];

// the seed's readers (`src/seed/bulk.ts`, `snapshot.ts`) read the chain too, should a handler
// import one
const READ =
  /api\.query\.|api\.rpc\.|legacyQuery\(|findStorage\(|storageAtParent\(|storageEntriesAtParent\(|parentStateReadable\(|scanAtParent\(|snapshotAtParent\(/g;

/** Reads per file, each with the gap in the event data they fill */
const READS: Record<string, [number, string]> = {
  'src/mappings/entities/assets/mapAsset.ts': [
    2,
    'name and funding round: not in events before 5.1',
  ],
  'src/mappings/entities/assets/mapCheckpoint.ts': [
    1,
    "a schedule's remaining checkpoints before 6.0: no event says it completed",
  ],
  'src/mappings/entities/assets/mapNfts.ts': [
    1,
    "a collection's ticker before 6.0: an issuance names only the collection",
  ],
  'src/mappings/entities/block/mapChainUpgrade.ts': [
    2,
    'the runtime an upgrade installed, and the one it replaced: CodeUpdated carries neither',
  ],
  'src/mappings/entities/events/mapStakingPosition.ts': [
    1,
    "a controller's stash: the event names only the controller",
  ],
  'src/mappings/entities/identities/feePayer.ts': [
    4,
    "who paid a fee (subsidiser, multisig's identity, bridge controller): fee events name only the account",
  ],
  'src/mappings/entities/identities/ledgerCore.ts': [
    6,
    'balance holds, locks and account data: the parts of a balance no event moves',
  ],
  'src/mappings/entities/identities/preV8Ledger.ts': [
    1,
    'whether an identity is a child (6.1–6.x): DidCreated does not say',
  ],
  'src/mappings/entities/pips/mapProposal.ts': [
    1,
    "whether an 8.x refund batch returned the proposer's deposit: ProposalRefund gives only a total",
  ],
  'src/mappings/entities/relayer/mapSubsidy.ts': [
    3,
    "a subsidy's allowance before 8.0, accepted or drawn by fees, and the offers still pending when a subsidy ends: no event carries them",
  ],
  'src/mappings/entities/settlements/mapVenue.ts': [
    1,
    'the signers a venue was created with: not in VenueCreated',
  ],
  'src/mappings/entities/settlements/silentPreApprovals.ts': [
    3,
    'pre-approvals made on 6.0.0–6.0.1, which emit no event',
  ],
  'src/mappings/trueSpec.ts': [1, 'the runtime before the first upgrade the index records'],
  'src/utils/accounts.ts': [
    5,
    "an address's key record, and before 5.0 the multisig it signs for: the role an offered multisig signer already holds, a caller's identity",
  ],
  'src/utils/blockAuthor.ts': [
    1,
    "the session's validators, which the digest's author index names",
  ],
  'src/utils/deferredSlashes.ts': [
    1,
    'slashes held back until their era: applying one emits nothing',
  ],
  'src/utils/staking.ts': [
    13,
    "an era's exposures, prefs, points and stake, and a payee's ledger: events carry totals only",
  ],
};

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });

const readsIn = (path: string): number =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => !/^\s*(\*|\/\/|\/\*|import )/.test(line))
    .reduce((count, line) => count + (line.match(READ)?.length ?? 0), 0);

it('reads the chain only where the event data has a gap', () => {
  const found = Object.fromEntries(
    ['src/mappings', 'src/utils']
      .flatMap(dir => sources(join(ROOT, dir)))
      .map(path => relative(ROOT, path))
      .filter(path => !HELPERS.includes(path))
      .map(path => [path, readsIn(join(ROOT, path))] as const)
      .filter(([, count]) => count > 0)
  );

  expect(found).toEqual(
    Object.fromEntries(Object.entries(READS).map(([path, [count]]) => [path, count]))
  );
});
