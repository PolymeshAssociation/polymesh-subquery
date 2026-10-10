import { EventReference, EventReferenceKind } from '../../types';
import { getAssetIdForLegacyTicker, padId } from '../../utils';
import { RawReference } from './encode';

/** From v7.0 a ticker is a registration that can be linked to any asset; events name the asset. */
export const TICKER_IS_ASSET_BEFORE = 7_000_000;

const KIND: Record<Exclude<RawReference['kind'], 'ticker'>, EventReferenceKind> = {
  identity: EventReferenceKind.Identity,
  account: EventReferenceKind.Account,
  asset: EventReferenceKind.Asset,
  portfolio: EventReferenceKind.Portfolio,
};

/** The `EventReference` rows for an event's references, one per distinct kind and value. */
export const toEventReferences = async (
  raw: RawReference[],
  eventId: string,
  specVersion: number
): Promise<EventReference[]> => {
  const seen = new Set<string>();
  const rows: EventReference[] = [];

  for (const ref of raw) {
    let kind: EventReferenceKind;
    let value = ref.value;

    if (ref.kind === 'ticker') {
      if (specVersion >= TICKER_IS_ASSET_BEFORE) {
        continue;
      }
      kind = EventReferenceKind.Asset;
      value = await getAssetIdForLegacyTicker(ref.value);
    } else {
      kind = KIND[ref.kind];
    }

    const key = `${kind}/${value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    rows.push(
      EventReference.create({
        id: `${eventId}/${padId(String(rows.length))}`,
        eventId,
        kind,
        value,
        argument: ref.argument,
      })
    );
  }

  return rows;
};
