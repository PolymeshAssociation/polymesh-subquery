import { Codec } from '@polkadot/types/types';
import {
  AssetAllowance,
  AssetHolder,
  HolderKind,
  Holding,
  Nft,
  NftApproval,
  NftOperatorApproval,
} from '../../types';
import { isObject } from '../../utils/codec';
import { padId } from '../../utils/common';
import { pageRows, pagesOf, SeedContext, Seeder } from '../seeder';
import { ChainSnapshot, Entry, StorageRef } from '../snapshot';
import { assetIdOf, identityHoldings } from './assetKeys';
import { StoredKey, storedKeys } from './keys';

/**
 * Holdings, tokens and what's approved over them. Each portfolio's and account's position is
 * built in one pass (`positions`): balances and frozen amounts, freezes, and each token's owner.
 * An identity's position across them is the chain's own total (`asset.balanceOf` and
 * `nft.numberOfNFTs`), which the chain keeps apart from its portfolios' and can differ from their
 * sum.
 */

/** A portfolio as storage keys it: `{ did, kind: default | user(n) }` */
type PortfolioKey = { did: string; kind: { default?: null; user?: number } };
type Holder = { portfolio: PortfolioKey } | { account: string };

const portfolioIdOf = ({ did, kind }: PortfolioKey): string => `${did}/${kind.user ?? 0}`;

const nftRowId = (assetId: string, nftId: string): string => `${assetId}/${padId(nftId)}`;

/** Where a token is, from its owner as `nft.owner` (7.4+, a portfolio or an account) or `nft.nftOwner` holds it */
const holderOfOwner = (owner: unknown): Holder | undefined => {
  if (!isObject(owner)) {
    return undefined;
  }
  if (typeof owner.account === 'string') {
    return { account: owner.account };
  }
  const portfolio = (isObject(owner.portfolio) ? owner.portfolio : owner) as PortfolioKey;
  return typeof portfolio.did === 'string' ? { portfolio } : undefined;
};

interface Positions {
  holdings: Map<string, Holding>;
  nfts: Nft[];
}

const byPortfolio = (arg: Codec): Holder => ({ portfolio: arg.toJSON() as PortfolioKey });
const byAccount = (arg: Codec): Holder => ({ account: arg.toString() });
const amount = (value: Codec) => BigInt(value.toString());

/** The holdings the position items name, each made the first time one names it */
const holdingBook = (keys: ReadonlyMap<string, StoredKey>, ctx: SeedContext) => {
  const holdings = new Map<string, Holding>();
  const holdingOf = (assetId: string, holder: Holder): Holding => {
    const portfolio = 'portfolio' in holder ? holder.portfolio : undefined;
    const account = 'account' in holder ? holder.account : undefined;
    const portfolioId = portfolio && portfolioIdOf(portfolio);
    const id = `${assetId}/${portfolioId ?? account}`;
    let holding = holdings.get(id);
    if (!holding) {
      const identityId = portfolio ? portfolio.did : keys.get(account as string)?.did;
      holding = Holding.create({
        id,
        assetId,
        holderKind: portfolio ? HolderKind.Portfolio : HolderKind.Account,
        portfolioId,
        accountId: account,
        identityId,
        assetHolderId: identityId ? `${assetId}/${identityId}` : undefined,
        amount: BigInt(0),
        frozen: BigInt(0),
        nftCount: 0,
        createdEventId: ctx.eventId,
        updatedEventId: ctx.eventId,
      });
      holdings.set(id, holding);
    }
    return holding;
  };
  return { holdings, holdingOf };
};

type HoldingOf = ReturnType<typeof holdingBook>['holdingOf'];

/** An entry that holds something: the chain keeps none for nothing held, frozen or flagged */
const isHeld = (entry: Entry): entry is Entry & { value: Codec } => {
  const json: unknown = entry.value?.toJSON();
  return (
    entry.value !== undefined && json !== false && json !== 0 && json !== '0' && json !== '0x0'
  );
};

/** Applies `apply` to the holding each entry of `item` names: its holder, then its asset */
const applyToEach = async (
  snap: ChainSnapshot,
  holdingOf: HoldingOf,
  item: StorageRef,
  holderOf: (arg: Codec) => Holder,
  apply: (holding: Holding, value: Codec) => void
): Promise<void> => {
  for await (const page of snap.pages(item)) {
    const held = page.filter(isHeld);
    const assetIds = await Promise.all(held.map(({ args }) => assetIdOf(args[1])));
    held.forEach(({ args, value }, i) => apply(holdingOf(assetIds[i], holderOf(args[0])), value));
  }
};

