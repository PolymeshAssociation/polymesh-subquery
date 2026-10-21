import { Codec } from '@polkadot/types/types';
import { proposalParamsOf } from '../../mappings/entities/multiSig/mapMultiSigProposal';
import {
  MultiSig,
  MultiSigAdmin,
  MultiSigAdminStatusEnum,
  MultiSigProposal,
  MultiSigProposalStatusEnum,
  MultiSigProposalVote,
  MultiSigSigner,
  MultiSigSignerStatusEnum,
  Proposal,
  ProposalStateEnum,
  ProposalVote,
  Proposer,
  SignerTypeEnum,
  Subsidy,
} from '../../types';
import { encodeAddress } from '@polkadot/util-crypto';
import { codecBytes } from '../../utils/bytes';
import { isObject, memberOf, optionOf, variantOf } from '../../utils/codec';
import {
  bytesToString,
  getFirstKeyFromJson,
  getTextValue,
  is7xChain,
  padNumericId,
} from '../../utils/common';
import { getMultiSigSigner } from '../../utils/multisigs';
import { getProposerValue } from '../../utils/proposals';
import { pagesOf, SeedContext, Seeder } from '../seeder';
import { ChainSnapshot } from '../snapshot';
import { storedKeys } from './keys';

/**
 * Multisigs with their signers, admins, proposals and votes; PIPs and their votes; and subsidies,
 * built as their handlers build them. Who created a multisig or proposal, which way a 7.0 signer
 * voted, which committee member proposed a PIP and what a subsidy paid out before are history.
 */

const created = (ctx: SeedContext) => ({
  createdEventId: ctx.eventId,
  updatedEventId: ctx.eventId,
});

export const multiSigSeeder: Seeder<MultiSig> = {
  entity: 'MultiSig',
  relative: ['creatorId', 'creatorAccountId'],
  reads: ['multiSig.multiSigSignsRequired'],
  oldShapes: { 'multiSig.multiSigSignsRequired': [3000] },
  // who created it isn't kept, so the creator stays empty
  accounts: ['accountId', 'creatorAccountId'],
  async *rows(snap, ctx) {
    for await (const page of snap.pages('multiSig.multiSigSignsRequired')) {
      yield page.flatMap(({ args, value }) =>
        value
          ? [
              MultiSig.create({
                id: args[0].toString(),
                accountId: args[0].toString(),
                signaturesRequired: Number(value.toString()),
                ...created(ctx),
              }),
            ]
          : []
      );
    }
  },
};

/**
 * A multisig's signer: an accepted one the chain keeps as a signer, and one offered and not yet
 * accepted, which is a pending `AddMultiSigSigner` authorization to it. Before 5.1 the signer entry's
 * value is the signer itself, from 5.1 a flag.
 */
export const multiSigSignerSeeder: Seeder<MultiSigSigner> = {
  entity: 'MultiSigSigner',
  reads: ['multiSig.multiSigSigners', 'identity.authorizations', 'multiSig.multiSigSignsRequired'],
  oldShapes: {
    'multiSig.multiSigSigners': [3000, 5000002],
    'multiSig.multiSigSignsRequired': [3000],
  },
  accounts: ['signerAccountId'],
  terminal: ({ status }) => status === MultiSigSignerStatusEnum.Removed,
  async *rows(snap, ctx) {
    // an offer is of a seat on a multisig the chain holds; one naming another account can't be taken
    const multisigs = await snap.map('multiSig.multiSigSignsRequired');
    const signer = (
      multisigId: string,
      signerType: SignerTypeEnum,
      signerValue: string,
      status: MultiSigSignerStatusEnum
    ) =>
      MultiSigSigner.create({
        id: `${multisigId}/${signerType}/${signerValue}`,
        multisigId,
        signerType,
        signerValue,
        signerAccountId: signerType === SignerTypeEnum.Account ? signerValue : undefined,
        status,
        ...created(ctx),
      });
    const accepted = new Set<string>();
    for await (const page of snap.pages('multiSig.multiSigSigners')) {
      yield page.flatMap(({ args, value }) => {
        if (!value || value.toJSON() === false) {
          return [];
        }
        const { signerType, signerValue } = getMultiSigSigner(args[1], ctx.block);
        const row = signer(
          args[0].toString(),
          signerType,
          signerValue,
          MultiSigSignerStatusEnum.Approved
        );
        accepted.add(row.id);
        return [row];
      });
    }
    for await (const page of snap.pages('identity.authorizations')) {
      yield page.flatMap(({ args, value }) => {
        const data = value && memberOf(value, 'authorizationData');
        if (!data || getFirstKeyFromJson(data) !== 'addMultiSigSigner') {
          return [];
        }
        const target = args[0].toJSON() as { account?: string; identity?: string };
        // from 7.0 a signer is an account: an older offer to an identity can't be accepted
        if (!target.account && is7xChain(ctx.block)) {
          return [];
        }
        const [signerType, signerValue] = target.account
          ? [SignerTypeEnum.Account, target.account]
          : [SignerTypeEnum.Identity, target.identity ?? ''];
        const multisigId = String(
          (data.toJSON() as Record<string, string>)[getFirstKeyFromJson(data)]
        );
        if (!multisigs.has(multisigId)) {
          return [];
        }
        const row = signer(
          multisigId,
          signerType,
          signerValue,
          MultiSigSignerStatusEnum.Authorized
        );
        return accepted.has(row.id) ? [] : [row];
      });
    }
  },
};

