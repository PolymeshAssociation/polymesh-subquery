import {
  handleCaInitiated,
  handleCaLinkedToDoc,
  handleCaRemoved,
  handleRecordDateChanged,
} from '../../src/mappings/entities/assets/mapCorporateAction';
import { codec, mockStore, tupleEvent } from './helpers';

const ASSET_ID = '0xasset000000000000000000000000';
const DID_A = TEST_DID;
const DID_B = '0x0200000000000000000000000000000000000000000000000000000000000000';

const caIdCodec = (localId = 0) => codec({ assetId: ASSET_ID, local_id: localId });

const corporateActionCodec = (overrides: Record<string, unknown> = {}) =>
  codec({
    kind: 'IssuerNotice',
    declDate: 1_700_000_000_000,
    recordDate: null,
    targets: { identities: [], treatment: 'Exclude' },
    defaultWithholdingTax: 100_000,
    withholdingTax: [],
    ...overrides,
  });

describe('handleCaInitiated', () => {
  it('creates a CorporateAction with an Exclude treatment and a per-DID withholding tax override', async () => {
    const db = mockStore();

    const event = tupleEvent({
      section: 'corporateAction',
      method: 'CAInitiated',
      data: [
        codec(DID_A),
        caIdCodec(0),
        corporateActionCodec({
          targets: { identities: [DID_B], treatment: 'Exclude' },
          withholdingTax: [[DID_B, 50_000]],
        }),
        codec('Annual dividend'),
      ],
    });

    await handleCaInitiated(event);

    const ca = db.CorporateAction[`${ASSET_ID}/0`];

    expect(ca).toMatchObject({
      assetId: ASSET_ID,
      localId: 0,
      kind: 'IssuerNotice',
      targetTreatment: 'Exclude',
      targetIdentities: [DID_B],
      defaultWithholdingTax: BigInt(100_000),
      didWithholdingTax: [{ did: DID_B, tax: '50000' }],
      isRemoved: false,
      details: 'Annual dividend',
    });
  });

  it('falls back to Other for an unrecognised kind and records an anomaly', async () => {
    const db = mockStore();

    const event = tupleEvent({
      section: 'corporateAction',
      method: 'CAInitiated',
      data: [
        codec(DID_A),
        caIdCodec(1),
        corporateActionCodec({ kind: 'SomeFutureKind' }),
        codec(''),
      ],
    });

    await handleCaInitiated(event);

    expect(db.CorporateAction[`${ASSET_ID}/1`]).toMatchObject({ kind: 'Other' });
    expect(Object.keys(db.IndexerAnomaly ?? {})).toHaveLength(1);
  });

  it('reads a pre-metadata-v14 snake_case CorporateAction struct (testnet block 90,693 repro)', async () => {
    // Real event from the testnet genesis-sync crash: blocks before metadata v14 decode this
    // struct via `polymesh-types`, so `toJSON()` keys are snake_case, not the camelCase a v14+
    // metadata decode produces (see `corporateActionCodec` above).
    const db = mockStore();

    const event = tupleEvent({
      section: 'corporateAction',
      method: 'CAInitiated',
      data: [
        codec(DID_A),
        caIdCodec(0),
        codec({
          kind: 'PredictableBenefit',
          decl_date: 1_634_298_006_000,
          record_date: { date: 1_634_298_006_000, checkpoint: { existing: 1 } },
          targets: { identities: [], treatment: 'Exclude' },
          default_withholding_tax: 0,
          withholding_tax: [],
        }),
        codec(''),
      ],
    });

    await handleCaInitiated(event);

    expect(db.CorporateAction[`${ASSET_ID}/0`]).toMatchObject({
      kind: 'PredictableBenefit',
      declarationDate: new Date(1_634_298_006_000),
      recordDate: new Date(1_634_298_006_000),
      defaultWithholdingTax: BigInt(0),
      didWithholdingTax: [],
    });
  });
});

