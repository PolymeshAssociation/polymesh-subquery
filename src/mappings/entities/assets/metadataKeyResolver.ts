/**
 * Recovering the metadata key for a `SetAssetMetadataValue` / `...ValueDetails` event.
 *
 * The chain says *that* a value was set on an asset; it never says *which key*. The key exists
 * only in the call that produced the event, so each event has to be matched back to its
 * originating call — which may be direct, inside a `utility` batch, behind a wrapper, or inside a
 * multisig proposal dispatched long after it was created.
 *
 * Matching is structural, not positional. `toCallNode` normalises the extrinsic into a tree of the
 * calls that matter, and `walk` consumes the extrinsic's events alongside it. `utility` and
 * `multiSig` emit a marker after each dispatched call, so the event stream itself carries the call
 * boundaries: a call that failed and rolled its events back is explicit rather than inferred, and
 * a call that emits an unexpected number of events cannot silently shift the calls after it.
 *
 * Anything the walk does not recognise aborts the whole extrinsic and resolves to `undefined`, so
 * the caller records an anomaly. A missing key is recoverable; a wrong one is not.
 */
import { SubstrateEvent } from '@subql/types';
import { CallIdEnum, MetadataScope, MultiSigProposal } from '../../../types';

export type MetadataKey = { scope: MetadataScope; keyId: string };

/**
 * `{ Local: n } | { Global: n }` from any of the shapes this module sees.
 *
 * `toHuman()` formats a `u64` with thousands separators ("1,234") while `toJSON()` does not, and
 * the multisig path is stored via `toHuman()`. Strip them so the same key id round-trips to the
 * same `AssetMetadata` row whichever path resolved it.
 */
export const parseMetadataKey = (raw: unknown): MetadataKey | undefined => {
  let obj = raw;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      return undefined;
    }
  }
  const rec = obj as Record<string, number | string> | null;
  const keyId = (id: number | string): string => `${id}`.replace(/,/g, '');
  if (rec && ('local' in rec || 'Local' in rec)) {
    return { scope: MetadataScope.Local, keyId: keyId(rec.local ?? rec.Local) };
  }
  if (rec && ('global' in rec || 'Global' in rec)) {
    return { scope: MetadataScope.Global, keyId: keyId(rec.global ?? rec.Global) };
  }
  return undefined;
};

/** Normalises an asset id for comparison — the same asset reaches here as hex or as a `toHuman` string. */
const sameAsset = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

/**
 * Only what key matching needs from a call. `leaf` is any call this module does not care about —
 * it still consumes its events, which is what keeps the walk aligned.
 */
export type CallNode =
  | { kind: 'set'; asset: string | undefined; key: MetadataKey | undefined }
  | { kind: 'registerAndSet' }
  | { kind: 'batch'; calls: CallNode[] }
  | { kind: 'wrap'; closer?: string; call: CallNode }
  | { kind: 'multisig'; call?: CallNode }
  | { kind: 'leaf' };

const BATCH_METHODS = new Set([
  'batch',
  'batchAll',
  'batchAtomic',
  'batchOptimistic',
  'forceBatch',
  'batchOld',
]);

const MULTISIG_CREATE = new Set([
  'createProposal',
  'createProposalAsKey',
  'createProposalAsIdentity',
  'createOrApproveProposalAsKey',
  'createOrApproveProposalAsIdentity',
]);

const MULTISIG_APPROVE = new Set(['approve', 'approveAsKey', 'approveAsIdentity']);

/** A decoded `Call`, read structurally — `extrinsic.args` resolves through the cjs codec build. */
type RawCall = {
  section?: string;
  method?: string;
  args?: unknown[];
  argsDef?: Record<string, unknown>;
  toHuman?: () => unknown;
};

/**
 * A named argument, by metadata name where available and by position otherwise.
 *
 * `argsDef` is absent on a hand-built call (tests, and the `toHuman` shapes stored on a proposal),
 * so every caller supplies the positional index the runtime has always used for that argument.
 */
const argOf = (call: RawCall, name: string, index: number): unknown => {
  const names = call.argsDef ? Object.keys(call.argsDef) : undefined;
  const at = names?.indexOf(name) ?? -1;
  return call.args?.[at >= 0 ? at : index];
};

/**
 * `toString()` directly — these codecs come from the cjs build, so the esm-typed helpers do not
 * apply. This is the same call the rest of the indexer builds ids with (`getTextValue`), so an
 * account comes out SS58 and a `u64` key id comes out decimal. Anything that will be compared
 * against a stored id has to go through here, never `toHex()`.
 */
