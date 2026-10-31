import { Codec } from '@polkadot/types/types';
import { corporateActionRow } from '../../mappings/entities/assets/mapCorporateAction';
import { ballotRow, ballotVotesOf } from '../../mappings/entities/assets/mapCorporateBallot';
import {
  CorporateAction,
  CorporateBallot,
  CorporateBallotVote,
  Distribution,
  Sto,
} from '../../types';
import { coerceHexToString, getTextValue } from '../../utils/common';
import { getDistributionValue } from '../../utils/distributions';
import { getCaIdValue } from '../../utils/portfolios';
import { getFundraiserDetails } from '../../utils/stos';
import { pageRows, SeedContext, Seeder } from '../seeder';
import { ChainSnapshot, Entry, StorageRef } from '../snapshot';
import { assetIdOf, assetWithTicker } from './assetKeys';
import { storedText } from '../../utils/text';

/**
 * Corporate actions, their assets' defaults, distributions, ballots and their votes, and
 * offerings, built as their handlers build them. The chain removes a removed action, distribution
 * or ballot, so the live ones are what's found; claims, investments and who declared an action are
 * history.
 */

const created = (ctx: SeedContext) => ({
  createdEventId: ctx.eventId,
  updatedEventId: ctx.eventId,
});

/** A `CAId` storage key as `assetKey/localId`, its asset as stored (a ticker before 7.0) */
const caKeyOf = (arg: Codec): string => {
  const json = arg.toJSON() as { assetId?: string; ticker?: string; localId?: number };
  return `${json.assetId ?? json.ticker}/${json.localId}`;
};

/** The live actions, as `assetKey/localId`, the key the `CAId`-keyed items are matched on */
const liveActions = (snap: ChainSnapshot): Promise<ReadonlySet<string>> =>
  snap.derive('liveActions', async () => {
    const keys = new Set<string>();
    for await (const page of snap.pages('corporateAction.corporateActions')) {
      page.forEach(({ args }) => keys.add(`${args[0].toString()}/${args[1].toString()}`));
    }
    return keys;
  });

/** Rows of a `CAId`-keyed item */
async function* byCa<T>(
  snap: ChainSnapshot,
  item: StorageRef,
  build: (entry: Entry & { value: Codec }, assetId: string, localId: number) => Promise<T[]> | T[]
): AsyncGenerator<T[]> {
  for await (const page of snap.pages(item)) {
    yield await pageRows(page, async entry => {
      if (!entry.value) {
        return [];
      }
      const { assetId, localId } = await getCaIdValue(entry.args[0], snap.block);
      return build(entry as Entry & { value: Codec }, assetId, localId);
    });
  }
}

export const corporateActionSeeder: Seeder<CorporateAction> = {
  entity: 'CorporateAction',
  reads: [
    'corporateAction.corporateActions',
    'corporateAction.details',
    'corporateAction.caDocLink',
  ],
  terminal: ({ isRemoved }) => isRemoved,
  async *rows(snap, ctx) {
    const [details, docs] = await Promise.all(
      (['corporateAction.details', 'corporateAction.caDocLink'] as const).map(
        async item =>
          new Map([...(await snap.map(item)).values()].map(e => [caKeyOf(e.args[0]), e.value]))
      )
    );
    for await (const page of snap.pages('corporateAction.corporateActions')) {
      yield await pageRows(page, async ({ args, value }) => {
        if (!value) {
          return [];
        }
        const localId = Number(args[1].toString());
        const key = `${args[0].toString()}/${localId}`;
        const description = details.get(key);
        return [
          corporateActionRow(
            await assetIdOf(args[0]),
            localId,
            value,
            storedText(description),
            ((docs.get(key)?.toJSON() as number[] | null) ?? []).map(String),
            { block: ctx.block, eventIdx: 0, blockEventId: ctx.eventId }
          ),
        ];
      });
    }
  },
};

/**
 * A live capital distribution, with what remains of it. Who declared it isn't kept: the identity
 * of the portfolio paying it out stands in, and the tax withheld accrues from claims, so from zero.
 */
