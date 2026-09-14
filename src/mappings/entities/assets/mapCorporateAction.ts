import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import {
  CorporateAction,
  CorporateActionDefaultConfig,
  CorporateActionKind,
  DidTax,
  TargetTreatment,
} from '../../../types';
import { bytesToString, getAssetId, getCaIdValue, getTextValue } from '../../../utils';
import { extractArgs, toEnum } from '../common';

/**
 * The `CorporateAction` struct, identical in shape v5.4.3 through v8.0.0
 * (docs/reference/event-shape-verification.md).
 */
interface RawCorporateAction {
  kind: string;
  declDate: number;
  recordDate: { date: number } | null;
  targets: { identities: string[]; treatment: string };
  defaultWithholdingTax: number;
  withholdingTax: [string, number][];
}

const decodeCorporateAction = (raw: unknown): RawCorporateAction => raw as RawCorporateAction;

const caId = (assetId: string, localId: number): string => `${assetId}/${localId}`;

export const handleCaInitiated = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId, eventIdx } = extractArgs(event);
  const {
    caId: rawCaId,
    corporateAction: rawCorporateAction,
    details: rawDetails,
  } = decodeEvent(event);

  const { localId, assetId } = await getCaIdValue(rawCaId, block);
  const ca = decodeCorporateAction(rawCorporateAction.toJSON());

  await CorporateAction.create({
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
    details: bytesToString(rawDetails),
    targetIdentities: ca.targets.identities,
    targetTreatment: toEnum(TargetTreatment, ca.targets.treatment, TargetTreatment.Exclude, {
      enumName: 'TargetTreatment',
      block,
      eventIdx,
    }),
    defaultWithholdingTax: BigInt(ca.defaultWithholdingTax),
    didWithholdingTax: ca.withholdingTax.map(([did, tax]): DidTax => ({ did, tax: BigInt(tax) })),
    documents: [],
    isRemoved: false,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();
};

export const handleCaRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { caId: rawCaId } = decodeEvent(event);

  const { localId, assetId } = await getCaIdValue(rawCaId, block);

  const corporateAction = await CorporateAction.get(caId(assetId, localId));

  if (!corporateAction) {
    return;
  }

  corporateAction.isRemoved = true;
  corporateAction.updatedEventId = blockEventId;

  await corporateAction.save();
};

export const handleRecordDateChanged = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { caId: rawCaId, corporateAction: rawCorporateAction } = decodeEvent(event);

  const { localId, assetId } = await getCaIdValue(rawCaId, block);
  const ca = decodeCorporateAction(rawCorporateAction.toJSON());

  const corporateAction = await CorporateAction.get(caId(assetId, localId));

  if (!corporateAction) {
    return;
  }

  corporateAction.recordDate = ca.recordDate ? new Date(ca.recordDate.date) : undefined;
  corporateAction.updatedEventId = blockEventId;

  await corporateAction.save();
};

export const handleCaLinkedToDoc = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { caId: rawCaId, docIds: rawDocIds } = decodeEvent(event);

  const { localId, assetId } = await getCaIdValue(rawCaId, block);

  const corporateAction = await CorporateAction.get(caId(assetId, localId));

  if (!corporateAction) {
    return;
  }

  const docIds = (rawDocIds.toJSON() as number[]).map(String);

  corporateAction.documents = [...new Set([...(corporateAction.documents ?? []), ...docIds])];
  corporateAction.updatedEventId = blockEventId;

  await corporateAction.save();
};

const getOrCreateDefaultConfig = async (
  assetId: string,
  blockEventId: string
): Promise<CorporateActionDefaultConfig> => {
  let config = await CorporateActionDefaultConfig.get(assetId);

  if (!config) {
    config = CorporateActionDefaultConfig.create({
      id: assetId,
      assetId,
      createdEventId: blockEventId,
      updatedEventId: blockEventId,
    });
  }

  return config;
};

export const handleDefaultTargetIdentitiesChanged = async (
  event: SubstrateEvent
): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { assetId: rawAssetId, targets: rawTargets } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const targets = rawTargets.toJSON() as { identities: string[]; treatment: string };

  const config = await getOrCreateDefaultConfig(assetId, blockEventId);

  config.targetIdentities = targets.identities;
  config.targetTreatment = toEnum(TargetTreatment, targets.treatment, TargetTreatment.Exclude, {
    enumName: 'TargetTreatment',
    block,
  });
  config.updatedEventId = blockEventId;

  await config.save();
};

export const handleDefaultWithholdingTaxChanged = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { assetId: rawAssetId, tax: rawTax } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);

  const config = await getOrCreateDefaultConfig(assetId, blockEventId);

  config.defaultWithholdingTax = BigInt(rawTax.toJSON() as number);
  config.updatedEventId = blockEventId;

  await config.save();
};

export const handleDidWithholdingTaxChanged = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { assetId: rawAssetId, targetDid, tax: rawTax } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const did = getTextValue(targetDid);
  const tax = rawTax.toJSON() as number | null;

  const config = await getOrCreateDefaultConfig(assetId, blockEventId);
  const existing = (config.didWithholdingTax ?? []).filter(entry => entry.did !== did);

  config.didWithholdingTax = tax === null ? existing : [...existing, { did, tax: BigInt(tax) }];
  config.updatedEventId = blockEventId;

  await config.save();
};