/** The identity administering a multisig: `adminDid` from 7.0, `multiSigToIdentity` before */
export const multiSigAdminSeeder: Seeder<MultiSigAdmin> = {
  entity: 'MultiSigAdmin',
  reads: ['multiSig.adminDid', 'multiSig.multiSigToIdentity'],
  oldShapes: { 'multiSig.multiSigToIdentity': [3000] },
  terminal: ({ status }) => status === MultiSigAdminStatusEnum.Removed,
  async *rows(snap, ctx) {
    const item = snap.has('multiSig.adminDid')
      ? 'multiSig.adminDid'
      : 'multiSig.multiSigToIdentity';
    for await (const page of snap.pages(item)) {
      yield page.flatMap(({ args, value }) => {
        const adminId = value?.toString();
        return adminId
          ? [
              MultiSigAdmin.create({
                id: `${args[0].toString()}/${adminId}`,
                multisigId: args[0].toString(),
                adminId,
                status: MultiSigAdminStatusEnum.Authorized,
                ...created(ctx),
              }),
            ]
          : [];
      });
    }
  },
};

const PROPOSAL_STATUS: Record<string, MultiSigProposalStatusEnum> = {
  active: MultiSigProposalStatusEnum.Active,
  activeorexpired: MultiSigProposalStatusEnum.Active,
  executionsuccessful: MultiSigProposalStatusEnum.Success,
  executionfailed: MultiSigProposalStatusEnum.Failed,
  rejected: MultiSigProposalStatusEnum.Rejected,
};

/** Every multisig proposal the chain holds, as `multisig/proposalId` */
/** A proposal's multisig and number: two key arguments from 6.0.4, one `(multisig, number)` before */
const proposalKeyOf = (args: Codec[]): { multisigId: string; proposalId: number } => {
  const [multisigId, proposalId] = (
    args.length === 1 ? args[0].toJSON() : args.map(arg => arg.toJSON())
  ) as [string, number];
  return { multisigId, proposalId: Number(proposalId) };
};

/** A vote's proposal and signer: `((multisig, number), signer)` from 6.0.4, `(multisig, signer, number)` before */
const voteKeyOf = (args: Codec[]): { multisigId: string; index: number; signerKey: Codec } => {
  if (args.length === 1) {
    const [multisig, signer, index] = args[0] as unknown as [Codec, Codec, Codec];
    return { multisigId: multisig.toString(), index: Number(index.toString()), signerKey: signer };
  }
  const [multisigId, index] = args[0].toJSON() as [string, number];
  return { multisigId, index: Number(index), signerKey: args[1] };
};

/** Every proposal the chain holds, as `multisig/number` */
const heldProposals = (snap: ChainSnapshot): Promise<ReadonlySet<string>> =>
  snap.derive('heldProposals', async () => {
    const held = new Set<string>();
    for await (const page of snap.pages('multiSig.proposals')) {
      page.forEach(({ args }) => {
        const { multisigId, proposalId } = proposalKeyOf(args);
        held.add(`${multisigId}/${proposalId}`);
      });
    }
    return held;
  });

/**
 * A multisig proposal still on chain, with its call, expiry and counts: 7.0's state and vote
 * counts, or the detail before it. An upgrade that dropped one leaves it Deleted.
 */
