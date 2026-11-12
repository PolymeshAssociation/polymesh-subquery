import { SubstrateBlock } from '@subql/types';
import { getBlockContext } from '../mappings/blockContext';
import { itemsOf, memberOf } from './codec';

const readAuthor = async (block: SubstrateBlock): Promise<string | undefined> => {
  for (const log of block.block.header.digest.logs) {
    if (!log.isPreRuntime) {
      continue;
    }

    const [engine, data] = log.asPreRuntime;

    if (!engine.isBabe) {
      continue;
    }

    const digest = api.registry.createType('RawBabePreDigest', data);
    const authorityIndex = Number(memberOf(memberOf(digest, 'value'), 'authorityIndex').toString());
    const validators = itemsOf(await api.query.session.validators(), 'session.validators');

    return validators[authorityIndex]?.toString();
  }

  return undefined;
};

/**
 * The account that authored `block` — the one a fee is paid to.
 *
 * Every Polymesh runtime routes transaction and protocol fees to the block author, and before v8 it
 * did so without an event, so the ledger has to name the author itself. The chain resolves it the
 * same way: the BABE pre-runtime digest carries the slot's authority index, and that index points
 * into the session's validator set. Read at this block's own state, which on the first block of a
 * session is already the incoming set — the one the digest indexes into.
 *
 * `undefined` when the block names no BABE author, which the chain treats the same way: with no
 * author the fee is dropped rather than paid to anyone.
 */
export const blockAuthor = (block: SubstrateBlock): Promise<string | undefined> => {
  const context = getBlockContext(block);

  context.author ??= readAuthor(block);

  return context.author;
};
