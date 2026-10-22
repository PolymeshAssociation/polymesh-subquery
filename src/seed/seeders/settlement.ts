import { SubstrateBlock } from '@subql/types';
import { Codec } from '@polkadot/types/types';
import {
  getPartyId,
  isResolved,
  pendingHolderAffirmation,
  pendingMediatorAffirmation,
} from '../../mappings/entities/settlements/holderAffirmations';
import {
  AffirmStatusEnum,
  Instruction,
  InstructionAffirmation,
  InstructionParty,
  InstructionStatusEnum,
  Leg,
  LegTypeEnum,
  Venue,
} from '../../types';
import { isObject, memberOf, variantOf } from '../../utils/codec';
import { getDateValue, padNumericId } from '../../utils/common';
import { accountHolder, meshPortfolioToAssetHolder, portfolioHolder } from '../../utils/portfolios';
import {
  getLegsValue,
  getSettlementLeg,
  getSettlementTypeDetails,
  HolderRef,
  holdersOfLegs,
  instructionPartiesOf,
  LegDetails,
  LegLookups,
} from '../../utils/settlements';
import { memoText, storedText } from '../../utils/text';
import { pageRows, pagesOf, SeedContext, Seeder } from '../seeder';
import { ChainSnapshot, Entry, StorageRef } from '../snapshot';
import { StoredKey, storedKeys } from './keys';
import { assetIds, assetWithTicker } from './assetKeys';

/**
 * Settlement in flight: venues, and each instruction the chain still holds, with its legs, parties
 * and approvals as `handleInstructionCreated` and the affirmation handlers leave them. The chain
 * prunes an executed or rejected instruction, so those still pending, failed or locked are what's
 * found, their status in `settlement.instructionStatuses` from 6.0. Who acted on an approval, and
 * an off-chain receipt (which storage doesn't tie to its leg), are history.
 */

const created = (ctx: SeedContext) => ({
  createdEventId: ctx.eventId,
  updatedEventId: ctx.eventId,
});

export const venueSeeder: Seeder<Venue> = {
  entity: 'Venue',
  reads: ['settlement.venueInfo', 'settlement.details', 'settlement.venueSigners'],
  // 5.x's is the same record under its pallet's type name
  oldShapes: { 'settlement.venueInfo': [5000002] },
  // a map keyed by venue and signer, iterated in hash order
  unordered: ['signers'],
  async *rows(snap, ctx) {
    const [details, signers] = await Promise.all([
      snap.map('settlement.details'),
      snap.map('settlement.venueSigners'),
    ]);
    const signersOf = new Map<string, string[]>();
    for (const { args, value } of signers.values()) {
      if (value?.toJSON() === true) {
        const venueId = args[0].toString();
        signersOf.set(venueId, [...(signersOf.get(venueId) ?? []), args[1].toString()]);
      }
    }
    for await (const page of snap.pages('settlement.venueInfo')) {
      yield page.flatMap(({ args, value }) => {
        if (!value) {
          return [];
        }
        const id = args[0].toString();
        const { creator, venueType } = value.toJSON() as { creator: string; venueType: string };
        const description = details.get(id)?.value;
        return [
          Venue.create({
            id: padNumericId(id),
            ownerId: creator,
            details: storedText(description),
            type: venueType,
            signers: signersOf.get(id) ?? [],
            ...created(ctx),
          }),
        ];
      });
    }
  },
};

const STATUS: Record<string, InstructionStatusEnum> = {
  pending: InstructionStatusEnum.Created,
  failed: InstructionStatusEnum.Failed,
  lockedforexecution: InstructionStatusEnum.Locked,
};

/** A holder as a settlement item keys it: an 8.0 `AssetHolder`, or a portfolio before it */
const holderRefOf = (
  json: unknown,
  keys: ReadonlyMap<string, StoredKey>
): HolderRef | undefined => {
  if (!isObject(json)) {
    return undefined;
  }
  if (typeof json.account === 'string') {
    return { accountId: json.account, identityId: keys.get(json.account)?.did };
  }
  const portfolio = (isObject(json.portfolio) ? json.portfolio : json) as {
    did?: string;
    kind?: { user?: number };
  };
  return portfolio.did
    ? { identityId: portfolio.did, portfolioId: `${portfolio.did}/${portfolio.kind?.user ?? 0}` }
    : undefined;
};

