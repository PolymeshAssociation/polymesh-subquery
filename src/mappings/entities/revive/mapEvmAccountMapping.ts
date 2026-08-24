import { ethereumEncode } from '@polkadot/util-crypto';
import { Account, EvmAccountMapping } from '../../../types';

interface UpsertArgs {
  /** the H160 `pallet_revive` addresses the account by, in any casing */
  evmAddress: string;
  /** SS58 address of the account that registered the mapping */
  address: string;
  mapped: boolean;
  datetime: Date;
  blockId: string;
}

/**
 * Records the `H160 -> AccountId32` mapping maintained by `revive.mapAccount`.
 *
 * Neither `revive.mapAccount` nor `revive.unmapAccount` emits an event, and the pallet's genesis
 * config seeds the map directly, so this is driven from the extrinsic and from genesis state
 * rather than from an event handler
 */
export const upsertEvmAccountMapping = async ({
  evmAddress,
  address,
  mapped,
  datetime,
  blockId,
}: UpsertArgs): Promise<void> => {
  // stored checksummed so it can be joined against `Account.evmAddress`, which is case sensitive
  const id = ethereumEncode(evmAddress);

  /**
   * Accounts are only indexed once they are attached to an Identity, so the relation is left
   * unset for a key that has not been seen yet
   */
  const account = await Account.get(address);
  const existing = await EvmAccountMapping.get(id);

  if (existing) {
    existing.address = address;
    existing.accountId = account?.id;
    existing.mapped = mapped;
    existing.updatedBlockId = blockId;

    return existing.save();
  }

  return EvmAccountMapping.create({
    id,
    evmAddress: id,
    address,
    accountId: account?.id,
    mapped,
    datetime,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};