const asText = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const codec = value as { toString?: () => string };
  return typeof codec.toString === 'function' ? codec.toString() : undefined;
};

/**
 * An asset id as hex. Asset ids are only ever compared against each other here — a call's arg
 * against an event's payload — so the encoding only has to agree on both sides, and hex is what
 * a real codec and a stored `toHuman()` arg both give.
 */
const asHex = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const codec = value as { toHex?: () => string };
  return typeof codec.toHex === 'function' ? codec.toHex() : asText(value);
};

const asJson = (value: unknown): unknown => {
  const codec = value as { toJSON?: () => unknown };
  return typeof codec?.toJSON === 'function' ? codec.toJSON() : value;
};

const SET_METADATA_CALLS = new Set(['setAssetMetadata', 'setAssetMetadataDetails']);

/** One `SingleProposal` as `MultiSigProposal.params` stores it — `toHuman()` args, snake_case. */
const proposalCallNode = (proposal: { call: string; args: string }): CallNode => {
  if (
    proposal.call === CallIdEnum.set_asset_metadata ||
    proposal.call === CallIdEnum.set_asset_metadata_details
  ) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(proposal.args) as Record<string, unknown>;
    } catch {
      return { kind: 'leaf' };
    }
    return {
      kind: 'set',
      asset: typeof args.asset_id === 'string' ? args.asset_id : undefined,
      key: parseMetadataKey(args.key),
    };
  }
  if (proposal.call === CallIdEnum.register_and_set_local_asset_metadata) {
    return { kind: 'registerAndSet' };
  }
  return { kind: 'leaf' };
};

/**
 * The call the multisig proposal will dispatch, from what the indexer captured at `ProposalAdded`.
 *
 * `params.proposals` is flattened one level, so a batch-of-batches proposal resolves to a flat
 * batch here and the walker aborts on the nesting it does not see — an anomaly, never a guess.
 */
const multiSigProposalNode = async (
  multisig: string | undefined,
  proposalId: string | undefined
): Promise<CallNode | undefined> => {
  if (multisig === undefined || proposalId === undefined) {
    return undefined;
  }

  const proposal = await MultiSigProposal.get(`${multisig}/${Number(proposalId)}`);
  const calls = proposal?.params?.proposals;
  if (!calls?.length) {
    return undefined;
  }

  const nodes = calls.map(proposalCallNode);
  return proposal.params.isBatch ? { kind: 'batch', calls: nodes } : nodes[0];
};

/** The normalised tree for one decoded call. */
export const toCallNode = async (call: RawCall | undefined): Promise<CallNode> => {
  if (!call) {
    return { kind: 'leaf' };
  }

  const { section, method } = call;

  if (section === 'asset') {
    if (method && SET_METADATA_CALLS.has(method)) {
      return {
        kind: 'set',
        asset: asHex(argOf(call, 'asset_id', 0)) ?? asHex(argOf(call, 'ticker', 0)),
        key: parseMetadataKey(asJson(argOf(call, 'key', 1))),
      };
    }
    if (method === 'registerAndSetLocalAssetMetadata') {
      return { kind: 'registerAndSet' };
    }
  }

  if (section === 'utility') {
    if (method && BATCH_METHODS.has(method)) {
      const calls = (argOf(call, 'calls', 0) as RawCall[] | undefined) ?? [];
      return { kind: 'batch', calls: await Promise.all(calls.map(toCallNode)) };
    }
    if (method === 'relayTx') {
      const relayed = argOf(call, 'call', 2) as { call?: RawCall } | undefined;
      return {
        kind: 'wrap',
        closer: 'utility.RelayedTx',
        call: await toCallNode(relayed?.call ?? (relayed as RawCall | undefined)),
      };
    }
    if (method === 'dispatchAs') {
      return {
        kind: 'wrap',
        closer: 'utility.DispatchedAs',
        call: await toCallNode(argOf(call, 'call', 1) as RawCall | undefined),
      };
    }
    if (method === 'withWeight') {
      // `with_weight(call, weight)` — the call is the first argument, unlike `asDerivative`.
      return {
        kind: 'wrap',
        call: await toCallNode(argOf(call, 'call', 0) as RawCall | undefined),
      };
    }
    if (method === 'asDerivative') {
      return {
        kind: 'wrap',
        call: await toCallNode(argOf(call, 'call', 1) as RawCall | undefined),
      };
    }
  }

  if (section === 'multiSig') {
    if (method && MULTISIG_CREATE.has(method)) {
      return { kind: 'multisig', call: await toCallNode(argOf(call, 'proposal', 1) as RawCall) };
    }
    if (method && MULTISIG_APPROVE.has(method)) {
      return {
        kind: 'multisig',
        call: await multiSigProposalNode(
          asText(argOf(call, 'multisig', 0)),
          asText(argOf(call, 'proposal_id', 1))
        ),
      };
    }
  }

  return { kind: 'leaf' };
};

