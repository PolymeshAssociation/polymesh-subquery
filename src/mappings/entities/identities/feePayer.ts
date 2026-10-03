import { SubstrateBlock, SubstrateExtrinsic } from '@subql/types';
import { AnomalyKind, Authorization, Identity } from '../../../types';
import { padNumericId } from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';
import { storageAtParent } from '../../../utils/storageAtParent';

/**
 * Who paid a transaction fee up to v5.4.0, before any relayer subsidy: before v5.4 the fee was
 * announced by nothing, and v5.4.0 announced it against the signer (see `resolveFeeAccount`).
 *
 * Mirrors the runtime's `CddHandler::get_valid_payer`, which is the same from spec 3000 (v4.0.0)
 * through v5.4.x. Most calls are paid by their signer. A few are paid by someone the call names:
 * an invitation is paid for by the identity that issued it, and a multisig proposal by the identity
 * the multisig belongs to, each through that identity's primary key. That is how a key with no
 * identity of its own can accept one. Only the outer call is matched, so the same call inside a
 * batch is paid by its signer.
 *
 * The runtime decides this before the call runs, against the state the block started from, so that
 * is where it is read: by the time the fee is posted, `accept_primary_key` has already replaced the
 * primary key it was charged to, and an accepted invitation is consumed.
 */

/** Calls paid by the primary key of whoever issued the authorization they accept, by its id argument. */
const AUTH_ISSUER_PAYS: Record<string, string> = {
  'identity.joinidentityaskey': 'authid',
  'identity.acceptprimarykey': 'rotationauthid',
  'identity.rotateprimarykeytosecondary': 'authid',
  'multisig.acceptmultisigsigneraskey': 'authid',
  'relayer.acceptpayingkey': 'authid',
};

/** Calls paid by the primary key of the identity the multisig they name belongs to. */
const MULTISIG_PAYS = new Set([
  'multisig.createorapproveproposalaskey',
  'multisig.createproposalaskey',
  'multisig.approveaskey',
  'multisig.rejectaskey',
]);

/** Calls paid as a call on the bridge's controller multisig. */
const BRIDGE_PAYS = new Set(['bridge.proposebridgetx', 'bridge.batchproposebridgetx']);

/**
 * A field by name, whatever casing or leading underscore the runtime's metadata gave it. Call
 * arguments are snake-cased (`auth_id`, `_auth_issuer_pays`), and so is decoded storage before
 * metadata v14 (`authorized_by`, `primary_key`); from v14 storage decodes camel-cased.
 */
const field = (record: Record<string, unknown> | null | undefined, name: string): unknown =>
  Object.entries(record ?? {}).find(([key]) => key.replace(/_/g, '').toLowerCase() === name)?.[1];

const primaryKeyOf = async (block: SubstrateBlock, did: string): Promise<string | undefined> => {
  const record = (await storageAtParent(block, 'identity', 'didRecords', did))?.toJSON() as
    | Record<string, unknown>
    | null
    | undefined;

  return (
    (field(record, 'primarykey') as string | null | undefined) ??
    (await Identity.get(did))?.primaryAccount
  );
};

/** The primary key of whoever issued authorization `authId`, addressed to `signer`. */
const authIssuerPrimaryKey = async (
  block: SubstrateBlock,
  signer: string,
  authId: string | number
): Promise<string | undefined> => {
  const auth = (
    await storageAtParent(block, 'identity', 'authorizations', { Account: signer }, authId)
  )?.toJSON() as Record<string, unknown> | null | undefined;

  // An invitation issued earlier in this same block isn't in the parent's state; the index already
  // holds it, from that earlier extrinsic's events.
  const issuer =
    (field(auth, 'authorizedby') as string | undefined) ??
    (await Authorization.get(padNumericId(authId.toString())))?.fromId;

  return issuer ? primaryKeyOf(block, issuer) : undefined;
};

const multisigPrimaryKey = async (
  block: SubstrateBlock,
  multisig: unknown
): Promise<string | undefined> => {
  const did = (
    await storageAtParent(block, 'multiSig', 'multiSigToIdentity', multisig)
  )?.toString();

  return did ? primaryKeyOf(block, did) : undefined;
};

export const resolveFeePayer = async (extrinsic: SubstrateExtrinsic): Promise<string> => {
  const { block } = extrinsic;
  const signer = extrinsic.extrinsic.signer.toString();
  const { section, method } = extrinsic.extrinsic.method;
  const call = `${section}.${method}`.toLowerCase();

  const special =
    call in AUTH_ISSUER_PAYS ||
    call === 'identity.removeauthorization' ||
    MULTISIG_PAYS.has(call) ||
    BRIDGE_PAYS.has(call);

  if (!special) {
    return signer;
  }

  let payer: string | undefined;
  let failure = 'could not find who the runtime charged its fee to';

  // Never thrown into the fee path: a decode failure is deterministic, so the block would be retried
  // forever and indexing would stop. One fee charged to the signer, and recorded as such, is the
  // smaller harm; the reconciler then sees the difference.
  try {
    const args =
      (extrinsic.extrinsic.method.toJSON() as { args?: Record<string, unknown> }).args ?? {};

    if (call in AUTH_ISSUER_PAYS) {
      payer = await authIssuerPrimaryKey(
        block,
        signer,
        field(args, AUTH_ISSUER_PAYS[call]) as string | number
      );
    } else if (call === 'identity.removeauthorization') {
      if (field(args, 'authissuerpays') !== true) {
        return signer;
      }
      payer = await authIssuerPrimaryKey(block, signer, field(args, 'authid') as string | number);
    } else if (MULTISIG_PAYS.has(call)) {
      payer = await multisigPrimaryKey(block, field(args, 'multisig'));
    } else {
      const controller = (await storageAtParent(block, 'bridge', 'controller'))?.toString();
      payer = controller ? await multisigPrimaryKey(block, controller) : undefined;
    }
  } catch (error) {
    failure = `could not read who the runtime charged its fee to (${(error as Error).message})`;
  }

  if (!payer) {
    await recordAnomaly({
      kind: AnomalyKind.UnreadableValue,
      detail: `${section}.${method} by ${signer}: ${failure}, so it was charged to the signer`,
      block,
      eventIdx: undefined,
    });
    return signer;
  }

  return payer;
};
