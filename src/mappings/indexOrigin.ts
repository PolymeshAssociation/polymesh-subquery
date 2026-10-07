import { SubstrateBlock } from '@subql/types';
import { blockTime } from '../utils';
import { IndexOrigin } from '../types';

/**
 * The domains an index can vouch for, and which of them it seeded.
 *
 * A genesis replay derives every one of them. An index started at a later block seeds only what it
 * can read out of chain storage at that block; the rest it either resolves one row at a time from
 * the chain the first time a handler meets it, or cannot know at all.
 */
export const DOMAINS = {
  polyxBalances: 'POLYX balances, from system.account',
  portfolioHoldings: 'fungible holdings of portfolios, from portfolio.portfolioAssetBalances',
  multiSigs: 'multisigs, their signers and admins',
  evmAccountMappings: 'EVM account mappings, from revive.originalAccount',
  identities: 'identities and their keys',
  assets: 'assets',
  assetCounts: "each asset's holder and transfer counts",
  accountHoldings: 'v8 account-level holdings',
  nfts: 'NFT tokens and holders',
  settlement: 'instructions in flight',
  compliance: 'compliance requirements and statistics',
} as const;

export type Domain = keyof typeof DOMAINS;

/**
 * What an index started after genesis cannot seed, and why. Kept beside the list of domains so a
 * domain gains a seeder by moving out of here, and `IndexOrigin` says so without anyone
 * remembering to.
 */
export const UNSEEDED_FROM_START_BLOCK: Record<Exclude<Domain, SeededDomain>, string> = {
  identities:
    'resolved from chain storage one identity at a time, the first time one is referenced',
  assets:
    'resolved from chain storage one asset at a time, the first time one is referenced (from v7)',
  assetCounts:
    'derived by the index from the start block on, so relative to it rather than absolute',
  accountHoldings: 'no seeder yet: account-level holders are only visible as they next move',
  nfts: 'no seeder yet: tokens are only visible as they next move',
  settlement: 'no seeder yet: instructions created before the start block are not indexed',
  compliance: 'no seeder yet: requirements are only visible as they next change',
};

export const SEEDED_FROM_START_BLOCK = [
  'polyxBalances',
  'portfolioHoldings',
  'multiSigs',
  'evmAccountMappings',
] as const;

type SeededDomain = (typeof SEEDED_FROM_START_BLOCK)[number];

const ORIGIN_ID = 'origin';

/** Records where the index starts and what it vouches for. Written once, by the first block. */
export const writeIndexOrigin = async (block: SubstrateBlock, partial: boolean): Promise<void> => {
  const seeded: string[] = partial ? [...SEEDED_FROM_START_BLOCK] : Object.keys(DOMAINS);
  const unseeded = partial
    ? Object.entries(UNSEEDED_FROM_START_BLOCK).map(([domain, reason]) => `${domain}: ${reason}`)
    : [];

  await IndexOrigin.create({
    id: ORIGIN_ID,
    startBlock: Number(block.block.header.number.toString()),
    startBlockHash: block.block.header.hash.toHex(),
    specVersion: block.specVersion,
    seededDomains: seeded,
    unseededDomains: unseeded,
    datetime: blockTime(block),
  }).save();

  cachedPartial = partial;
};

/**
 * Whether this index started after genesis. Read once and kept: the origin is written by the first
 * block and never changes, so this is a cache in the plainest sense — losing it re-reads the row.
 */
let cachedPartial: boolean | undefined;

export const isPartialIndex = async (): Promise<boolean> => {
  if (cachedPartial === undefined) {
    const origin = await IndexOrigin.get(ORIGIN_ID);
    cachedPartial = origin !== undefined && origin.startBlock > 1;
  }

  return cachedPartial;
};

/** Test hook. */
export const __resetIndexOrigin = (): void => {
  cachedPartial = undefined;
};