export const multiSigProposalSeeder: Seeder<MultiSigProposal> = {
  entity: 'MultiSigProposal',
  relative: ['creatorId', 'creatorAccountId', 'extrinsicId'],
  reads: [
    'multiSig.proposals',
    'multiSig.proposalStates',
    'multiSig.proposalVoteCounts',
    'multiSig.proposalDetail',
  ],
  // 5.x's detail is the same record under its pallet's type names
  oldShapes: { 'multiSig.proposalDetail': [5000002] },
  accounts: ['creatorAccountId'],
  terminal: ({ status }) =>
    status !== MultiSigProposalStatusEnum.Active && status !== MultiSigProposalStatusEnum.Approved,
  async *rows(snap, ctx) {
    const [states, counts, details] = await Promise.all([
      snap.map('multiSig.proposalStates'),
      snap.map('multiSig.proposalVoteCounts'),
      snap.map('multiSig.proposalDetail'),
    ]);
    for await (const page of snap.pages('multiSig.proposals')) {
      yield page.flatMap(({ args, value: call }) => {
        if (!call) {
          return [];
        }
        // the items a proposal is read from share its key, in either form
        const key = args.map(String).join('/');
        const { multisigId, proposalId } = proposalKeyOf(args);
        const stateJson: unknown = states.get(key)?.value?.toJSON();
        const detail = details.get(key)?.value?.toJSON() as
          | {
              approvals: number;
              rejections: number;
              status: unknown;
              expiry: number | null;
              autoClose: boolean;
            }
          | undefined;
        const count = (counts.get(key)?.value?.toJSON() ?? detail) as
          | { approvals: number; rejections: number }
          | undefined;
        // an active proposal's expiry, a moment, from 7.0; before it the proposal's detail holds it
        const active = isObject(stateJson) && isObject(stateJson.active) ? stateJson.active : {};
        const expiry = (active.until as number | null | undefined) ?? detail?.expiry;
        return [
          MultiSigProposal.create({
            id: `${multisigId}/${proposalId}`,
            multisigId,
            proposalId,
            status:
              PROPOSAL_STATUS[variantOf(stateJson ?? detail?.status)] ??
              MultiSigProposalStatusEnum.Active,
            approvalCount: Number(count?.approvals ?? 0),
            rejectionCount: Number(count?.rejections ?? 0),
            params: {
              ...proposalParamsOf((call as unknown as { toHuman(): unknown }).toHuman()),
              expiry: expiry === undefined || expiry === null ? undefined : String(expiry),
              autoClose: detail?.autoClose,
            },
            ...created(ctx),
          }),
        ];
      });
    }
  },
};

/**
 * A signer's vote on a multisig proposal the chain still holds; from 7.0 it prunes a finished
 * proposal but leaves its votes. The chain keeps that a signer voted, not which way.
 */
export const multiSigProposalVoteSeeder: Seeder<MultiSigProposalVote> = {
  entity: 'MultiSigProposalVote',
  // from 7.0 the chain keeps that a signer voted, not which way
  relative: ['action'],
  reads: ['multiSig.votes', 'multiSig.proposals'],
  parent: { entity: 'MultiSigProposal', field: 'proposalId' },
  async *rows(snap, ctx) {
    const held = await heldProposals(snap);
    for await (const page of snap.pages('multiSig.votes')) {
      yield page.flatMap(({ args, value }) => {
        const { multisigId, index, signerKey } = voteKeyOf(args);
        const proposalId = `${multisigId}/${index}`;
        if (value?.toJSON() !== true || !held.has(proposalId)) {
          return [];
        }
        const { signerType, signerValue } = getMultiSigSigner(signerKey, ctx.block);
        return [
          MultiSigProposalVote.create({
            id: `${proposalId}/${signerValue}`,
            proposalId,
            signerId: `${multisigId}/${signerType}/${signerValue}`,
            ...created(ctx),
          }),
        ];
      });
    }
  },
};

const COMMITTEES = ['Technical', 'Upgrade'];

/**
 * A stored PIP's proposer from its raw bytes, for a PIP whose call this runtime's types can't read:
 * the proposer is the value's last field, a community member as `0x00` and an account, a committee
 * as `0x01` and its variant. A deposit under the account settles which, as a committee's ends could
 * read as a community's.
 */
