/**
 * Asset metadata (defect G13), asset-type changes, and the v8 account-side CreatedAssetTransfer.
 * SetAssetMetadataValue / ...Details do not carry the metadata key — it is recovered from the
 * direct setAssetMetadata call args, else from a RegisterAssetMetadata*Type event in the same
 * extrinsic (the register-and-set path), and only an unrecognised wrapper is recorded and dropped.
 */

import { SubstrateEvent } from '@subql/types';
import {
  handleAssetTypeChanged,
  handleLocalMetadataKeyDeleted,
  handleMetadataValueDeleted,
  handleRegisterAssetMetadataLocalType,
  handleSetAssetMetadataValue,
} from '../../src/mappings/entities/assets/mapAssetMetadata';
import { handleCreatedAssetTransfer } from '../../src/mappings/entities/assets/mapAsset';

const ASSET = '0xasset000000000000000000000000000';

const storeGet = (): jest.Mock => (globalThis as any).store.get as jest.Mock;
const storeSet = (): jest.Mock => (globalThis as any).store.set as jest.Mock;
const storeRemove = (): jest.Mock => (globalThis as any).store.remove as jest.Mock;

const codec = (value: unknown, opts: { isEmpty?: boolean } = {}) => ({
  isEmpty: opts.isEmpty ?? false,
  toString: () => (typeof value === 'string' ? value : JSON.stringify(value)),
  toJSON: () => value,
});

const unnamedMeta = (values: unknown[]) => ({
  fields: values.map(() => ({
    name: { isSome: false },
    typeName: { isSome: true, unwrap: () => codec('Dummy') },
  })),
});

/** An `EventRecord`-shaped sibling event in the same extrinsic. */
const siblingRecord = (
  method: string,
  values: ReturnType<typeof codec>[],
  extrinsicIdx: number
) => ({
  phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => extrinsicIdx } },
  event: { section: 'asset', method, data: values, meta: unnamedMeta(values) },
});

const tupleEvent = (
  method: string,
  values: ReturnType<typeof codec>[],
  extrinsic?: unknown,
  events: unknown[] = []
): SubstrateEvent =>
  ({
    idx: events.length,
    extrinsic,
    block: {
      block: { header: { number: { toString: () => '700' } } },
      specVersion: 8000000,
      timestamp: new Date('2026-04-01T00:00:00Z'),
      events,
    },
    event: {
      section: 'asset',
      method,
      data: values,
      meta: unnamedMeta(values),
    },
  } as unknown as SubstrateEvent);

const setMetadataExtrinsic = (key: unknown) => ({
  idx: 4,
  extrinsic: {
    method: { section: 'asset', method: 'setAssetMetadata' },
    args: [codec(ASSET), codec(key)],
  },
});

