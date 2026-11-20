import { Codec } from '@polkadot/types/types';
import { confidentialAssetKeyRows } from '../../mappings/entities/confidentialAssets/mapConfidentialAsset';
import {
  AffirmingPartyEnum,
  ConfidentialAccount,
  ConfidentialAccountAsset,
  ConfidentialAffirmationStatusEnum,
  ConfidentialAsset,
  ConfidentialAssetEncryptionKey,
  ConfidentialAssetMediator,
  ConfidentialCurveTreeEnum,
  ConfidentialCurveTreeLeaf,
  ConfidentialEncryptionKey,
  ConfidentialLeg,
  ConfidentialLegAffirmation,
  ConfidentialSettlement,
  ConfidentialSettlementStatusEnum,
  ConfidentialSharedKeyRecipient,
} from '../../types';
import { codecBytes } from '../../utils/bytes';
import { fieldOf, isObject, optionOf, variantOf } from '../../utils/codec';
import { memoText, storedText } from '../../utils/text';
import { SeedContext, Seeder } from '../seeder';
import { ChainSnapshot, Entry, StorageRef } from '../snapshot';

/**
 * Confidential assets (the `confidentialAssets` pallet, testnet from 8.0): encryption keys and
 * the keys shared keys were distributed to, accounts, assets with their encryption keys and
 * mediators, registrations, settlements still in flight
 * with their legs and the affirmations made so far, and the curve-tree leaves. A runtime without
 * the pallet has nothing to seed. A finalized settlement's legs are pruned, so only settlements
 * whose legs the chain holds are seeded, and the asset root a settlement's proof used isn't kept.
 */

const created = (ctx: SeedContext) => ({
  createdEventId: ctx.eventId,
  updatedEventId: ctx.eventId,
});

/** Rows `build` makes of each entry of a `confidentialAssets` item */
async function* rowsOf<T>(
  snap: ChainSnapshot,
  item: StorageRef,
  build: (entry: Entry & { value: Codec }) => T[]
): AsyncGenerator<T[]> {
  for await (const page of snap.pages(item)) {
    yield page.flatMap(entry => (entry.value ? build(entry as Entry & { value: Codec }) : []));
  }
}

export const confidentialEncryptionKeySeeder: Seeder<ConfidentialEncryptionKey> = {
  entity: 'ConfidentialEncryptionKey',
  reads: ['confidentialAssets.encryptionKeyDid'],
  rows: (snap, ctx) =>
    rowsOf(snap, 'confidentialAssets.encryptionKeyDid', ({ args, value }) => [
      ConfidentialEncryptionKey.create({
        id: args[0].toString(),
        encryptionKey: args[0].toString(),
        creatorId: value.toString(),
        ...created(ctx),
      }),
    ]),
};

export const confidentialAccountSeeder: Seeder<ConfidentialAccount> = {
  entity: 'ConfidentialAccount',
  reads: ['confidentialAssets.accountDid', 'confidentialAssets.accountEncryptionKey'],
  async *rows(snap, ctx) {
    const keys = await snap.map('confidentialAssets.accountEncryptionKey');
    yield* rowsOf(snap, 'confidentialAssets.accountDid', ({ args, value }) => [
      ConfidentialAccount.create({
        id: args[0].toString(),
        publicKey: args[0].toString(),
        encryptionKeyId: keys.get(args[0].toString())?.value?.toString() ?? '',
        creatorId: value.toString(),
        ...created(ctx),
      }),
    ]);
  },
};