const proposerOfBytes = (
  bytes: Uint8Array,
  hasDeposit: (account: string) => boolean
): Proposer | undefined => {
  const account =
    bytes.length >= 33 && bytes.at(-33) === 0
      ? encodeAddress(bytes.subarray(-32), api.registry.chainSS58)
      : undefined;
  const variant = bytes.at(-1);
  const committee = bytes.at(-2) === 1 && variant !== undefined ? COMMITTEES[variant] : undefined;
  if (account && (hasDeposit(account) || !committee)) {
    return { type: 'Community', value: account };
  }
  return committee ? { type: 'Committee', value: committee } : undefined;
};

/**
 * A PIP still on chain: its proposer and owner, deposit, metadata, state, result and place in the
 * snapshot queue. A finished PIP is there only while the chain doesn't prune them. A committee's
 * PIP has no owner: which member proposed it isn't kept.
 */
export const proposalSeeder: Seeder<Proposal> = {
  entity: 'Proposal',
  // a PIP's call can be one this runtime's types can't read
  raw: ['pips.proposals'],
  // 5.0's PIP carries its own state, which 5.1 moved to `proposalStates`
  oldShapes: { 'pips.proposals': [5000002] },
  // who proposed a committee's PIP, and when a finished one was scheduled
  relative: ['ownerId', 'executionScheduledAt'],
  reads: [
    'pips.proposals',
    'pips.deposits',
    'pips.proposalMetadata',
    'pips.proposalStates',
    'pips.proposalResult',
    'pips.pipSkipCount',
    'pips.pipToSchedule',
    'pips.snapshotQueue',
    'pips.snapshotMeta',
    'identity.keyRecords',
  ],
  // pruned once finished, when the chain prunes historical PIPs
  terminal: ({ state }) =>
    state !== ProposalStateEnum.Pending && state !== ProposalStateEnum.Scheduled,
  async *rows(snap, ctx) {
    const [deposits, metadata, states, results, skips, schedules, queue, meta, keys] =
      await Promise.all([
        snap.map('pips.deposits'),
        snap.map('pips.proposalMetadata'),
        snap.map('pips.proposalStates'),
        snap.map('pips.proposalResult'),
        snap.map('pips.pipSkipCount'),
        snap.map('pips.pipToSchedule'),
        snap.value('pips.snapshotQueue'),
        snap.value('pips.snapshotMeta'),
        storedKeys(snap),
      ]);
    const queued = new Set(
      ((queue?.toJSON() as { id: number }[] | null) ?? []).map(({ id }) => String(id))
    );
    const snapshotId = (meta?.toJSON() as { id?: number } | null)?.id;
    for await (const page of snap.pages('pips.proposals')) {
      yield page.flatMap(({ args, value, raw }) => {
        const id = args[0].toString();
        const stored = value ? undefined : optionOf(raw, 'the stored PIP');
        const proposer = value
          ? getProposerValue(memberOf(value, 'proposer'))
          : stored &&
            proposerOfBytes(codecBytes(stored), account => deposits.has(`${id}/${account}`));
        if (!proposer) {
          return [];
        }
        const community = proposer.type === 'Community';
        const deposit = community ? deposits.get(`${id}/${proposer.value}`)?.value : undefined;
        const pipMeta = metadata.get(id)?.value as unknown as Record<string, Codec> | undefined;
        const expiry = pipMeta?.expiry?.toJSON() as { some?: number } | null | undefined;
        const totals = results.get(id)?.value?.toJSON() as
          | { ayesStake?: number | string; naysStake?: number | string }
          | undefined;
        const state = states.get(id)?.value ?? (value && memberOf(value, 'state'));
        const snapshotted = queued.has(id);
        const text = (bytes?: Codec) =>
          bytes && !bytes.isEmpty ? bytesToString(bytes) : undefined;
        return [
          Proposal.create({
            id: padNumericId(id),
            proposer,
            state: state ? (getTextValue(state) as ProposalStateEnum) : ProposalStateEnum.Pending,
            ownerId: community ? keys.get(proposer.value)?.did : undefined,
            balance: deposit
              ? BigInt((deposit.toJSON() as { amount: number | string }).amount)
              : BigInt(0),
            url: text(pipMeta?.url),
            description: text(pipMeta?.description),
            snapshotted,
            snapshotId: snapshotted ? snapshotId : undefined,
            skippedCount: skips.get(id)?.value
              ? Number(skips.get(id)?.value?.toString())
              : undefined,
            executionScheduledAt: schedules.get(id)?.value
              ? Number(schedules.get(id)?.value?.toString())
              : undefined,
            expiresAt: expiry?.some ?? undefined,
            totalAyeWeight: BigInt(totals?.ayesStake ?? 0),
            totalNayWeight: BigInt(totals?.naysStake ?? 0),
            ...created(ctx),
          }),
        ];
      });
    }
  },
};

