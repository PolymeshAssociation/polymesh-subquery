import type { ApiDecoration } from '@polkadot/api/types';
import { Codec } from '@polkadot/types/types';

/** One discrepancy, in check-state's report shape */
export interface ApprovalDifference {
  check: string;
  id: string;
  index: string;
  chain: string;
}

/** An instruction the index holds as still open on chain */
export interface IndexedInstruction {
  id: string;
  status: string;
}

/** One approval row in the index: a holder's (`did/number` or an address) or a mediator's */
export interface IndexedApproval {
  instructionId: string;
  holder: string;
  isMediator: boolean;
  status: string;
}

/** What the chain holds for one instruction */
export interface ChainApprovals {
  /** `InstructionStatus`'s variant: `Pending`, `LockedForExecution`, `Failed`, `Rejected`, … */
  status: string;
  /** the holders `settlement.affirmsReceived` holds as affirmed */
  affirmed: Set<string>;
  /** each mediator's `MediatorAffirmationStatus` variant */
  mediators: Map<string, string>;
}

/** The index's status for each chain status an open instruction can have */
const OPEN: Record<string, string> = {
  Pending: 'Created',
  LockedForExecution: 'Locked',
  Failed: 'Failed',
};

/** A holder as the index keys it: `did/number` for a portfolio, the address for an account. */
export const holderKeyOf = (raw: Codec): string => {
  const value = raw.toJSON() as
    | { account: string }
    | { portfolio: { did: string; kind: unknown } }
    | { did: string; kind: unknown };
  if ('account' in value) {
    return value.account;
  }
  const { did, kind } = 'portfolio' in value ? value.portfolio : value;
  const user =
    typeof kind === 'object' && kind !== null ? (kind as { user?: number }).user : undefined;
  return `${did}/${user ?? 0}`;
};

/**
 * Compares the index's approval rows of its open instructions with the chain's: each holder row's
 * status with `affirmsReceived` (where pending holders have no entry), each mediator row's with
 * `instructionMediatorsAffirmations` (no entry is pending), and each instruction's status.
 */
export const compareApprovals = (
  instructions: IndexedInstruction[],
  rows: IndexedApproval[],
  chain: Map<string, ChainApprovals>
): ApprovalDifference[] => {
  const out: ApprovalDifference[] = [];

  instructions.forEach(({ id, status }) => {
    const onChain = chain.get(id);
    if (!onChain || OPEN[onChain.status] !== status) {
      out.push({
        check: '9 instruction status',
        id,
        index: status,
        chain: onChain?.status ?? 'none',
      });
    }
  });

  rows.forEach(({ instructionId, holder, isMediator, status }) => {
    const onChain = chain.get(instructionId);
    if (!onChain) {
      return;
    }
    const affirmed = isMediator
      ? onChain.mediators.get(holder) === 'Affirmed'
      : onChain.affirmed.has(holder);
    const chainStatus = affirmed ? 'Affirmed' : 'Pending';
    if (status !== chainStatus) {
      out.push({
        check: isMediator ? '9 mediator approval' : '9 holder approval',
        id: isMediator ? `${instructionId}/mediator/${holder}` : `${instructionId}/${holder}`,
        index: status,
        chain: chainStatus,
      });
    }
  });

  chain.forEach(({ affirmed }, instructionId) => {
    affirmed.forEach(holder => {
      const indexed = rows.some(
        row => row.instructionId === instructionId && !row.isMediator && row.holder === holder
      );
      if (!indexed) {
        out.push({
          check: '9 affirmed holder has no row',
          id: `${instructionId}/${holder}`,
          index: 'none',
          chain: 'Affirmed',
        });
      }
    });
  });

  return out;
};

/**
 * Reports each instruction the index holds as closed (`Executed` or `Rejected`) that the chain still
 * holds open.
 */
export const compareClosed = (
  instructions: IndexedInstruction[],
  statuses: Map<string, string>
): ApprovalDifference[] =>
  instructions.flatMap(({ id, status }) => {
    const chain = statuses.get(id) ?? 'none';
    return chain in OPEN
      ? [{ check: '9 closed instruction open on chain', id, index: status, chain }]
      : [];
  });

/** The variant of an enum codec, such as `InstructionStatus` or `MediatorAffirmationStatus`. */
const variantOf = (value: Codec): string => (value as unknown as { type: string }).type;

/** Instructions read at once: open ones on mainnet run to thousands, one round trip each */
const BATCH = 50;

/** `read` for each id, `BATCH` at a time */
const inBatches = async <T>(
  ids: string[],
  read: (id: string) => Promise<T>
): Promise<Map<string, T>> => {
  const result = new Map<string, T>();
  for (let start = 0; start < ids.length; start += BATCH) {
    const batch = ids.slice(start, start + BATCH);
    // eslint-disable-next-line no-await-in-loop -- one batch at a time bounds the requests in flight
    const values = await Promise.all(batch.map(read));
    batch.forEach((id, n) => result.set(id, values[n]));
  }
  return result;
};

type DoubleMap = ((id: number) => Promise<Codec>) & {
  entries: (id: number) => Promise<[{ args: Codec[] }, Codec][]>;
};

interface SettlementStorage {
  /** from 6.0; before it, the status is part of the instruction's details */
  instructionStatuses?: DoubleMap;
  instructionDetails: (id: number) => Promise<{ status: Codec }>;
  affirmsReceived: DoubleMap;
  /** absent on runtimes without mediators */
  instructionMediatorsAffirmations?: DoubleMap;
}

const settlementAt = (at: ApiDecoration<'promise'>): SettlementStorage =>
  at.query.settlement as unknown as SettlementStorage;

/** An instruction's `InstructionStatus` variant; `Unknown` once the chain has pruned it */
const statusOf = (settlement: SettlementStorage, id: number): Promise<string> =>
  (settlement.instructionStatuses
    ? settlement.instructionStatuses(id)
    : settlement.instructionDetails(id).then(({ status }) => status)
  ).then(variantOf);

/** Each instruction's status on chain, at `at`. */
export const chainStatuses = (
  at: ApiDecoration<'promise'>,
  instructionIds: string[]
): Promise<Map<string, string>> => {
  const settlement = settlementAt(at);
  return inBatches(instructionIds, id => statusOf(settlement, Number(id)));
};

/** What the chain holds for each instruction, at `at`. */
export const chainApprovals = (
  at: ApiDecoration<'promise'>,
  instructionIds: string[]
): Promise<Map<string, ChainApprovals>> => {
  const settlement = settlementAt(at);

  return inBatches(instructionIds, async id => {
    const number = Number(id);
    const [status, affirms, mediators] = await Promise.all([
      statusOf(settlement, number),
      settlement.affirmsReceived.entries(number),
      settlement.instructionMediatorsAffirmations?.entries(number) ?? Promise.resolve([]),
    ]);
    return {
      status,
      affirmed: new Set(
        affirms
          .filter(([, value]) => variantOf(value) === 'Affirmed')
          .map(([key]) => holderKeyOf(key.args[1]))
      ),
      mediators: new Map(
        mediators.map(([key, value]) => [key.args[1].toString(), variantOf(value)])
      ),
    };
  });
};