/** One of the extrinsic's own events, flattened to what the walk reads. */
type WalkEvent = { idx: number; name: string; data: unknown[] };

type WalkState = { events: WalkEvent[]; i: number; keys: Map<number, MetadataKey> };

/**
 * Events that close a dispatched call. Reaching one means the call being walked produced no
 * further events — including the case where it failed and its events were rolled back.
 */
const CLOSERS = new Set([
  'utility.ItemCompleted',
  'utility.ItemFailed',
  'utility.BatchInterrupted',
  'utility.BatchCompleted',
  'utility.BatchCompletedWithErrors',
  'utility.BatchInterruptedOld',
  'utility.BatchCompletedOld',
  'utility.BatchOptimisticFailed',
  'utility.DispatchedAs',
  'utility.RelayedTx',
  'multiSig.ProposalExecuted',
]);

const SET_EVENTS = new Set(['asset.SetAssetMetadataValue', 'asset.SetAssetMetadataValueDetails']);

const REGISTER_LOCAL = 'asset.RegisterAssetMetadataLocalType';

/** `RegisterAssetMetadataLocalType(did, assetId, name, localKeyId, spec)`. */
const registeredKeyFrom = (event: WalkEvent): MetadataKey | undefined => {
  const keyId = asText(event.data[3]);
  return keyId === undefined ? undefined : { scope: MetadataScope.Local, keyId };
};

/**
 * A call that dispatches nothing this module tracks. It still consumes its events, which is what
 * keeps the following calls aligned, and claims any set event it is responsible for.
 */
const walkLeaf = (node: CallNode, state: WalkState, end: number): boolean => {
  let registered: MetadataKey | undefined;

  for (; state.i < end && !CLOSERS.has(state.events[state.i].name); state.i += 1) {
    const event = state.events[state.i];

    if (event.name === REGISTER_LOCAL) {
      registered = registeredKeyFrom(event);
      continue;
    }

    if (!SET_EVENTS.has(event.name)) {
      continue;
    }

    // A set event under a call that cannot own one means the tree and the event stream disagree.
    if (node.kind === 'set') {
      if (!sameAsset(node.asset, asHex(event.data[1])) || !node.key) {
        return false;
      }
      state.keys.set(event.idx, node.key);
      continue;
    }

    if (node.kind === 'registerAndSet' && registered) {
      state.keys.set(event.idx, registered);
      continue;
    }

    return false;
  }

  return true;
};

/**
 * Pre-v7 batches emit no per-call marker. Their single closing event carries a `Vec<u32>` of the
 * number of events each call produced, which is checked against the events actually seen before
 * it is trusted.
 *
 * This path is load-bearing rather than legacy trivia, checked against the chain: metadata events
 * arrive at spec 5000002, while `ItemCompleted` / `ItemFailed` only arrive at 6000001, so for the
 * whole window in between the counts vector on `BatchCompleted` / `BatchInterrupted` /
 * `BatchOptimisticFailed` is the only thing marking where one call's events end. From 6000001 the
 * per-call markers take the plain names and these events are renamed with an `Old` suffix, which
 * is why both spellings close a call.
 */
const eventCounts = (event: WalkEvent): number[] | undefined => {
  if (!event.name.startsWith('utility.')) {
    return undefined;
  }
  const first = event.data[0] as { toJSON?: () => unknown } | undefined;
  const raw = typeof first?.toJSON === 'function' ? first.toJSON() : undefined;
  if (!Array.isArray(raw) || raw.some(n => typeof n !== 'number')) {
    return undefined;
  }
  return raw as number[];
};

