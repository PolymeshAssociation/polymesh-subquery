/**
 * Asset metadata (defect G13), asset-type changes, and the v8 account-side CreatedAssetTransfer.
 * SetAssetMetadataValue / ...Details do not carry the metadata key — it is recovered from the
 * direct setAssetMetadata call args, else from a RegisterAssetMetadata*Type event in the same
 * extrinsic (the register-and-set path), and only an unrecognised wrapper is recorded and dropped.
 */

import {
  handleAssetTypeChanged,
  handleLocalMetadataKeyDeleted,
  handleMetadataValueDeleted,
  handleRegisterAssetMetadataLocalType,
  handleSetAssetMetadataValue,
  handleSetAssetMetadataValueDetails,
} from '../../src/mappings/entities/assets/mapAssetMetadata';
import { handleCreatedAssetTransfer } from '../../src/mappings/entities/assets/mapAsset';
import { codec, MockDb, mockStore, storeSet, tupleEvent } from './helpers';

const ASSET = '0xasset000000000000000000000000000';

const metaEvent = (method: string, data: unknown[], extrinsic?: unknown, events: unknown[] = []) =>
  tupleEvent({
    section: 'asset',
    method,
    data,
    blockNumber: '700',
    idx: events.length,
    extrinsic,
    events,
  });

/** An `EventRecord`-shaped sibling event in the same extrinsic. */
const siblingRecord = (method: string, values: unknown[], extrinsicIdx: number) => ({
  phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => extrinsicIdx } },
  event: metaEvent(method, values).event,
});

const setMetadataExtrinsic = (key: unknown) => ({
  idx: 4,
  extrinsic: {
    method: { section: 'asset', method: 'setAssetMetadata' },
    args: [codec(ASSET), codec(key)],
  },
});

/** A `utility.batch*` extrinsic wrapping the given calls — `toHuman()` is all the resolver reads. */
const batchExtrinsic = (
  method: string,
  calls: { section: string; method: string; args: Record<string, unknown> }[]
) => ({
  idx: 1,
  extrinsic: {
    method: { section: 'utility', method },
    toHuman: () => ({ method: { args: { calls } } }),
  },
});

const setMetadataCall = (assetId: string, key: unknown, method = 'setAssetMetadata') => ({
  section: 'asset',
  method,
  args: { asset_id: assetId, key, value: 'ipfs://batched', detail: null },
});

/** A `multiSig.approve(multisig, proposalId, weight)` extrinsic. */
const multiSigApproveExtrinsic = (multisig: string, proposalId: string) => ({
  idx: 1,
  extrinsic: {
    method: { section: 'multiSig', method: 'approve' },
    args: [codec(multisig), codec(proposalId)],
  },
});