/** A token and who holds it */
interface Owned {
  assetId: string;
  nftId: string;
  holder: Holder;
}

/** The tokens `nft.owner` (7.4+) or `nft.nftOwner` names an owner for */
const ownedBy = async (
  snap: ChainSnapshot,
  item: 'nft.owner' | 'nft.nftOwner'
): Promise<Owned[]> => {
  const owned: Owned[] = [];
  for await (const page of snap.pages(item)) {
    const named = page.flatMap(({ args, value }) => {
      const holder = holderOfOwner(value?.toJSON());
      return holder ? [{ args, holder }] : [];
    });
    const assetIds = await Promise.all(named.map(({ args }) => assetIdOf(args[0])));
    named.forEach(({ args, holder }, i) =>
      owned.push({ assetId: assetIds[i], nftId: args[1].toString(), holder })
    );
  }
  return owned;
};

/** Before 6.1 a token's owner is kept only as its portfolio's flag, keyed (ticker, id) */
const flaggedInPortfolios = async (snap: ChainSnapshot): Promise<Owned[]> => {
  const owned: Owned[] = [];
  for await (const page of snap.pages('portfolio.portfolioNFT')) {
    const flagged = page.filter(({ value }) => value?.toJSON() === true);
    const assetIds = await Promise.all(
      flagged.map(({ args }) => assetIdOf((args[1] as unknown as [Codec, Codec])[0]))
    );
    flagged.forEach(({ args }, i) =>
      owned.push({
        assetId: assetIds[i],
        nftId: (args[1] as unknown as [Codec, Codec])[1].toString(),
        holder: byPortfolio(args[0]),
      })
    );
  }
  return owned;
};

/** Every token, in the holding it is in, which counts it */
const tokensOf = async (
  snap: ChainSnapshot,
  holdingOf: HoldingOf,
  ctx: SeedContext
): Promise<Nft[]> => {
  const owned =
    snap.has('nft.owner') || snap.has('nft.nftOwner')
      ? (await Promise.all([ownedBy(snap, 'nft.owner'), ownedBy(snap, 'nft.nftOwner')])).flat()
      : await flaggedInPortfolios(snap);
  return owned.map(({ assetId, nftId, holder }) => {
    const holding = holdingOf(assetId, holder);
    holding.nftCount += 1;
    return Nft.create({
      id: nftRowId(assetId, nftId),
      assetId,
      nftId: BigInt(nftId),
      holdingId: holding.id,
      createdEventId: ctx.eventId,
      updatedEventId: ctx.eventId,
    });
  });
};

const positions = (snap: ChainSnapshot, ctx: SeedContext): Promise<Positions> =>
  snap.derive('positions', async () => {
    const { holdings, holdingOf } = holdingBook(await storedKeys(snap), ctx);
    const each = (
      item: StorageRef,
      holderOf: (arg: Codec) => Holder,
      apply: (holding: Holding, value: Codec) => void
    ) => applyToEach(snap, holdingOf, item, holderOf, apply);

    await each('portfolio.portfolioAssetBalances', byPortfolio, (h, v) => (h.amount = amount(v)));
    await each('asset.assetBalance', byAccount, (h, v) => (h.amount = amount(v)));
    await each('portfolio.portfolioFrozenAssets', byPortfolio, (h, v) => (h.frozen = amount(v)));
    await each('asset.frozenBalance', byAccount, (h, v) => (h.frozen = amount(v)));
    // the chain keeps that a holder is frozen, not since when: the start block stands in for it
    await each('portfolio.frozenPortfolios', byPortfolio, h => (h.frozenSince = ctx.datetime));
    await each('asset.frozenAccounts', byAccount, h => (h.frozenSince = ctx.datetime));

    return { holdings, nfts: await tokensOf(snap, holdingOf, ctx) };
  });

const POSITION_READS: StorageRef[] = [
  'portfolio.portfolioAssetBalances',
  'asset.assetBalance',
  'portfolio.portfolioFrozenAssets',
  'asset.frozenBalance',
  'portfolio.frozenPortfolios',
  'asset.frozenAccounts',
  'nft.owner',
  'nft.nftOwner',
  'portfolio.portfolioNFT',
  'identity.keyRecords',
  'identity.keyToIdentityIds',
  'identity.didRecords',
];