/** Entries grouped by an instruction id, at key argument `at` */
const byInstruction = (entries: Iterable<Entry>, at: number): Map<string, Entry[]> => {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const id = entry.args[at].toString();
    groups.set(id, [...(groups.get(id) ?? []), entry]);
  }
  return groups;
};

interface Bundle {
  instruction: Instruction;
  legs: Leg[];
  parties: InstructionParty[];
  affirmations: InstructionAffirmation[];
}

const SETTLEMENT_READS: StorageRef[] = [
  'settlement.instructionDetails',
  'settlement.instructionStatuses',
  'settlement.instructionMemos',
  'settlement.instructionLegs',
  'settlement.instructionMediatorsAffirmations',
  'settlement.affirmsReceived',
  'settlement.userAffirmations',
  'asset.assetIdTicker',
  'asset.assets',
  'asset.tokens',
  'identity.keyRecords',
];

/** The settlement items an instruction's rows are built from, grouped by instruction */
interface SettlementViews {
  statuses: ReadonlyMap<string, Entry>;
  memos: ReadonlyMap<string, Entry>;
  legsOf: ReadonlyMap<string, Entry[]>;
  mediatorsOf: ReadonlyMap<string, Entry[]>;
  receivedOf: ReadonlyMap<string, Entry[]>;
  holdersOf: ReadonlyMap<string, Entry[]>;
  keys: ReadonlyMap<string, StoredKey>;
  lookups: LegLookups;
  /** before 6.0 an instruction's status is in its details, and a leg is a plain transfer */
  beforeV6: boolean;
}

/** A leg's parties and asset from the chain state, as the handlers read them from the store */
const legLookups = (
  tickers: ReadonlyMap<string, Entry>,
  keys: ReadonlyMap<string, StoredKey>,
  assets: ReadonlySet<string>,
  block: SubstrateBlock
): LegLookups => ({
  isAsset: assetId => Promise.resolve(assets.has(assetId)),
  holderOf: value => {
    if (isObject(value) && typeof value.account === 'string') {
      return Promise.resolve(accountHolder(keys.get(value.account)?.did, value.account));
    }
    if (isObject(value) && isObject(value.portfolio)) {
      const { did, kind } = value.portfolio as { did: string; kind: { user?: number } };
      return Promise.resolve(portfolioHolder(did, kind.user ?? 0));
    }
    return Promise.resolve(meshPortfolioToAssetHolder(value));
  },
  assetOf: assetIdOrTicker => assetWithTicker(tickers, block)(String(assetIdOrTicker)),
});

const settlementViews = async (snap: ChainSnapshot): Promise<SettlementViews> => {
  const [
    statuses,
    memos,
    legEntries,
    mediatorEntries,
    received,
    userEntries,
    tickers,
    keys,
    assets,
  ] = await Promise.all([
    snap.map('settlement.instructionStatuses'),
    snap.map('settlement.instructionMemos'),
    snap.map('settlement.instructionLegs'),
    snap.map('settlement.instructionMediatorsAffirmations'),
    snap.map('settlement.affirmsReceived'),
    snap.map('settlement.userAffirmations'),
    snap.map('asset.assetIdTicker'),
    storedKeys(snap),
    assetIds(snap),
  ]);
  return {
    statuses,
    memos,
    legsOf: byInstruction(legEntries.values(), 0),
    mediatorsOf: byInstruction(mediatorEntries.values(), 0),
    receivedOf: byInstruction(received.values(), 0),
    holdersOf: byInstruction(userEntries.values(), 1),
    keys,
    lookups: legLookups(tickers, keys, assets, snap.block),
    beforeV6: !snap.has('settlement.instructionStatuses'),
  };
};

const holderKeyOf = (holder: HolderRef): string =>
  (holder.accountId ?? holder.portfolioId) as string;

/**
 * An instruction's holders: its on-chain legs', and any other the chain holds an affirmation of,
 * such as a portfolio of a leg 6.0 migrated off-chain; with which of them have affirmed
 */
