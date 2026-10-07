import { LAST_V6 } from './consts';
import { discontinuedAt, registerShape } from './registry';

/**
 * `multiSig` pallet parameter shapes, for the tuple-style events before v7.0.0.
 *
 * From v7.0.0 every multisig event names its fields, so it decodes from the block's own metadata
 * and nothing is declared for that era here. The names below are v7's own, so a handler reads one
 * set of names on either side of the boundary. Arities were probed against testnet metadata from
 * v3.0 through v6.x, and are unchanged across that range.
 *
 * Two events changed meaning, not only shape, at v7.0.0. Before it, `ProposalApproved` was one
 * signer's approving vote — `(did, multisig, signer, proposalId)`; from it, that is
 * `ProposalApprovalVote`, and `ProposalApproved` means the proposal reached its threshold. And
 * `MultiSigSignaturesRequiredChanged` became `MultiSigSignersRequiredChanged`.
 */
registerShape(
  'multiSig',
  'MultiSigCreated',
  discontinuedAt(LAST_V6, ['callerDid', 'multisig', 'caller', 'signers', 'sigsRequired'])
);
registerShape(
  'multiSig',
  'MultiSigSignerAdded',
  discontinuedAt(LAST_V6, ['callerDid', 'multisig', 'signer'])
);
registerShape(
  'multiSig',
  'MultiSigSignerAuthorized',
  discontinuedAt(LAST_V6, ['callerDid', 'multisig', 'signer'])
);
registerShape(
  'multiSig',
  'MultiSigSignerRemoved',
  discontinuedAt(LAST_V6, ['callerDid', 'multisig', 'signer'])
);
registerShape(
  'multiSig',
  'MultiSigSignaturesRequiredChanged',
  discontinuedAt(LAST_V6, ['callerDid', 'multisig', 'sigsRequired'])
);
registerShape(
  'multiSig',
  'ProposalAdded',
  discontinuedAt(LAST_V6, ['callerDid', 'multisig', 'proposalId'])
);
registerShape(
  'multiSig',
  'ProposalApproved',
  discontinuedAt(LAST_V6, ['callerDid', 'multisig', 'signer', 'proposalId'])
);
registerShape(
  'multiSig',
  'ProposalRejectionVote',
  discontinuedAt(LAST_V6, ['callerDid', 'multisig', 'signer', 'proposalId'])
);
registerShape(
  'multiSig',
  'ProposalRejected',
  discontinuedAt(LAST_V6, ['callerDid', 'multisig', 'proposalId'])
);
registerShape(
  'multiSig',
  'ProposalExecuted',
  discontinuedAt(LAST_V6, ['callerDid', 'multisig', 'proposalId', 'result'])
);