const walkBatch = (node: { calls: CallNode[] }, state: WalkState, end: number): boolean => {
  // Pre-v7: find a closing event whose per-call counts account for exactly the events since the
  // batch started, then walk each call inside its own bounded range.
  for (let j = state.i; j < end; j += 1) {
    const counts = eventCounts(state.events[j]);
    // A `Completed` closer ran every call, so its vector must cover the whole call list. Only the
    // interrupted / optimistic-failed forms stop early and legitimately carry fewer entries.
    // Without this an inner old-style batch's own closer can be mistaken for the outer one's.
    const ranEveryCall = /Completed/.test(state.events[j].name);
    if (
      counts &&
      (ranEveryCall ? counts.length === node.calls.length : counts.length <= node.calls.length) &&
      counts.reduce((a, b) => a + b, 0) === j - state.i
    ) {
      for (let k = 0; k < counts.length; k += 1) {
        const callEnd = state.i + counts[k];
        if (!walk(node.calls[k], state, callEnd)) {
          return false;
        }
        state.i = callEnd;
      }
      state.i = j + 1;
      return true;
    }
  }

  // v7+: ItemCompleted / ItemFailed after each call, BatchInterrupted stops the batch early.
  for (const call of node.calls) {
    if (!walk(call, state, end)) {
      return false;
    }
    const marker = state.events[state.i]?.name;
    if (marker === 'utility.ItemCompleted' || marker === 'utility.ItemFailed') {
      state.i += 1;
      continue;
    }
    if (marker === 'utility.BatchInterrupted') {
      state.i += 1;
      return true;
    }
    return false;
  }

  const closer = state.events[state.i]?.name;
  if (closer !== 'utility.BatchCompleted' && closer !== 'utility.BatchCompletedWithErrors') {
    // Every call was walked but the batch did not close. The tree and the event stream disagree,
    // so nothing from this extrinsic can be trusted.
    return false;
  }
  state.i += 1;
  return true;
};

/**
 * `ProposalAdded` / `ProposalApprovalVote` carry no dispatched call. The proposal only ran if
 * `ProposalApproved` appears, and its events sit between that and `ProposalExecuted` — none if it
 * failed, because they were rolled back.
 */
const walkMultiSig = (node: { call?: CallNode }, state: WalkState, end: number): boolean => {
  for (; state.i < end && !CLOSERS.has(state.events[state.i].name); state.i += 1) {
    const name = state.events[state.i].name;

    // A set event before approval belongs to no call the tree knows about.
    if (SET_EVENTS.has(name)) {
      return false;
    }

    if (name === 'multiSig.ProposalApproved') {
      state.i += 1;
      if (!node.call || !walk(node.call, state, end)) {
        return false;
      }
      if (state.events[state.i]?.name !== 'multiSig.ProposalExecuted') {
        // The proposal ran but did not close where the tree says it should.
        return false;
      }
      state.i += 1;
      return true;
    }
  }

  // Not executed in this extrinsic — nothing to match.
  return true;
};

function walk(node: CallNode, state: WalkState, end: number): boolean {
  switch (node.kind) {
    case 'batch':
      return walkBatch(node, state, end);
    case 'multisig':
      return walkMultiSig(node, state, end);
    case 'wrap': {
      if (!walk(node.call, state, end)) {
        return false;
      }
      if (node.closer && state.events[state.i]?.name === node.closer) {
        state.i += 1;
      }
      return true;
    }
    default:
      return walkLeaf(node, state, end);
  }
}

type EventRecordLike = {
  event: { section: string; method: string; data?: unknown[] };
  phase: { isApplyExtrinsic: boolean; asApplyExtrinsic: { toNumber: () => number } };
};

/** The extrinsic's own events, in block order, flattened for the walk. */
const extrinsicEvents = (event: SubstrateEvent, extrinsicIdx: number): WalkEvent[] => {
  const records = (event.block.events ?? []) as unknown as EventRecordLike[];

  return records.flatMap((record, idx) =>
    record?.phase?.isApplyExtrinsic && record.phase.asApplyExtrinsic.toNumber() === extrinsicIdx
      ? [
          {
            idx,
            name: `${record.event.section}.${record.event.method}`,
            data: [...(record.event.data ?? [])],
          },
        ]
      : []
  );
};

/**
 * Handlers run once per event, so the extrinsic is walked once and the result reused for its
 * remaining events. A single entry is enough: an extrinsic's events are indexed consecutively.
 */
let walkCache: { id: string; keys: Map<number, MetadataKey> | undefined } | undefined;

export const resolveMetadataKey = async (
  event: SubstrateEvent
): Promise<MetadataKey | undefined> => {
  const extrinsic = event.extrinsic;
  if (!extrinsic) {
    return undefined;
  }

  const id = `${event.block.block.header.number.toString()}/${extrinsic.idx}`;

  if (walkCache?.id !== id) {
    const events = extrinsicEvents(event, extrinsic.idx);
    const state: WalkState = { events, i: 0, keys: new Map() };
    const node = await toCallNode(extrinsic.extrinsic.method as unknown as RawCall);
    walkCache = { id, keys: walk(node, state, events.length) ? state.keys : undefined };
  }

  return walkCache.keys?.get(event.idx);
};

/** Test seam — the walk cache is module state and must not leak between cases. */
export const resetMetadataKeyCache = (): void => {
  walkCache = undefined;
};
