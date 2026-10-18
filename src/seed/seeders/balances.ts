import {
  accountDataFrozen,
  applyChainFreezes,
  emptyBalance,
  Hold,
  holdsFromBytes,
  holdsFromJson,
  lockAmountFromJson,
  PIPS_LOCK_ID,
  STAKING_LOCK_ID,
} from '../../mappings/entities/identities/ledgerCore';
import { AccountBalance } from '../../types';
import { getBigIntValue, is8xSpecVersion } from '../../utils';
import { codecBytes } from '../../utils/bytes';
import { memberOf, optionOf } from '../../utils/codec';
import { ledgerSnapshot } from '../../utils/staking';
import { Seeder } from '../seeder';
import { Entry } from '../snapshot';
import { storedKeys } from './keys';

/** What freezes and holds each account's POLYX, each item read whole and keyed by account */
interface FreezeState {
  is8x: boolean;
  holds: ReadonlyMap<string, Entry>;
  locks: ReadonlyMap<string, Entry>;
  bonded: ReadonlyMap<string, Entry>;
  ledgers: ReadonlyMap<string, Entry>;
}

/** A `balances.holds` entry's holds, from its raw bytes when the runtime can't decode it */
const holdsOfEntry = ({ value, raw }: Entry): Hold[] | undefined => {
  if (value) {
    return holdsFromJson(value.toJSON());
  }
  const stored = optionOf(raw, 'the stored balances.holds');
  return stored ? holdsFromBytes(codecBytes(stored)) : [];
};

/** Before v8, the staking lock is the ledger's total, the amount passed to `set_lock` */
const ledgerTotal = (stash: string, state: FreezeState): bigint => {
  const controller = state.bonded.get(stash)?.value?.toString() || stash;
  const ledger = state.ledgers.get(controller)?.value?.toJSON();
  return ledgerSnapshot((ledger ?? null) as Parameters<typeof ledgerSnapshot>[0]).total;
};

const chainFreezes = (
  address: string,
  { reserved, frozen }: { reserved: bigint; frozen: bigint },
  state: FreezeState
) => {
  // `holds` exists only from v8, so an absent value must mean exactly that. On v8, nothing
  // reserved means nothing held, an empty list, not an unknown one
  let holds: Hold[] | undefined;
  if (state.is8x) {
    const entry = reserved > BigInt(0) ? state.holds.get(address) : undefined;
    holds = entry ? holdsOfEntry(entry) : [];
  }

  if (frozen <= BigInt(0)) {
    return { frozen, holds, stakingLock: undefined, pipsLock: undefined };
  }

  // A start block inside the two-pass v8 lock → hold migration still sees the old staking lock,
  // so on v8 it is read from the lock list rather than assumed away. A v8 pips deposit is tracked
  // through the generic `Locked` / `Unlocked`.
  const lockJson = state.locks.get(address)?.value?.toJSON() ?? [];
  return state.is8x
    ? {
        frozen,
        holds,
        stakingLock: lockAmountFromJson(lockJson, STAKING_LOCK_ID),
        pipsLock: undefined,
      }
    : {
        frozen,
        holds,
        stakingLock: ledgerTotal(address, state),
        pipsLock: lockAmountFromJson(lockJson, PIPS_LOCK_ID),
      };
};

/**
 * Each funded account's opening balance, from `system.account`, its freezes attributed as the POLYX
 * ledger keeps them: a bond as the staking lock (the ledger's total, before 8.0) or the staking hold
 * (from 8.0), a PIP deposit as the pips lock, and what's unexplained as the residual lock. The
 * lifetime totals count from the start block.
 */
export const accountBalanceSeeder: Seeder<AccountBalance> = {
  entity: 'AccountBalance',
  // a reaped account's row stays indexed
  terminal: ({ total }) => BigInt(total) === BigInt(0),
  reads: [
    'system.account',
    'balances.holds',
    'balances.locks',
    'staking.bonded',
    'staking.ledger',
    'identity.keyRecords',
    'identity.keyToIdentityIds',
    'identity.didRecords',
  ],
  oldShapes: {
    'system.account': [3000],
    'balances.locks': [3000],
    'staking.bonded': [3000],
    'staking.ledger': [3000],
    'identity.keyToIdentityIds': [3000],
    'identity.didRecords': [3000],
  },
  accounts: ['accountId'],
  relative: [
    'totalReceived',
    'totalSent',
    'totalFeesPaid',
    'totalRewards',
    'totalSlashed',
    'movementCount',
    'lifetimeByKind',
  ],
  async *rows(snap, ctx) {
    const is8x = is8xSpecVersion(ctx.specVersion);
    const none = new Map<string, Entry>();
    const [holds, locks, bonded, ledgers, keys] = await Promise.all([
      is8x ? snap.map('balances.holds') : none,
      snap.map('balances.locks'),
      is8x ? none : snap.map('staking.bonded'),
      is8x ? none : snap.map('staking.ledger'),
      storedKeys(snap),
    ]);
    const state: FreezeState = { is8x, holds, locks, bonded, ledgers };

    for await (const page of snap.pages('system.account')) {
      yield page.flatMap(({ args, value }) => {
        const address = args[0].toString();
        if (!value) {
          throw new Error(`system.account of ${address} doesn't decode`);
        }
        // the balance fields, not the account info around them: `frozen` is `miscFrozen` and
        // `feeFrozen` on older runtimes, so only this inner shape is read spec-agnostically
        const data = memberOf(value, 'data');
        const free = getBigIntValue(memberOf(data, 'free'));
        const reserved = getBigIntValue(memberOf(data, 'reserved'));
        const frozen = accountDataFrozen(data);
        if (free === BigInt(0) && reserved === BigInt(0) && frozen === BigInt(0)) {
          return [];
        }

        const balance = emptyBalance(address, keys.get(address)?.did, ctx.eventId);
        balance.free = free;
        balance.reserved = reserved;
        applyChainFreezes(balance, chainFreezes(address, { reserved, frozen }, state));
        return [balance];
      });
    }
  },
};