describe('asset metadata', () => {
  let db: MockDb;

  beforeEach(() => {
    db = mockStore({ Asset: { [ASSET]: { id: ASSET, type: 'EquityCommon' } } });
  });

  it('registers a local metadata key with its name', async () => {
    await handleRegisterAssetMetadataLocalType(
      metaEvent('RegisterAssetMetadataLocalType', [
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
      metaEvent(
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
    const event = metaEvent(
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

  it('recovers the key from a setAssetMetadata call batched in a utility.batchAll extrinsic', async () => {
    await handleSetAssetMetadataValue(
      metaEvent(
        'SetAssetMetadataValue',
        [codec('0xdid'), codec(ASSET), codec('blob:cf'), codec(null, { isEmpty: true })],
        batchExtrinsic('batchAll', [
          { section: 'asset', method: 'createAsset', args: {} },
          setMetadataCall(ASSET, { Global: '5' }),
        ])
      )
    );

    expect(db['AssetMetadata'][`${ASSET}/Global/5`]).toMatchObject({
      scope: 'Global',
      keyId: '5',
      value: 'blob:cf',
    });
    expect(storeSet().mock.calls.some(([entity]) => entity === 'IndexerAnomaly')).toBe(false);
  });

  it('matches the right call by ordinal (not first-match) when a batch sets metadata for two different assets', async () => {
    const OTHER = '0xother00000000000000000000000000';
    db['Asset'][OTHER] = { id: OTHER, type: 'EquityCommon' };

    // one SetAssetMetadataValue for OTHER already fired earlier in the same extrinsic — the event
    // under test is the batch's *second* metadata call, not its first
    const priorEventForOther = siblingRecord(
      'SetAssetMetadataValue',
      [codec('0xdid'), codec(OTHER), codec('blob:other'), codec(null, { isEmpty: true })],
      1
    );

    await handleSetAssetMetadataValue(
      metaEvent(
        'SetAssetMetadataValue',
        [codec('0xdid'), codec(ASSET), codec('blob:mine'), codec(null, { isEmpty: true })],
        batchExtrinsic('batch', [
          setMetadataCall(OTHER, { Global: '9' }),
          setMetadataCall(ASSET, { Global: '5' }),
        ]),
        [priorEventForOther]
      )
    );

    expect(db['AssetMetadata'][`${ASSET}/Global/5`]).toMatchObject({ value: 'blob:mine' });
    expect(db['AssetMetadata'][`${OTHER}/Global/9`]).toBeUndefined();
  });

  it('matches the right call by ordinal when a batch sets two different keys on the same asset (asset_id alone cannot disambiguate)', async () => {
    const priorEventForFirstKey = siblingRecord(
      'SetAssetMetadataValue',
      [codec('0xdid'), codec(ASSET), codec('blob:first'), codec(null, { isEmpty: true })],
      1
    );

    await handleSetAssetMetadataValue(
      metaEvent(
        'SetAssetMetadataValue',
        [codec('0xdid'), codec(ASSET), codec('blob:second'), codec(null, { isEmpty: true })],
        batchExtrinsic('batchAll', [
          setMetadataCall(ASSET, { Global: '1' }),
          setMetadataCall(ASSET, { Global: '2' }),
        ]),
        [priorEventForFirstKey]
      )
    );

    expect(db['AssetMetadata'][`${ASSET}/Global/2`]).toMatchObject({ value: 'blob:second' });
    expect(db['AssetMetadata'][`${ASSET}/Global/1`]).toBeUndefined();
  });

  it('resolves a setAssetMetadataDetails call batched alongside a setAssetMetadata call', async () => {
    db['AssetMetadata'] = {
      [`${ASSET}/Global/5`]: {
        id: `${ASSET}/Global/5`,
        assetId: ASSET,
        scope: 'Global',
        keyId: '5',
      },
    };
    const priorEventForValue = siblingRecord(
      'SetAssetMetadataValue',
      [codec('0xdid'), codec(ASSET), codec('blob:cf'), codec(null, { isEmpty: true })],
      1
    );

    await handleSetAssetMetadataValueDetails(
      metaEvent(
        'SetAssetMetadataValueDetails',
        [codec('0xdid'), codec(ASSET), codec({ expire: null, lockStatus: 'Locked' })],
        batchExtrinsic('batchAll', [
          setMetadataCall(ASSET, { Global: '5' }),
          setMetadataCall(ASSET, { Global: '5' }, 'setAssetMetadataDetails'),
        ]),
        [priorEventForValue]
      )
    );

    expect(db['AssetMetadata'][`${ASSET}/Global/5`]).toMatchObject({ isLocked: true });
  });

  it('recovers the key with the comma toHuman() puts in a 4+ digit key id', async () => {
    await handleSetAssetMetadataValue(
      metaEvent(
        'SetAssetMetadataValue',
        [codec('0xdid'), codec(ASSET), codec('blob:big'), codec(null, { isEmpty: true })],
        batchExtrinsic('batchAll', [setMetadataCall(ASSET, { Global: '1,234' })])
      )
    );

    expect(db['AssetMetadata'][`${ASSET}/Global/1234`]).toMatchObject({ value: 'blob:big' });
  });

  it('recovers the key from a proposal executed via multiSig.approve', async () => {
    db['MultiSigProposal'] = {
      '5MultiSig/16': {
        id: '5MultiSig/16',
        params: {
          isBatch: false,
          isBridge: false,
          proposals: [
            {
              module: 'asset',
              call: 'set_asset_metadata',
              args: JSON.stringify({ asset_id: ASSET, key: { Global: '5' }, value: 'ipfs://cid' }),
            },
          ],
        },
      },
    };

    await handleSetAssetMetadataValue(
      metaEvent(
        'SetAssetMetadataValue',
        [codec('0xdid'), codec(ASSET), codec('ipfs://cid'), codec(null, { isEmpty: true })],
        multiSigApproveExtrinsic('5MultiSig', '16')
      )
    );

    expect(db['AssetMetadata'][`${ASSET}/Global/5`]).toMatchObject({
      scope: 'Global',
      keyId: '5',
      value: 'ipfs://cid',
    });
  });

  it('falls through to an anomaly when multiSig.approve references a proposal that was never indexed', async () => {
    await handleSetAssetMetadataValue(
      metaEvent(
        'SetAssetMetadataValue',
        [codec('0xdid'), codec(ASSET), codec('x'), codec(null, { isEmpty: true })],
        multiSigApproveExtrinsic('5Unknown', '99')
      )
    );

    expect(db['AssetMetadata']).toBeUndefined();
    expect(storeSet().mock.calls.some(([entity]) => entity === 'IndexerAnomaly')).toBe(true);
  });

  it('falls through to an anomaly when the approved proposal carries no metadata call', async () => {
    db['MultiSigProposal'] = {
      '5MultiSig/17': {
        id: '5MultiSig/17',
        params: {
          isBatch: false,
          isBridge: false,
          proposals: [
            { module: 'asset', call: 'create_asset', args: JSON.stringify({ asset_name: 'X' }) },
          ],
        },
      },
    };

    await handleSetAssetMetadataValue(
      metaEvent(
        'SetAssetMetadataValue',
        [codec('0xdid'), codec(ASSET), codec('x'), codec(null, { isEmpty: true })],
        multiSigApproveExtrinsic('5MultiSig', '17')
      )
    );

    expect(db['AssetMetadata']).toBeUndefined();
    expect(storeSet().mock.calls.some(([entity]) => entity === 'IndexerAnomaly')).toBe(true);
  });

  it('records an anomaly and writes nothing only when neither the extrinsic nor a sibling resolves the key', async () => {
    await handleSetAssetMetadataValue(
      metaEvent('SetAssetMetadataValue', [
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
      metaEvent('MetadataValueDeleted', [codec('0xdid'), codec(ASSET), codec({ local: 1 })])
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
      metaEvent('LocalMetadataKeyDeleted', [codec('0xdid'), codec(ASSET), codec('1')])
    );

    expect(db['AssetMetadata'][`${ASSET}/Local/1`]).toBeUndefined();
  });

  it('AssetTypeChanged updates Asset.type', async () => {
    await handleAssetTypeChanged(
      metaEvent('AssetTypeChanged', [codec('0xdid'), codec(ASSET), codec('Derivative')])
    );

    expect(db['Asset'][ASSET].type).toBe('Derivative');
  });
});

describe('handleCreatedAssetTransfer', () => {
  let db: MockDb;

  beforeEach(() => {
    db = mockStore({ Asset: { [ASSET]: { id: ASSET } } });
  });

  it('writes an account-side AssetTransaction and links the pending instruction', async () => {
    await handleCreatedAssetTransfer(
      metaEvent(
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
      // zero-padded to match Instruction.id (D12)
      instructionId: '0000000091',
      eventId: 'CreatedAssetTransfer',
    });
    expect(row.fromPortfolioId).toBeUndefined();
  });

  it('leaves instruction null when there is no pending transfer id', async () => {
    await handleCreatedAssetTransfer(
      metaEvent('CreatedAssetTransfer', [
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