/** An account's vote on a PIP still on chain, a community proposer's deposit among them */
export const proposalVoteSeeder: Seeder<ProposalVote> = {
  entity: 'ProposalVote',
  reads: ['pips.proposalVotes'],
  parent: { entity: 'Proposal', field: 'proposalId' },
  accounts: ['accountId'],
  async *rows(snap, ctx) {
    for await (const page of snap.pages('pips.proposalVotes')) {
      yield page.flatMap(({ args, value }) => {
        if (!value) {
          return [];
        }
        const pipId = padNumericId(args[0].toString());
        const [vote, weight] = value.toJSON() as [boolean, number | string];
        return [
          ProposalVote.create({
            id: `${pipId}/${args[1].toString()}`,
            proposalId: pipId,
            accountId: args[1].toString(),
            vote,
            weight: BigInt(weight),
            ...created(ctx),
          }),
        ];
      });
    }
  },
};

/** The paying-key authorization: `AddRelayerPayingKey` before 8.0, `OldAddRelayerPayingKey` from it */
const PAYING_KEY_OFFERS = new Set(['addRelayerPayingKey', 'oldAddRelayerPayingKey']);

/**
 * A subsidy: an accepted one from `relayer.subsidies`, with the allowance left; one awaiting
 * acceptance from `relayer.pendingSubsidies` (8.0), or from a paying-key authorization still
 * pending, as offers were made before 8.0. What a subsidy paid out before isn't kept.
 */
export const subsidySeeder: Seeder<Subsidy> = {
  entity: 'Subsidy',
  relative: ['totalDebited'],
  reads: ['relayer.subsidies', 'relayer.pendingSubsidies', 'identity.authorizations'],
  accounts: ['beneficiaryAccountId', 'payingAccountId'],
  terminal: ({ isRemoved }) => isRemoved,
  async *rows(snap, ctx) {
    const row = (user: string, payer: string, allowance: bigint, isAccepted: boolean) =>
      Subsidy.create({
        id: `${user}/${payer}`,
        beneficiaryAccountId: user,
        payingAccountId: payer,
        allowance,
        totalDebited: undefined,
        isAccepted,
        isRemoved: false,
        ...created(ctx),
      });
    const rows = new Map<string, Subsidy>();
    for await (const page of snap.pages('relayer.subsidies')) {
      page.forEach(({ args, value }) => {
        if (value) {
          const { payingKey, remaining } = value.toJSON() as {
            payingKey: string;
            remaining: number | string;
          };
          const subsidy = row(args[0].toString(), payingKey, BigInt(remaining), true);
          rows.set(subsidy.id, subsidy);
        }
      });
    }
    const offer = (user: string, payer: string, limit: bigint) => {
      // an accepted subsidy stays: the chain goes on paying from it until a new offer is accepted
      if (!rows.get(`${user}/${payer}`)?.isAccepted) {
        rows.set(`${user}/${payer}`, row(user, payer, limit, false));
      }
    };
    // before 8.0 each offer is an authorization of its own, and a pair shows the latest of them
    const latest = new Map<
      string,
      { authId: number; user: string; payer: string; limit: bigint }
    >();
    for await (const page of snap.pages('identity.authorizations')) {
      page.forEach(({ args, value }) => {
        const data = value && memberOf(value, 'authorizationData');
        if (data && PAYING_KEY_OFFERS.has(getFirstKeyFromJson(data))) {
          const [user, payer, limit] = (
            data.toJSON() as Record<string, [string, string, number | string]>
          )[getFirstKeyFromJson(data)];
          const authId = Number(args[1].toString());
          if (authId > (latest.get(`${user}/${payer}`)?.authId ?? -1)) {
            latest.set(`${user}/${payer}`, { authId, user, payer, limit: BigInt(limit) });
          }
        }
      });
    }
    latest.forEach(({ user, payer, limit }) => offer(user, payer, limit));
    // from 8.0 an offer is a pendingSubsidies entry, which wins over one made before
    for await (const page of snap.pages('relayer.pendingSubsidies')) {
      page.forEach(({ args, value }) => {
        if (value) {
          offer(args[0].toString(), args[1].toString(), BigInt(value.toString()));
        }
      });
    }
    yield* pagesOf([...rows.values()]);
  },
};