export const holdingSeeder: Seeder<Holding> = {
  entity: 'Holding',
  // an emptied holding stays indexed; the chain drops it
  terminal: ({ amount, nftCount }) => BigInt(amount) === BigInt(0) && !nftCount,
  reads: POSITION_READS,
  oldShapes: { 'identity.keyToIdentityIds': [3000], 'identity.didRecords': [3000] },
  accounts: ['accountId'],
  relative: ['frozenSince'],
  async *rows(snap, ctx) {
    yield* pagesOf([...(await positions(snap, ctx)).holdings.values()]);
  },
};

/** An identity's position in an asset: units from `asset.balanceOf`, tokens from `nft.numberOfNFTs` */
export const assetHolderSeeder: Seeder<AssetHolder> = {
  entity: 'AssetHolder',
  reads: ['asset.balanceOf', 'nft.numberOfNFTs'],
  async *rows(snap, ctx) {
    const rows: AssetHolder[] = [];
    for (const [assetId, byIdentity] of await identityHoldings(snap)) {
      for (const [identityId, { amount, nftCount }] of byIdentity) {
        rows.push(
          AssetHolder.create({
            id: `${assetId}/${identityId}`,
            identityId,
            assetId,
            amount,
            nftCount,
            createdEventId: ctx.eventId,
            updatedEventId: ctx.eventId,
          })
        );
      }
    }
    yield* pagesOf(rows);
  },
};

/** A token, in the holding it is in; a burned one is gone from the chain */
export const nftSeeder: Seeder<Nft> = {
  entity: 'Nft',
  reads: POSITION_READS,
  oldShapes: { 'identity.keyToIdentityIds': [3000], 'identity.didRecords': [3000] },
  terminal: ({ burnedEventId }) => Boolean(burnedEventId),
  async *rows(snap, ctx) {
    yield* pagesOf((await positions(snap, ctx)).nfts);
  },
};

/** An owner's allowance to a spender over an asset (8.0+); what was spent before is history */
export const assetAllowanceSeeder: Seeder<AssetAllowance> = {
  entity: 'AssetAllowance',
  reads: ['asset.allowances'],
  accounts: ['ownerId', 'spenderId'],
  relative: ['totalSpent'],
  async *rows(snap, ctx) {
    for await (const page of snap.pages('asset.allowances')) {
      yield await pageRows(page, async ({ args, value }) => {
        if (!value) {
          return [];
        }
        const assetId = await assetIdOf(args[2]);
        const [owner, spender] = [args[0].toString(), args[1].toString()];
        return [
          AssetAllowance.create({
            id: `${assetId}/${owner}/${spender}`,
            assetId,
            ownerId: owner,
            spenderId: spender,
            amount: BigInt(value.toString()),
            totalSpent: BigInt(0),
            createdEventId: ctx.eventId,
            updatedEventId: ctx.eventId,
          }),
        ];
      });
    }
  },
};

/** One spender's approval to move one token (8.1+), owned by the account holding the token */
export const nftApprovalSeeder: Seeder<NftApproval> = {
  entity: 'NftApproval',
  reads: ['nft.tokenApproval', 'nft.owner'],
  accounts: ['ownerId', 'spenderId'],
  async *rows(snap, ctx) {
    const owners = await snap.map('nft.owner');
    for await (const page of snap.pages('nft.tokenApproval')) {
      yield await pageRows(page, async ({ args, value }) => {
        const owner = holderOfOwner(owners.get(args.map(String).join('/'))?.value?.toJSON());
        if (!value || !owner || !('account' in owner)) {
          return [];
        }
        const assetId = await assetIdOf(args[0]);
        const id = nftRowId(assetId, args[1].toString());
        return [
          NftApproval.create({
            id,
            nftId: id,
            assetId,
            ownerId: owner.account,
            spenderId: value.toString(),
            createdEventId: ctx.eventId,
            updatedEventId: ctx.eventId,
          }),
        ];
      });
    }
  },
};

/** An operator's standing approval over all an owner holds of a collection (8.1+) */
export const nftOperatorApprovalSeeder: Seeder<NftOperatorApproval> = {
  entity: 'NftOperatorApproval',
  reads: ['nft.operatorApproval'],
  accounts: ['ownerId', 'operatorId'],
  async *rows(snap, ctx) {
    for await (const page of snap.pages('nft.operatorApproval')) {
      yield await pageRows(page, async ({ args, value }) => {
        if (value?.toJSON() !== true) {
          return [];
        }
        const assetId = await assetIdOf(args[2]);
        const [owner, operator] = [args[0].toString(), args[1].toString()];
        return [
          NftOperatorApproval.create({
            id: `${assetId}/${owner}/${operator}`,
            assetId,
            ownerId: owner,
            operatorId: operator,
            createdEventId: ctx.eventId,
          }),
        ];
      });
    }
  },
};