export const confidentialAssetSeeder: Seeder<ConfidentialAsset> = {
  entity: 'ConfidentialAsset',
  reads: [
    'confidentialAssets.details',
    'confidentialAssets.names',
    'confidentialAssets.symbols',
    'confidentialAssets.decimals',
  ],
  async *rows(snap, ctx) {
    const [names, symbols, decimals] = await Promise.all([
      snap.map('confidentialAssets.names'),
      snap.map('confidentialAssets.symbols'),
      snap.map('confidentialAssets.decimals'),
    ]);
    yield* rowsOf(snap, 'confidentialAssets.details', ({ args, value }) => {
      const id = args[0].toString();
      const { totalSupply, ownerDid } = value.toJSON() as {
        totalSupply: number | string;
        ownerDid: string;
      };
      return [
        ConfidentialAsset.create({
          id,
          assetId: Number(id),
          name: storedText(names.get(id)?.value),
          symbol: storedText(symbols.get(id)?.value),
          decimals: Number(decimals.get(id)?.value?.toString() ?? 0),
          data: storedText(fieldOf(value, 'data')),
          creatorId: ownerDid,
          totalSupply: BigInt(totalSupply),
          ...created(ctx),
        }),
      ];
    });
  },
};

interface StoredAssetKeys {
  encKeys: string[] | null;
  mediators: Record<string, number> | string[] | null;
}

/**
 * Before 8.2 the asset's keys held each mediator with the index of its key; 8.2 migrated them to a
 * set of accounts. An asset the migration skipped (an invalid or oversized entry) keeps the old
 * encoding, which 8.2's types misread, so its bytes are read with the old type.
 */
const LEGACY_ASSET_KEYS = '{"encKeys":"BTreeSet<[u8;32]>","mediators":"BTreeMap<[u8;32],u8>"}';

/** The old encoding of an asset's stored keys, which must account for every stored byte */
const legacyAssetKeysOf = ({ args, raw }: Entry): Codec => {
  const stored = optionOf(raw, "the stored asset's keys");
  const bytes = stored ? codecBytes(stored) : new Uint8Array();
  const legacy = api.registry.createType(LEGACY_ASSET_KEYS, bytes);
  if (!stored || legacy.encodedLength !== bytes.length) {
    throw new Error(
      `asset ${args[0].toString()}'s keys decode with neither the 8.2 nor the old encoding`
    );
  }
  return legacy;
};

/** An asset's encryption keys and mediator accounts from its stored keys, in either encoding */
const assetKeysOf = (entry: Entry): { encryptionKeys: string[]; mediators: string[] } => {
  const { encKeys, mediators } = (
    entry.value ?? legacyAssetKeysOf(entry)
  ).toJSON() as unknown as StoredAssetKeys;
  return {
    encryptionKeys: encKeys ?? [],
    mediators: Array.isArray(mediators) ? mediators : Object.keys(mediators ?? {}),
  };
};

/** Rows `build` makes of each asset's stored keys */
async function* assetKeyRows<T>(
  snap: ChainSnapshot,
  build: (assetId: string, keys: ReturnType<typeof assetKeysOf>) => T[]
): AsyncGenerator<T[]> {
  for await (const page of snap.pages('confidentialAssets.keys')) {
    yield page.flatMap(entry => build(entry.args[0].toString(), assetKeysOf(entry)));
  }
}

/**
 * The keys an asset's new legs are encrypted to: the one set the chain stores for its auditors
 * and mediators together, which doesn't record which key came from which.
 */
export const confidentialAssetEncryptionKeySeeder: Seeder<ConfidentialAssetEncryptionKey> = {
  entity: 'ConfidentialAssetEncryptionKey',
  raw: ['confidentialAssets.keys'],
  reads: ['confidentialAssets.keys'],
  rows: (snap, ctx) =>
    assetKeyRows(snap, (assetId, { encryptionKeys }) =>
      confidentialAssetKeyRows(assetId, encryptionKeys, []).encryptionKeys.map(row =>
        ConfidentialAssetEncryptionKey.create({ ...row, createdEventId: ctx.eventId })
      )
    ),
};