describe('handleCaRemoved', () => {
  it('sets isRemoved without deleting the row', async () => {
    const db = mockStore({
      CorporateAction: { [`${ASSET_ID}/0`]: { id: `${ASSET_ID}/0`, isRemoved: false } },
    });

    const event = tupleEvent({
      section: 'corporateAction',
      method: 'CARemoved',
      data: [codec(DID_A), caIdCodec(0)],
    });

    await handleCaRemoved(event);

    expect(db.CorporateAction[`${ASSET_ID}/0`].isRemoved).toBe(true);
  });
});

describe('handleRecordDateChanged', () => {
  it('resolves the record date from the CorporateAction struct', async () => {
    const db = mockStore({
      CorporateAction: { [`${ASSET_ID}/0`]: { id: `${ASSET_ID}/0`, recordDate: undefined } },
    });

    const event = tupleEvent({
      section: 'corporateAction',
      method: 'RecordDateChanged',
      data: [
        codec(DID_A),
        caIdCodec(0),
        corporateActionCodec({ recordDate: { date: 1_700_100_000_000 } }),
      ],
    });

    await handleRecordDateChanged(event);

    expect(db.CorporateAction[`${ASSET_ID}/0`].recordDate).toEqual(new Date(1_700_100_000_000));
  });

  it('does not silently clear recordDate on a pre-v14 snake_case struct', async () => {
    const db = mockStore({
      CorporateAction: {
        [`${ASSET_ID}/0`]: { id: `${ASSET_ID}/0`, recordDate: new Date(1_600_000_000_000) },
      },
    });

    const event = tupleEvent({
      section: 'corporateAction',
      method: 'RecordDateChanged',
      data: [codec(DID_A), caIdCodec(0), codec({ record_date: { date: 1_700_100_000_000 } })],
    });

    await handleRecordDateChanged(event);

    expect(db.CorporateAction[`${ASSET_ID}/0`].recordDate).toEqual(new Date(1_700_100_000_000));
  });

  /**
   * `CACheckpoint` is `Existing(CheckpointId)` or `Scheduled(ScheduleId, moment)`. The `Existing`
   * half names a checkpoint that already exists, so the relation resolves from the event alone;
   * the `Scheduled` half names one that does not exist yet and is linked from `CheckpointCreated`.
   */
  it('links the checkpoint a record date names when it already exists', async () => {
    const db = mockStore({
      CorporateAction: { [`${ASSET_ID}/0`]: { id: `${ASSET_ID}/0` } },
    });

    await handleRecordDateChanged(
      tupleEvent({
        section: 'corporateAction',
        method: 'RecordDateChanged',
        data: [
          codec(DID_A),
          caIdCodec(0),
          corporateActionCodec({
            recordDate: { date: 1_700_100_000_000, checkpoint: { existing: 7 } },
          }),
        ],
      })
    );

    expect(db.CorporateAction[`${ASSET_ID}/0`].checkpointId).toBe(`${ASSET_ID}/7`);
  });

  it('leaves the checkpoint unlinked when the record date only names a schedule', async () => {
    const db = mockStore({
      CorporateAction: { [`${ASSET_ID}/0`]: { id: `${ASSET_ID}/0` } },
    });

    await handleRecordDateChanged(
      tupleEvent({
        section: 'corporateAction',
        method: 'RecordDateChanged',
        data: [
          codec(DID_A),
          caIdCodec(0),
          corporateActionCodec({
            recordDate: { date: 1_700_100_000_000, checkpoint: { scheduled: [3, 1_700_000_000] } },
          }),
        ],
      })
    );

    expect(db.CorporateAction[`${ASSET_ID}/0`].checkpointId).toBeUndefined();
  });
});

describe('handleCaLinkedToDoc', () => {
  it('appends document ids without duplicating', async () => {
    const db = mockStore({
      CorporateAction: {
        [`${ASSET_ID}/0`]: { id: `${ASSET_ID}/0`, documents: ['1'] },
      },
    });

    const event = tupleEvent({
      section: 'corporateAction',
      method: 'CALinkedToDoc',
      data: [codec(DID_A), caIdCodec(0), codec([1, 2])],
    });

    await handleCaLinkedToDoc(event);

    expect(db.CorporateAction[`${ASSET_ID}/0`].documents).toEqual(['1', '2']);
  });
});
