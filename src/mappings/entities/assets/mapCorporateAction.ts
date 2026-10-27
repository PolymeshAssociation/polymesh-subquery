import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { CorporateAction, CorporateActionKind, DidTax, TargetTreatment } from '../../../types';
import { extractNumber, extractString, extractValue, getCaIdValue } from '../../../utils';
import { extractArgs, getOrAnomaly, toEnum } from '../common';
import { storedText } from '../../../utils/text';

/**
 * The `CorporateAction` struct, identical in shape v5.4.3 through v8.0.0
 * (docs/reference/event-shape-verification.md) — but not in *casing*: blocks before metadata v14
 * (testnet 1–4,397,817, spec 3000–3010; mainnet had the same pre-5.0 gap) decode this struct via
 * `polymesh-types`, whose `toJSON()` produces snake_case keys (`default_withholding_tax`,
 * `decl_date`, `record_date`, `withholding_tax`) instead of the camelCase a v14+ metadata decode
 * produces. `extractNumber`/`extractString`/`extractValue` (see `getCaIdValue`'s `local_id`) check
 * the snake_case key first and fall back to camelCase, so this reads correctly either way.
 */
/**
 * `RecordDate { date, checkpoint }`, where `CACheckpoint` is `Scheduled(ScheduleId, u64)` or
 * `Existing(CheckpointId)`.
 */
interface RawRecordDate {
  date: number;
  checkpoint?: { existing?: number; Existing?: number } | string | null;
}

interface RawCorporateAction {
  kind: string;
  declDate: number;
  recordDate: RawRecordDate | null;
  targets: { identities: string[]; treatment: string };
  defaultWithholdingTax: number;
  withholdingTax: [string, number][];
}

const decodeCorporateAction = (raw: unknown): RawCorporateAction => ({
  kind: extractString(raw, 'kind'),
  declDate: extractNumber(raw, 'decl_date'),
  recordDate: extractValue(raw, 'record_date') ?? null,
  targets: extractValue(raw, 'targets'),
  defaultWithholdingTax: extractNumber(raw, 'default_withholding_tax'),
  withholdingTax: extractValue(raw, 'withholding_tax'),
});

/** A corporate action's id, which its ballot, if any, shares. */
export const caId = (assetId: string, localId: number): string => `${assetId}/${localId}`;

/**
 * The `Checkpoint` a record date names, when it names one that already exists.
 *
 * `Existing(CheckpointId)` carries the id, so the relation resolves from the event alone. The
 * `Scheduled` variant names a schedule and a moment instead, and the checkpoint it refers to does
 * not exist yet — that half is linked from the other side, when `CheckpointCreated` fires.
 */
const existingCheckpointId = (
  assetId: string,
  recordDate: RawRecordDate | null
): string | undefined => {
  const checkpoint = recordDate?.checkpoint;

  if (!checkpoint || typeof checkpoint === 'string') {
    return undefined;
  }

  const id = checkpoint.existing ?? checkpoint.Existing;

  return id === undefined ? undefined : `${assetId}/${id}`;
};

/**
 * The corporate action `rawCorporateAction` (the chain's `CorporateAction`) describes, with its
 * details and linked documents; unsaved.
 */
export const corporateActionRow = (
  assetId: string,
  localId: number,
  rawCorporateAction: Codec,
  details: string | undefined,
  documents: string[],
  {
    block,
    eventIdx,
    blockEventId,
  }: { block: SubstrateBlock; eventIdx: number; blockEventId: string }
): CorporateAction => {
  const ca = decodeCorporateAction(rawCorporateAction.toJSON());

  return CorporateAction.create({
    id: caId(assetId, localId),
    assetId,
    localId,
    kind: toEnum(CorporateActionKind, ca.kind, CorporateActionKind.Other, {
      enumName: 'CorporateActionKind',
      block,
      eventIdx,
    }),
    declarationDate: new Date(ca.declDate),
    recordDate: ca.recordDate ? new Date(ca.recordDate.date) : undefined,
    checkpointId: existingCheckpointId(assetId, ca.recordDate),
    details,
    targetIdentities: ca.targets.identities,
    // No catch-all fallback: `Include` and `Exclude` are opposites, so guessing one would invert
    // who the action applies to. `toEnum` records the unknown value; the column stays null.
    targetTreatment: toEnum(TargetTreatment, ca.targets.treatment, undefined, {
      enumName: 'TargetTreatment',
      block,
      eventIdx,
    }),
    defaultWithholdingTax: BigInt(ca.defaultWithholdingTax),
    didWithholdingTax: ca.withholdingTax.map(
      ([did, tax]): DidTax => ({ did, tax: BigInt(tax).toString() })
    ),
    documents,
    isRemoved: false,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  });
};

export const handleCaInitiated = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId, eventIdx } = extractArgs(event);
  const { caId: rawCaId, ca: rawCorporateAction, details: rawDetails } = decodeEvent(event);

  const { localId, assetId } = await getCaIdValue(rawCaId, block);

  // documents are linked later, by `CALinkedToDoc`
  await corporateActionRow(assetId, localId, rawCorporateAction, storedText(rawDetails), [], {
    block,
    eventIdx,
    blockEventId,
  }).save();
};

export const handleCaRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { caId: rawCaId } = decodeEvent(event);

  const { localId, assetId } = await getCaIdValue(rawCaId, block);

  const corporateAction = await getOrAnomaly(
    id => CorporateAction.get(id),
    caId(assetId, localId),
    'CorporateAction',
    event
  );

  if (!corporateAction) {
    return;
  }

  corporateAction.isRemoved = true;
  corporateAction.updatedEventId = blockEventId;

  await corporateAction.save();
};

export const handleRecordDateChanged = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { caId: rawCaId, ca: rawCorporateAction } = decodeEvent(event);

  const { localId, assetId } = await getCaIdValue(rawCaId, block);
  const ca = decodeCorporateAction(rawCorporateAction.toJSON());

  const corporateAction = await getOrAnomaly(
    id => CorporateAction.get(id),
    caId(assetId, localId),
    'CorporateAction',
    event
  );

  if (!corporateAction) {
    return;
  }

  corporateAction.recordDate = ca.recordDate ? new Date(ca.recordDate.date) : undefined;
  corporateAction.checkpointId = existingCheckpointId(assetId, ca.recordDate);
  corporateAction.updatedEventId = blockEventId;

  await corporateAction.save();
};

export const handleCaLinkedToDoc = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { caId: rawCaId, docIds: rawDocIds } = decodeEvent(event);

  const { localId, assetId } = await getCaIdValue(rawCaId, block);

  const corporateAction = await getOrAnomaly(
    id => CorporateAction.get(id),
    caId(assetId, localId),
    'CorporateAction',
    event
  );

  if (!corporateAction) {
    return;
  }

  const docIds = (rawDocIds.toJSON() as number[]).map(String);

  corporateAction.documents = [...new Set([...(corporateAction.documents ?? []), ...docIds])];
  corporateAction.updatedEventId = blockEventId;

  await corporateAction.save();
};
