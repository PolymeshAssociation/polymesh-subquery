import { SubstrateBlock } from '@subql/types';
import { getBlockContext } from '../mappings/blockContext';

/**
 * The account that authored `block` — the one a fee is paid to.
 *
 * Every Polymesh runtime routes transaction and protocol fees to the block author, and before v8 it
 * did so without an event, so the ledger has to name the author itself. The chain resolves it the
 * same way: the BABE pre-runtime digest carries the slot's authority index, and that index points
 * into the session's validator set. Read at this block's own state, which on the first block of a
 * session is already the incoming set — the one the digest indexes into. Checked against the
 * reference derivation across every era of testnet, session boundaries included.
 *
 * `undefined` when the block names no BABE author, which the chain treats the same way: with no
 * author the fee is dropped rather than paid to anyone.
 */
export const blockAuthor = async (block: SubstrateBlock): Promise<string | undefined> => {
  const context = getBlockContext(block);

  if (context.author !== undefined) {
    return context.author ?? undefined;
  }

  context.author = null;

  for (const log of block.block.header.digest.logs) {
    if (!log.isPreRuntime) {
      continue;
    }

    const [engine, data] = log.asPreRuntime;

    if (!engine.isBabe) {
      continue;
    }

    const digest = api.registry.createType('RawBabePreDigest', data) as unknown as {
      value: { authorityIndex: { toNumber(): number } };
    };
    const validators = await api.query.session.validators();
    const author = (validators as unknown as { toString(): string }[])[
      digest.value.authorityIndex.toNumber()
    ];

    context.author = author ? author.toString() : null;
    break;
  }

  return context.author ?? undefined;
};