describe('asset metadata', () => {
  let db: Record<string, Record<string, any>>;

  beforeEach(() => {
    db = { Asset: { [ASSET]: { id: ASSET, type: 'EquityCommon' } } };
    storeGet().mockImplementation((entity: string, id: string) =>
      Promise.resolve(db[entity]?.[id])
    );
    storeSet().mockImplementation((entity: string, id: string, data: any) => {
      (db[entity] ??= {})[id] = { ...data };
      return Promise.resolve();
    });
    storeRemove().mockImplementation((entity: string, id: string) => {
      delete db[entity]?.[id];
      return Promise.resolve();
    });
    (globalThis as any).api.query = {};
  });

  it('registers a local metadata key with its name', async () => {
    await handleRegisterAssetMetadataLocalType(
      tupleEvent('RegisterAssetMetadataLocalType', [
        codec('0xdid'),
        codec(ASSET),
        codec('Prospectus'),
        codec('1'),
        codec({ url: null, description: null, typeDef: null }),
      ])
    );

    expect(db['AssetMetadata'][`${ASSET}/Local/1`]).toMatchObject({
      scope: 'Local',
      keyId: '1',
      name: 'Prospectus',
      isLocked: false,
    });
  });

  it('sets the value + lock, reading the key from the extrinsic', async () => {
    await handleSetAssetMetadataValue(
      tupleEvent(
        'SetAssetMetadataValue',
        [
          codec('0xdid'),
          codec(ASSET),
          codec('ipfs://cid'),
          codec({ expire: null, lockStatus: 'Locked' }),
        ],
        setMetadataExtrinsic({ local: 1 })
      )
    );

    expect(db['AssetMetadata'][`${ASSET}/Local/1`]).toMatchObject({
      value: 'ipfs://cid',
      isLocked: true,
    });
  });

  it('recovers the key from a sibling RegisterAssetMetadataLocalType (register-and-set path)', async () => {
    // the setter is dispatched by registerAndSetLocalAssetMetadata, not setAssetMetadata, so the
    // key is not in args[1]; the RegisterAssetMetadataLocalType event fired earlier in the same
    // extrinsic carries the new local key id (3)
    const event = tupleEvent(
      'SetAssetMetadataValue',
      [codec('0xdid'), codec(ASSET), codec('ipfs://new'), codec(null, { isEmpty: true })],
      {
        idx: 6,
        extrinsic: { method: { section: 'asset', method: 'registerAndSetLocalAssetMetadata' } },
      },
      [
        siblingRecord(
          'RegisterAssetMetadataLocalType',
          [codec('0xdid'), codec(ASSET), codec('Whitepaper'), codec('3'), codec({})],
          6
        ),
      ]
    );

    await handleSetAssetMetadataValue(event);

    expect(db['AssetMetadata'][`${ASSET}/Local/3`]).toMatchObject({
      scope: 'Local',
      keyId: '3',
      value: 'ipfs://new',
    });
    expect(storeSet().mock.calls.some(([entity]) => entity === 'IndexerAnomaly')).toBe(false);
  });

  it('records an anomaly and writes nothing only when neither the extrinsic nor a sibling resolves the key', async () => {
    await handleSetAssetMetadataValue(
      tupleEvent('SetAssetMetadataValue', [
        codec('0xdid'),
        codec(ASSET),
        codec('x'),
        codec(null, { isEmpty: true }),
      ])
    );

    expect(db['AssetMetadata']).toBeUndefined();
    expect(storeSet().mock.calls.some(([entity]) => entity === 'IndexerAnomaly')).toBe(true);
  });

  it('clears the value on MetadataValueDeleted but keeps the key row', async () => {
    db['AssetMetadata'] = {
      [`${ASSET}/Local/1`]: {
        id: `${ASSET}/Local/1`,
        assetId: ASSET,
        scope: 'Local',
        keyId: '1',
        name: 'Prospectus',
        value: 'ipfs://cid',
        isLocked: true,
      },
    };

    await handleMetadataValueDeleted(
      tupleEvent('MetadataValueDeleted', [codec('0xdid'), codec(ASSET), codec({ local: 1 })])
    );

    expect(db['AssetMetadata'][`${ASSET}/Local/1`]).toMatchObject({
      name: 'Prospectus',
      isLocked: false,
    });
    expect(db['AssetMetadata'][`${ASSET}/Local/1`].value).toBeUndefined();
  });

  it('removes the row entirely on LocalMetadataKeyDeleted', async () => {
    db['AssetMetadata'] = { [`${ASSET}/Local/1`]: { id: `${ASSET}/Local/1` } };

    await handleLocalMetadataKeyDeleted(
      tupleEvent('LocalMetadataKeyDeleted', [codec('0xdid'), codec(ASSET), codec('1')])
    );

    expect(db['AssetMetadata'][`${ASSET}/Local/1`]).toBeUndefined();
  });

  it('AssetTypeChanged updates Asset.type', async () => {
    await handleAssetTypeChanged(
      tupleEvent('AssetTypeChanged', [codec('0xdid'), codec(ASSET), codec('Derivative')])
    );

    expect(db['Asset'][ASSET].type).toBe('Derivative');
  });
});

describe('handleCreatedAssetTransfer', () => {
  let db: Record<string, Record<string, any>>;

  beforeEach(() => {
    db = { Asset: { [ASSET]: { id: ASSET } } };
    storeGet().mockImplementation((entity: string, id: string) =>
      Promise.resolve(db[entity]?.[id])
    );
    storeSet().mockImplementation((entity: string, id: string, data: any) => {
      (db[entity] ??= {})[id] = { ...data };
      return Promise.resolve();
    });
    (globalThis as any).api.query = {};
  });

  it('writes an account-side AssetTransaction and links the pending instruction', async () => {
    await handleCreatedAssetTransfer(
      tupleEvent(
        'CreatedAssetTransfer',
        [
          codec(ASSET),
          codec('5From000000000000000000000000000000000000000000000'),
          codec('5To00000000000000000000000000000000000000000000000'),
          codec('4200'),
          codec(null, { isEmpty: true }),
          codec('91'),
        ],
        { idx: 2, extrinsic: { method: { section: 'asset', method: 'transferAssetFrom' } } }
      )
    );

    const [row] = Object.values(db['AssetTransaction']);
    expect(row).toMatchObject({
      assetId: ASSET,
      fromAccount: '5From000000000000000000000000000000000000000000000',
      toAccount: '5To00000000000000000000000000000000000000000000000',
      amount: BigInt(4200),
      instructionId: '91',
      eventId: 'CreatedAssetTransfer',
    });
    expect(row.fromPortfolioId).toBeUndefined();
  });

  it('leaves instruction null when there is no pending transfer id', async () => {
    await handleCreatedAssetTransfer(
      tupleEvent('CreatedAssetTransfer', [
        codec(ASSET),
        codec('5From000000000000000000000000000000000000000000000'),
        codec('5To00000000000000000000000000000000000000000000000'),
        codec('10'),
        codec(null, { isEmpty: true }),
        codec(null, { isEmpty: true }),
      ])
    );

    const [row] = Object.values(db['AssetTransaction']);
    expect(row.instructionId).toBeUndefined();
  });
});