/** The accounts whose affirmation an asset's new legs need */
export const confidentialAssetMediatorSeeder: Seeder<ConfidentialAssetMediator> = {
  entity: 'ConfidentialAssetMediator',
  raw: ['confidentialAssets.keys'],
  reads: ['confidentialAssets.keys'],
  rows: (snap, ctx) =>
    assetKeyRows(snap, (assetId, { mediators }) =>
      confidentialAssetKeyRows(assetId, [], mediators).mediators.map(row =>
        ConfidentialAssetMediator.create({ ...row, createdEventId: ctx.eventId })
      )
    ),
};

/** The keys each shared key was distributed to (from 8.2; a runtime before it has none) */
export const confidentialSharedKeyRecipientSeeder: Seeder<ConfidentialSharedKeyRecipient> = {
  entity: 'ConfidentialSharedKeyRecipient',
  reads: ['confidentialAssets.sharedKeyRecipients'],
  rows: (snap, ctx) =>
    rowsOf(snap, 'confidentialAssets.sharedKeyRecipients', ({ args, value }) => {
      const sharedKeyId = args[0].toString();
      return ((value.toJSON() as string[] | null) ?? []).map(recipientId =>
        ConfidentialSharedKeyRecipient.create({
          id: `${sharedKeyId}/${recipientId}`,
          sharedKeyId,
          recipientId,
          createdEventId: ctx.eventId,
        })
      );
    }),
};

export const confidentialAccountAssetSeeder: Seeder<ConfidentialAccountAsset> = {
  entity: 'ConfidentialAccountAsset',
  reads: ['confidentialAssets.accountAssetRegistrations'],
  rows: (snap, ctx) =>
    rowsOf(snap, 'confidentialAssets.accountAssetRegistrations', ({ args, value }) =>
      value.toJSON() === true
        ? [
            ConfidentialAccountAsset.create({
              id: `${args[1].toString()}/${args[0].toString()}`,
              accountId: args[0].toString(),
              assetId: args[1].toString(),
              ...created(ctx),
            }),
          ]
        : []
    ),
};

const SETTLEMENT_STATUS: Record<string, ConfidentialSettlementStatusEnum> = {
  pending: ConfidentialSettlementStatusEnum.Pending,
  executed: ConfidentialSettlementStatusEnum.Executed,
  rejected: ConfidentialSettlementStatusEnum.Rejected,
  finalized: ConfidentialSettlementStatusEnum.Finalized,
};

export const confidentialSettlementSeeder: Seeder<ConfidentialSettlement> = {
  entity: 'ConfidentialSettlement',
  relative: ['assetRootBlock'],
  reads: [
    'confidentialAssets.settlementLegCount',
    'confidentialAssets.settlementState',
    'confidentialAssets.settlementMemo',
  ],
  terminal: ({ status }) =>
    status === ConfidentialSettlementStatusEnum.Finalized ||
    status === ConfidentialSettlementStatusEnum.Rejected,
  async *rows(snap, ctx) {
    const [states, memos] = await Promise.all([
      snap.map('confidentialAssets.settlementState'),
      snap.map('confidentialAssets.settlementMemo'),
    ]);
    yield* rowsOf(snap, 'confidentialAssets.settlementLegCount', ({ args, value }) => {
      const id = args[0].toString();
      return [
        ConfidentialSettlement.create({
          id,
          memo: memoText(memos.get(id)?.value),
          legCount: Number(value.toString()),
          status:
            SETTLEMENT_STATUS[variantOf(states.get(id)?.value?.toJSON())] ??
            ConfidentialSettlementStatusEnum.Pending,
          ...created(ctx),
        }),
      ];
    });
  },
};

export const confidentialLegSeeder: Seeder<ConfidentialLeg> = {
  entity: 'ConfidentialLeg',
  parent: { entity: 'ConfidentialSettlement', field: 'settlementId' },
  reads: ['confidentialAssets.settlementLegs'],
  rows: (snap, ctx) =>
    rowsOf(snap, 'confidentialAssets.settlementLegs', ({ args, value }) => [
      ConfidentialLeg.create({
        id: `${args[0].toString()}/${args[1].toString()}`,
        settlementId: args[0].toString(),
        legId: Number(args[1].toString()),
        encryptedData: value.toHex(),
        ...created(ctx),
      }),
    ]),
};

