import { SubstrateEvent } from '@subql/types';
import { ConfidentialCurveTreeLeaf, ConfidentialCurveTreeEnum, EventIdEnum } from '../../../types';
import { getBigIntValue } from '../../../utils';
import { extractArgs } from '../common';

const treeForEventId = (eventId: EventIdEnum): ConfidentialCurveTreeEnum => {
  switch (eventId) {
    case EventIdEnum.AccountStateLeafInserted:
      return ConfidentialCurveTreeEnum.Account;
    case EventIdEnum.FeeAccountStateLeafInserted:
      return ConfidentialCurveTreeEnum.FeeAccount;
    case EventIdEnum.AssetStateLeafUpdated:
      return ConfidentialCurveTreeEnum.Asset;
    default:
      throw new Error(`Unhandled confidential curve tree event: ${eventId}`);
  }
};

/**
 * Handles `AccountStateLeafInserted`, `FeeAccountStateLeafInserted` and `AssetStateLeafUpdated`
 * events, storing the leaves of the confidential asset curve trees. The account and fee account
 * trees are append only, while asset tree leaves can be updated in place
 */
export const handleConfidentialCurveTreeLeafUpdated = async (
  event: SubstrateEvent
): Promise<void> => {
  const { params, eventId, eventIdx, blockId, blockEventId } = extractArgs(event);

  const [rawLeafIndex, rawLeafValue] = params;

  const tree = treeForEventId(eventId);
  const leafIndex = getBigIntValue(rawLeafIndex);
  const value = rawLeafValue.toHex();

  const id = `${tree}/${leafIndex}`;

  const leaf = await ConfidentialCurveTreeLeaf.get(id);

  if (leaf) {
    leaf.value = value;
    leaf.eventIdx = eventIdx;
    leaf.updatedBlockId = blockId;

    await leaf.save();
  } else {
    await ConfidentialCurveTreeLeaf.create({
      id,
      tree,
      leafIndex,
      value,
      eventIdx,
      createdBlockId: blockId,
      updatedBlockId: blockId,
      createdEventId: blockEventId,
    }).save();
  }
};