export const distributionSeeder: Seeder<Distribution> = {
  entity: 'Distribution',
  reads: ['capitalDistribution.distributions', 'corporateAction.corporateActions'],
  relative: ['taxes'],
  async *rows(snap, ctx) {
    const actions = await liveActions(snap);
    yield* byCa(
      snap,
      'capitalDistribution.distributions',
      async ({ args, value }, assetId, localId) => {
        const terms = await getDistributionValue(value, ctx.block);
        if (!terms) {
          return [];
        }
        return [
          Distribution.create({
            id: `${assetId}/${localId}`,
            identityId: terms.portfolioId.split('/')[0],
            localId,
            assetId,
            corporateActionId: actions.has(caKeyOf(args[0])) ? `${assetId}/${localId}` : undefined,
            ...terms,
            taxes: BigInt(0),
            ...created(ctx),
          }),
        ];
      }
    );
  },
};

export const corporateBallotSeeder: Seeder<CorporateBallot> = {
  entity: 'CorporateBallot',
  reads: [
    'corporateBallot.metas',
    'corporateBallot.timeRanges',
    'corporateBallot.rcv',
    'corporateAction.corporateActions',
  ],
  terminal: ({ isRemoved }) => isRemoved,
  async *rows(snap, ctx) {
    const [ranges, rcvs, actions] = await Promise.all([
      snap.map('corporateBallot.timeRanges'),
      snap.map('corporateBallot.rcv'),
      liveActions(snap),
    ]);
    const NO_RCV = { toJSON: () => false, toString: () => 'false' } as Codec;
    yield* byCa(snap, 'corporateBallot.metas', ({ args, value }, assetId, localId) => {
      const key = args.map(String).join('/');
      const range = ranges.get(key)?.value;
      if (!range) {
        return [];
      }
      const id = `${assetId}/${localId}`;
      return [
        ballotRow(
          assetId,
          id,
          { range, meta: value, rcv: rcvs.get(key)?.value ?? NO_RCV },
          actions.has(caKeyOf(args[0])) ? id : undefined,
          ctx.eventId
        ),
      ];
    });
  },
};

export const corporateBallotVoteSeeder: Seeder<CorporateBallotVote> = {
  entity: 'CorporateBallotVote',
  parent: { entity: 'CorporateBallot', field: 'ballotId' },
  reads: ['corporateBallot.votes'],
  rows: (snap, ctx) =>
    byCa(snap, 'corporateBallot.votes', ({ args, value }, assetId, localId) => [
      CorporateBallotVote.create({
        id: `${assetId}/${localId}/${args[1].toString()}`,
        ballotId: `${assetId}/${localId}`,
        voterId: args[1].toString(),
        votes: ballotVotesOf(value),
        ...created(ctx),
      }),
    ]),
};

/** An offering, with its name, tiers, window and off-chain funding, its raising asset by ticker */
export const stoSeeder: Seeder<Sto> = {
  entity: 'Sto',
  // the chain keeps a raising ticker only as the asset id it became at 7.0
  relative: ['raisingTicker'],
  reads: [
    'sto.fundraisers',
    'sto.fundraiserNames',
    'sto.fundraiserOffchainAsset',
    'asset.assetIdTicker',
  ],
  async *rows(snap, ctx) {
    const [names, offChain, tickers] = await Promise.all([
      snap.map('sto.fundraiserNames'),
      snap.map('sto.fundraiserOffchainAsset'),
      snap.map('asset.assetIdTicker'),
    ]);
    const assetOf = assetWithTicker(tickers, ctx.block);
    for await (const page of snap.pages('sto.fundraisers')) {
      yield await pageRows(page, async ({ args, value }) => {
        const details = value && (await getFundraiserDetails(value, ctx.block, assetOf));
        if (!details) {
          return [];
        }
        const key = args.map(String).join('/');
        const name = names.get(key)?.value;
        const token = offChain.get(key)?.value;
        const offChainToken = token ? coerceHexToString(getTextValue(token)) : undefined;
        return [
          Sto.create({
            id: `${details.offeringAssetId}/${args[1].toString()}`,
            stoId: Number(args[1].toString()),
            name: storedText(name) ?? '',
            ...details,
            offChainFundingEnabled: Boolean(offChainToken),
            offChainFundingToken: offChainToken || undefined,
            ...created(ctx),
          }),
        ];
      });
    }
  },
};
