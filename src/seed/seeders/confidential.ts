import { Codec } from '@polkadot/types/types';
import { confidentialAssetKeys } from '../../mappings/entities/confidentialAssets/mapConfidentialAsset';
import {
  AffirmingPartyEnum,
  ConfidentialAccount,
  ConfidentialAccountAsset,
  ConfidentialAffirmationStatusEnum,
  ConfidentialAsset,
  ConfidentialAssetKey,
  ConfidentialCurveTreeEnum,
  ConfidentialCurveTreeLeaf,
  ConfidentialEncryptionKey,
  ConfidentialLeg,
  ConfidentialLegAffirmation,
  ConfidentialSettlement,
  ConfidentialSettlementStatusEnum,
} from '../../types';
import { isObject, variantOf } from '../../utils/codec';
import { bytesToString } from '../../utils/common';
import { memoText } from '../../utils/text';
import { SeedContext, Seeder } from '../seeder';
import { ChainSnapshot, Entry, StorageRef } from '../snapshot';

/**
 * Confidential assets (the `confidentialAssets` pallet, testnet from 8.0): encryption keys,
 * accounts, assets with their auditor and mediator keys, registrations, settlements still in flight
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
    const text = (value?: Codec) => (value && !value.isEmpty ? bytesToString(value) : undefined);
    yield* rowsOf(snap, 'confidentialAssets.details', ({ args, value }) => {
      const id = args[0].toString();
      const { totalSupply, ownerDid, data } = value.toJSON() as {
        totalSupply: number | string;
        ownerDid: string;
        data: string;
      };
      return [
        ConfidentialAsset.create({
          id,
          assetId: Number(id),
          name: text(names.get(id)?.value),
          symbol: text(symbols.get(id)?.value),
          decimals: Number(decimals.get(id)?.value?.toString() ?? 0),
          data:
            data && data !== '0x' ? bytesToString({ toString: () => data } as Codec) : undefined,
          creatorId: ownerDid,
          totalSupply: BigInt(totalSupply),
          ...created(ctx),
        }),
      ];
    });
  },
};

/**
 * An asset's auditors and mediators, as the creation handler writes them: storage keys a mediator
 * by account, whose encryption key is the account's own.
 */
export const confidentialAssetKeySeeder: Seeder<ConfidentialAssetKey> = {
  entity: 'ConfidentialAssetKey',
  reads: ['confidentialAssets.keys', 'confidentialAssets.accountEncryptionKey'],
  async *rows(snap, ctx) {
    const encryptionKeys = await snap.map('confidentialAssets.accountEncryptionKey');
    yield* rowsOf(snap, 'confidentialAssets.keys', ({ args, value }) => {
      const { encKeys, mediators } = value.toJSON() as {
        encKeys: string[];
        mediators: Record<string, number>;
      };
      return confidentialAssetKeys(
        args[0].toString(),
        Object.fromEntries(
          Object.keys(mediators ?? {}).map(account => [
            account,
            encryptionKeys.get(account)?.value?.toString() ?? '',
          ])
        ),
        encKeys ?? []
      ).map(key => ConfidentialAssetKey.create({ ...key, createdEventId: ctx.eventId }));
    });
  },
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