const AFFIRMATION_STATUS: Record<string, ConfidentialAffirmationStatusEnum> = {
  affirmed: ConfidentialAffirmationStatusEnum.Affirmed,
  rejected: ConfidentialAffirmationStatusEnum.Rejected,
  finalized: ConfidentialAffirmationStatusEnum.Finalized,
};

const PARTY: Record<string, AffirmingPartyEnum> = {
  sender: AffirmingPartyEnum.Sender,
  receiver: AffirmingPartyEnum.Receiver,
  mediator: AffirmingPartyEnum.Mediator,
};

/**
 * A party's affirmation of a leg; none while it's pending, as no event has written one. A sender
 * or receiver that reverted its affirmation reads Finalized, as one that claimed does, but only a
 * revert leaves its settlement Rejected: a finalized settlement's statuses are pruned.
 */
export const confidentialLegAffirmationSeeder: Seeder<ConfidentialLegAffirmation> = {
  entity: 'ConfidentialLegAffirmation',
  parent: { entity: 'ConfidentialSettlement', field: 'settlementId' },
  reads: ['confidentialAssets.legAffirmationStatus', 'confidentialAssets.settlementState'],
  async *rows(snap, ctx) {
    const states = await snap.map('confidentialAssets.settlementState');
    yield* rowsOf(snap, 'confidentialAssets.legAffirmationStatus', ({ args, value }) => {
      const partyKey: unknown = args[2].toJSON();
      const party = PARTY[variantOf(partyKey)];
      const settlementId = args[0].toString();
      const reverted =
        party !== AffirmingPartyEnum.Mediator &&
        variantOf(states.get(settlementId)?.value?.toJSON()) === 'rejected';
      const stored = AFFIRMATION_STATUS[variantOf(value.toJSON())];
      const status =
        reverted && stored === ConfidentialAffirmationStatusEnum.Finalized
          ? ConfidentialAffirmationStatusEnum.Reverted
          : stored;
      if (!status || !party) {
        return [];
      }
      const legId = args[1].toString();
      const keyIndex =
        party === AffirmingPartyEnum.Mediator && isObject(partyKey)
          ? Number(Object.values(partyKey)[0])
          : undefined;
      // a mediator affirms with one of its keys, a sender or receiver for its side of the leg
      const affirmer = keyIndex === undefined ? party : `${party}/${keyIndex}`;
      return [
        ConfidentialLegAffirmation.create({
          id: `${settlementId}/${legId}/${affirmer}`,
          settlementId,
          legId: `${settlementId}/${legId}`,
          party,
          keyIndex,
          status,
          ...created(ctx),
        }),
      ];
    });
  },
};

const TREES: [ConfidentialCurveTreeEnum, StorageRef][] = [
  [ConfidentialCurveTreeEnum.Account, 'confidentialAssets.accountLeaves'],
  [ConfidentialCurveTreeEnum.FeeAccount, 'confidentialAssets.feeAccountLeaves'],
  [ConfidentialCurveTreeEnum.Asset, 'confidentialAssets.assetLeaves'],
];

export const confidentialCurveTreeLeafSeeder: Seeder<ConfidentialCurveTreeLeaf> = {
  entity: 'ConfidentialCurveTreeLeaf',
  reads: TREES.map(([, item]) => item),
  async *rows(snap, ctx) {
    for (const [tree, item] of TREES) {
      yield* rowsOf(snap, item, ({ args, value }) => [
        ConfidentialCurveTreeLeaf.create({
          id: `${tree}/${args[0].toString()}`,
          tree,
          leafIndex: BigInt(args[0].toString()),
          value: value.toHex(),
          ...created(ctx),
        }),
      ]);
    }
  },
};
