import { Era, Validator, ValidatorEra } from '../../types';
import { padId } from '../../utils/common';
import { SeedContext, Seeder } from '../seeder';
import { ChainSnapshot, StorageRef } from '../snapshot';
import { storedKeys } from './keys';

/**
 * Staking: the validators that declared their intent, and the active era with its elected set.
 * Earlier eras are history.
 */

const created = (ctx: SeedContext) => ({
  createdEventId: ctx.eventId,
  updatedEventId: ctx.eventId,
});

const KEYS: StorageRef[] = [
  'identity.keyRecords',
  'identity.keyToIdentityIds',
  'multiSig.keyToMultiSig',
  'identity.didRecords',
];
const KEY_SHAPES = {
  'identity.keyToIdentityIds': [3000],
  'identity.didRecords': [3000],
  'multiSig.keyToMultiSig': [3000],
};

/**
 * The eras whose elected sets the index has recorded: the active one and, once the next is
 * elected, the current one. At genesis, before either is set, the latest the genesis election
 * stored a session start for.
 */
const electedEras = (snap: ChainSnapshot): Promise<number[]> =>
  snap.derive('electedEras', async () => {
    const [active, current] = await Promise.all([
      snap.value('staking.activeEra'),
      snap.value('staking.currentEra'),
    ]);
    const activeIndex = (active?.toJSON() as { index?: number } | null)?.index;
    const currentIndex = current?.toJSON() as number | null | undefined;
    const eras = [activeIndex, currentIndex].filter(
      (era): era is number => era !== undefined && era !== null
    );
    if (eras.length) {
      return [...new Set(eras)].sort((a, b) => a - b);
    }
    const started = [...(await snap.map('staking.erasStartSessionIndex')).values()].map(
      ({ args }) => Number(args[0].toString())
    );
    return started.length ? [Math.max(...started)] : [];
  });

interface Exposure {
  stash: string;
  own: bigint;
  total: bigint;
  nominatorCount: number;
}

/**
 * An era's elected set: `erasStakersOverview` for an era elected from 8.0, `erasStakers` for one
 * elected before, which 8.0 goes on holding until the era ages out.
 */
const exposuresOf = (snap: ChainSnapshot, era: number): Promise<Exposure[]> =>
  snap.derive(`exposures/${era}`, async () => {
    const read = async (item: StorageRef): Promise<Exposure[]> => {
      const result: Exposure[] = [];
      for await (const page of snap.pages(item, era)) {
        page.forEach(({ args, value }) => {
          const json = value?.toJSON() as
            | {
                own: number | string;
                total: number | string;
                nominatorCount?: number;
                others?: unknown[];
              }
            | undefined;
          if (json) {
            result.push({
              stash: args[1].toString(),
              own: BigInt(json.own),
              total: BigInt(json.total),
              nominatorCount: json.nominatorCount ?? json.others?.length ?? 0,
            });
          }
        });
      }
      return result;
    };
    const overview = snap.has('staking.erasStakersOverview')
      ? await read('staking.erasStakersOverview')
      : [];
    return overview.length ? overview : read('staking.erasStakers');
  });

/** The stashes the latest election chose */
const latestElected = (snap: ChainSnapshot): Promise<ReadonlySet<string>> =>
  snap.derive('latestElected', async () => {
    const eras = await electedEras(snap);
    const latest = eras.at(-1);
    return new Set(
      latest === undefined ? [] : (await exposuresOf(snap, latest)).map(({ stash }) => stash)
    );
  });

const ERA_READS: StorageRef[] = [
  'staking.activeEra',
  'staking.currentEra',
  'staking.erasStartSessionIndex',
  'staking.erasStakersOverview',
  'staking.erasStakers',
];
const ERA_SHAPES = {
  'staking.activeEra': [3000],
  'staking.currentEra': [3000],
  'staking.erasStartSessionIndex': [3000],
  'staking.erasStakers': [3000],
};