const instructionHolders = (
  views: SettlementViews,
  id: string,
  legDetails: LegDetails[]
): { holders: HolderRef[]; affirmed: Set<string> } => {
  const holders = new Map<string, HolderRef>();
  const affirmed = new Set<string>();
  holdersOfLegs(legDetails).forEach(holder => holders.set(holderKeyOf(holder), holder));
  const approvals: [Entry[], number][] = [
    [views.holdersOf.get(id) ?? [], 0],
    [views.receivedOf.get(id) ?? [], 1],
  ];
  approvals.forEach(([entries, at]) =>
    entries.forEach(({ args: key, value: approval }) => {
      const holder = holderRefOf(key[at].toJSON(), views.keys);
      const holderKey = holder && (holder.accountId ?? holder.portfolioId);
      if (!holder || !holderKey) {
        return;
      }
      if (!holders.has(holderKey)) {
        holders.set(holderKey, holder);
      }
      if (variantOf(approval?.toJSON()) === 'affirmed') {
        affirmed.add(holderKey);
      }
    })
  );
  return { holders: [...holders.values()], affirmed };
};

interface Mediator {
  did: string;
  json: unknown;
}

const mediatorAffirmation = (
  instructionId: string,
  { did, json }: Mediator,
  eventId: string
): InstructionAffirmation => {
  const row = pendingMediatorAffirmation(instructionId, did, eventId);
  if (variantOf(json) === 'affirmed') {
    row.status = AffirmStatusEnum.Affirmed;
    const { expiry } = (isObject(json) ? Object.values(json)[0] : {}) as {
      expiry?: number | null;
    };
    row.expiry = expiry ? new Date(Number(expiry)) : undefined;
  }
  return row;
};

/** The id a venue's row has, from an instruction's `venueId`: none for an instruction with no venue */
const venueRowId = (venueId: unknown): string | undefined =>
  typeof venueId === 'number' || typeof venueId === 'string'
    ? padNumericId(String(venueId))
    : undefined;

/** The chain's JSON for an amount or a token id: a number, or hex for a large one */
const asBigInt = (amount: unknown): bigint | undefined =>
  amount === undefined || amount === null ? undefined : BigInt(amount as string);

/** An instruction the chain holds, with the rows written with it */
const bundleOf = async (
  views: SettlementViews,
  ctx: SeedContext,
  { id, value, status }: { id: string; value: Codec; status: InstructionStatusEnum }
): Promise<Bundle> => {
  const instructionId = padNumericId(id);
  const details = value as unknown as Record<string, { toJSON(): unknown }>;
  const legValues = (views.legsOf.get(id) ?? [])
    .sort((a, b) => Number(a.args[1].toString()) - Number(b.args[1].toString()))
    .map(({ value: leg }) => leg?.toJSON());
  const legsCodec = { toString: () => JSON.stringify(legValues) } as never;
  const legDetails = views.beforeV6
    ? await getLegsValue(legsCodec, ctx.block, views.lookups)
    : await getSettlementLeg(legsCodec, ctx.block, ctx.blockId, ctx.eventId, views.lookups);
  const mediators: Mediator[] = (views.mediatorsOf.get(id) ?? []).map(
    ({ args: key, value: approval }) => ({ did: key[1].toString(), json: approval?.toJSON() })
  );

  const instruction = Instruction.create({
    id: instructionId,
    status,
    venueId: venueRowId(details.venueId?.toJSON()),
    ...getSettlementTypeDetails(details.settlementType as never),
    tradeDate: getDateValue(details.tradeDate as never),
    valueDate: getDateValue(details.valueDate as never),
    memo: memoText(views.memos.get(id)?.value),
    mediators: mediators.map(({ did }) => did),
    legCount: legDetails.length,
    ...created(ctx),
  });
  const legs = legDetails.map(leg =>
    Leg.create({
      id: `${instructionId}/${leg.legIndex}`,
      ...leg,
      amount: asBigInt(leg.amount),
      nftIds: leg.nftIds?.map(nftId => asBigInt(nftId) as bigint),
      instructionId,
      addresses: [],
      ...created(ctx),
    })
  );
  const party = (identityId: string, isMediator: boolean) =>
    InstructionParty.create({
      id: getPartyId(instructionId, identityId, isMediator),
      instructionId,
      isMediator,
      identityId,
      ...created(ctx),
    });

  const { holders, affirmed } = instructionHolders(views, id, legDetails);
  const resolved = holders.filter(isResolved);
  const holderParties = new Set([
    ...instructionPartiesOf(legDetails).keys(),
    ...resolved.map(({ identityId }) => identityId),
  ]);
  const holderAffirmations = resolved.map(holder => {
    const row = pendingHolderAffirmation(instructionId, holder, ctx.eventId);
    if (affirmed.has(holderKeyOf(holder))) {
      row.status = AffirmStatusEnum.Affirmed;
    }
    return row;
  });

  return {
    instruction,
    legs,
    parties: [
      ...[...holderParties].map(did => party(did, false)),
      ...mediators.map(({ did }) => party(did, true)),
    ],
    affirmations: [
      ...holderAffirmations,
      ...mediators.map(mediator => mediatorAffirmation(instructionId, mediator, ctx.eventId)),
    ],
  };
};