/** Each elected era, as far as the index knows started at the start, with how many it elected */
export const eraSeeder: Seeder<Era> = {
  entity: 'Era',
  // a past era stays indexed; the chain keeps only the latest
  terminal: ({ endEventId }) => Boolean(endEventId),
  reads: ERA_READS,
  oldShapes: ERA_SHAPES,
  async *rows(snap, ctx) {
    yield await Promise.all(
      (
        await electedEras(snap)
      ).map(async index =>
        Era.create({
          id: padId(String(index)),
          eraIndex: index,
          startEventId: ctx.eventId,
          validatorCount: (await exposuresOf(snap, index)).length || undefined,
        })
      )
    );
  },
};

/** The prefs each validator of an elected era had, as the election stored them */
const eraPrefs = async (
  snap: ChainSnapshot,
  index: number
): Promise<Map<string, { commission?: number; blocked?: boolean }>> => {
  const prefs = new Map<string, { commission?: number; blocked?: boolean }>();
  for await (const page of snap.pages('staking.erasValidatorPrefs', index)) {
    page.forEach(({ args, value }) => prefs.set(args[1].toString(), value?.toJSON() as never));
  }
  return prefs;
};

/** Each elected era's set, each validator's stake and prefs as the election stored them */
export const validatorEraSeeder: Seeder<ValidatorEra> = {
  entity: 'ValidatorEra',
  parent: { entity: 'Era', field: 'eraId' },
  reads: [...ERA_READS, 'staking.erasValidatorPrefs', ...KEYS],
  oldShapes: { ...ERA_SHAPES, 'staking.erasValidatorPrefs': [3000], ...KEY_SHAPES },
  async *rows(snap, ctx) {
    const keys = await storedKeys(snap);
    const eras = await Promise.all(
      (
        await electedEras(snap)
      ).map(async index => {
        const [prefs, exposures] = await Promise.all([
          eraPrefs(snap, index),
          exposuresOf(snap, index),
        ]);
        return { index, prefs, exposures };
      })
    );
    for (const { index, prefs, exposures } of eras) {
      yield exposures.map(({ stash, own, total, nominatorCount }) => {
        const pref = prefs.get(stash);
        return ValidatorEra.create({
          id: `${padId(String(index))}/${stash}`,
          eraId: padId(String(index)),
          eraIndex: index,
          validatorId: stash,
          identityId: keys.get(stash)?.did,
          ownStake: own,
          totalStake: total,
          nominatorCount,
          commission: pref?.commission === undefined ? undefined : BigInt(pref.commission),
          blocked: pref?.blocked,
          ...created(ctx),
        });
      });
    }
  },
};

/**
 * A stash that declared its intent to validate, with its prefs, whether its identity is
 * permissioned (`validators.permissionedIdentity` from 8.0, `staking.` before), and whether the
 * latest election chose it, which is when the index marks it active.
 */
export const validatorSeeder: Seeder<Validator> = {
  entity: 'Validator',
  // a validator that stopped validating stays indexed
  terminal: ({ isActive }) => !isActive,
  reads: [
    'staking.validators',
    'validators.permissionedIdentity',
    'staking.permissionedIdentity',
    ...ERA_READS,
    ...KEYS,
  ],
  oldShapes: {
    'staking.validators': [3000],
    'staking.permissionedIdentity': [3000],
    ...ERA_SHAPES,
    ...KEY_SHAPES,
  },
  accounts: ['accountId'],
  async *rows(snap, ctx) {
    const [permissioned, elected, keys] = await Promise.all([
      snap.map(
        snap.has('validators.permissionedIdentity')
          ? 'validators.permissionedIdentity'
          : 'staking.permissionedIdentity'
      ),
      latestElected(snap),
      storedKeys(snap),
    ]);
    for await (const page of snap.pages('staking.validators')) {
      yield page.flatMap(({ args, value }) => {
        if (!value) {
          return [];
        }
        const stash = args[0].toString();
        const { commission, blocked } = value.toJSON() as {
          commission?: number;
          blocked?: boolean;
        };
        const identityId = keys.get(stash)?.did;
        return [
          Validator.create({
            id: stash,
            accountId: stash,
            identityId,
            commission: commission === undefined ? undefined : BigInt(commission),
            blocked: Boolean(blocked),
            isPermissioned: identityId ? permissioned.has(identityId) : false,
            isActive: elected.has(stash),
            ...created(ctx),
          }),
        ];
      });
    }
  },
};