/** Every instruction the chain holds with a status, each with the rows written with it */
const bundles = (snap: ChainSnapshot, ctx: SeedContext): Promise<Bundle[]> =>
  snap.derive('instructionBundles', async () => {
    const views = await settlementViews(snap);
    const result: Bundle[] = [];
    for await (const page of snap.pages('settlement.instructionDetails')) {
      const built = await pageRows(page, async ({ args, value }) => {
        const id = args[0].toString();
        // before 6.0 the status is a field of the details
        const stored = views.beforeV6 ? memberOf(value, 'status') : views.statuses.get(id)?.value;
        const status = STATUS[variantOf(stored?.toJSON())];
        // no status: finished under a runtime that never pruned it
        return value && status ? [await bundleOf(views, ctx, { id, value, status })] : [];
      });
      result.push(...built);
    }
    return result;
  });

const bundleSeeder = <T extends { id: string }>(
  entity: string,
  pick: (bundle: Bundle) => T[],
  extra: Partial<Seeder<T>> = {}
): Seeder<T> => ({
  entity,
  reads: SETTLEMENT_READS,
  // 5.x keeps the status in the details and a leg as a plain transfer
  oldShapes: {
    'settlement.instructionDetails': [5000002],
    'settlement.instructionLegs': [5000002],
  },
  async *rows(snap, ctx) {
    yield* pagesOf((await bundles(snap, ctx)).flatMap(pick));
  },
  ...extra,
});

export const instructionSeeder = bundleSeeder<Instruction>(
  'Instruction',
  ({ instruction }) => [instruction],
  {
    relative: ['failureReason'],
    terminal: ({ status }) =>
      status === InstructionStatusEnum.Executed || status === InstructionStatusEnum.Rejected,
  }
);
export const legSeeder = bundleSeeder<Leg>('Leg', ({ legs }) => legs, {
  accounts: ['fromAccountId', 'toAccountId'],
  // the keys that created and affirmed it
  relative: ['addresses'],
  // an off-chain leg's portfolios, which the chain doesn't keep: 6.0 dropped them from a pre-6.0 leg
  // it made off-chain, and an index has them from the leg's creation
  relativeFor: {
    fields: ['fromPortfolioId', 'toPortfolioId'],
    when: ({ legType }) => legType === LegTypeEnum.OffChain,
  },
  parent: { entity: 'Instruction', field: 'instructionId' },
});
export const instructionPartySeeder = bundleSeeder<InstructionParty>(
  'InstructionParty',
  ({ parties }) => parties,
  { parent: { entity: 'Instruction', field: 'instructionId' } }
);
export const instructionAffirmationSeeder = bundleSeeder<InstructionAffirmation>(
  'InstructionAffirmation',
  ({ affirmations }) => affirmations,
  {
    accounts: ['accountId', 'signerId'],
    relative: ['affirmedById', 'signerId', 'isAutomaticallyAffirmed'],
    parent: { entity: 'Instruction', field: 'instructionId' },
  }
);
