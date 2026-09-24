/**
 * Asset metadata and asset-type changes.
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
import { SubstrateEvent } from '@subql/types';
import { resetMetadataKeyCache } from '../../src/mappings/entities/assets/metadataKeyResolver';
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

/** An `EventRecord`-shaped entry in the block's event stream. */
const rec = (section: string, method: string, data: unknown[] = [], extrinsicIdx = 1) => ({
  phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => extrinsicIdx } },
  event: tupleEvent({ section, method, data }).event,
});

const assetRec = (method: string, data: unknown[], extrinsicIdx = 1) =>
  rec('asset', method, data, extrinsicIdx);

const itemCompleted = (extrinsicIdx = 1) => rec('utility', 'ItemCompleted', [], extrinsicIdx);
const batchCompleted = (extrinsicIdx = 1) => rec('utility', 'BatchCompleted', [], extrinsicIdx);

/**
 * The event at `targetIdx` of a full extrinsic event stream. The resolver walks the whole stream,
 * so every event the extrinsic emitted has to be present — including the one under test.
 */
const inExtrinsic = (
  extrinsic: unknown,
  records: ReturnType<typeof rec>[],
  targetIdx: number
): SubstrateEvent =>
  ({
    idx: targetIdx,
    extrinsic,
    block: {
      block: { header: { number: { toString: () => '700' } } },
      specVersion: 8_000_000,
      timestamp: new Date('2026-01-01T00:00:00Z'),
      events: records,
    },
    event: records[targetIdx].event,
  } as unknown as SubstrateEvent);

/** A decoded `Call`: the resolver reads `section` / `method` / positional `args`. */
const call = (section: string, method: string, args: unknown[] = []) => ({
  section,
  method,
  args,
});

/** `asset.setAssetMetadata(asset_id, key, value, detail)`. */
const setMetadataCall = (assetId: string, key: unknown, method = 'setAssetMetadata') =>
  call('asset', method, [codec(assetId), codec(key)]);

const directExtrinsic = (c: ReturnType<typeof call>, idx = 1) => ({
  idx,
  extrinsic: { method: c },
});

const batchExtrinsic = (method: string, calls: ReturnType<typeof call>[], idx = 1) =>
  directExtrinsic(call('utility', method, [calls]), idx);

/** A `multiSig.approve(multisig, proposalId)` extrinsic. */
const multiSigApproveExtrinsic = (multisig: string, proposalId: string) =>
  directExtrinsic(call('multiSig', 'approve', [codec(multisig), codec(proposalId)]));

const VALUE_DETAIL_NONE = () => codec(null, { isEmpty: true });

describe('asset metadata', () => {
  let db: MockDb;

  beforeEach(() => {
    resetMetadataKeyCache();
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
    const events = [
      assetRec('SetAssetMetadataValue', [
        codec('0xdid'),
        codec(ASSET),
        codec('ipfs://cid'),
        codec({ expire: null, lockStatus: 'Locked' }),
      ]),
    ];

    await handleSetAssetMetadataValue(
      inExtrinsic(directExtrinsic(setMetadataCall(ASSET, { local: 1 })), events, 0)
    );

    expect(db['AssetMetadata'][`${ASSET}/Local/1`]).toMatchObject({
      value: 'ipfs://cid',
      isLocked: true,
    });
  });

  it('keeps the time a LockedUntil lock ends', async () => {
    const events = [
      assetRec('SetAssetMetadataValue', [
        codec('0xdid'),
        codec(ASSET),
        codec('ipfs://cid'),
        codec({ expire: null, lockStatus: { lockedUntil: 1_767_225_600_000 } }),
      ]),
    ];

    await handleSetAssetMetadataValue(
      inExtrinsic(directExtrinsic(setMetadataCall(ASSET, { local: 1 })), events, 0)
    );

    expect(db['AssetMetadata'][`${ASSET}/Local/1`]).toMatchObject({
      isLocked: true,
      lockedUntil: new Date(1_767_225_600_000),
    });
  });

  it('recovers the key from a sibling RegisterAssetMetadataLocalType (register-and-set path)', async () => {
    // the setter is dispatched by registerAndSetLocalAssetMetadata, not setAssetMetadata, so the
    // key is not in args[1]; the RegisterAssetMetadataLocalType event fired earlier in the same
    // extrinsic carries the new local key id (3)
    const events = [
      assetRec(
        'RegisterAssetMetadataLocalType',
        [codec('0xdid'), codec(ASSET), codec('Whitepaper'), codec('3'), codec({})],
        6
      ),
      assetRec(
        'SetAssetMetadataValue',
        [codec('0xdid'), codec(ASSET), codec('ipfs://new'), VALUE_DETAIL_NONE()],
        6
      ),
    ];

    await handleSetAssetMetadataValue(
      inExtrinsic(directExtrinsic(call('asset', 'registerAndSetLocalAssetMetadata'), 6), events, 1)
    );

    expect(db['AssetMetadata'][`${ASSET}/Local/3`]).toMatchObject({
      scope: 'Local',
      keyId: '3',
      value: 'ipfs://new',
    });
    expect(storeSet().mock.calls.some(([entity]) => entity === 'IndexerAnomaly')).toBe(false);
  });

  it('recovers the key from a setAssetMetadata call batched in a utility.batchAll extrinsic', async () => {
    const events = [
      itemCompleted(),
      assetRec('SetAssetMetadataValue', [
        codec('0xdid'),
        codec(ASSET),
        codec('blob:cf'),
        VALUE_DETAIL_NONE(),
      ]),
      itemCompleted(),
      batchCompleted(),
    ];

    await handleSetAssetMetadataValue(
      inExtrinsic(
        batchExtrinsic('batchAll', [
          call('asset', 'createAsset'),
          setMetadataCall(ASSET, { Global: '5' }),
        ]),
        events,
        1
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
    const events = [
      assetRec('SetAssetMetadataValue', [
        codec('0xdid'),
        codec(OTHER),
        codec('blob:other'),
        VALUE_DETAIL_NONE(),
      ]),
      itemCompleted(),
      assetRec('SetAssetMetadataValue', [
        codec('0xdid'),
        codec(ASSET),
        codec('blob:mine'),
        VALUE_DETAIL_NONE(),
      ]),
      itemCompleted(),
      batchCompleted(),
    ];

    await handleSetAssetMetadataValue(
      inExtrinsic(
        batchExtrinsic('batch', [
          setMetadataCall(OTHER, { Global: '9' }),
          setMetadataCall(ASSET, { Global: '5' }),
        ]),
        events,
        2
      )
    );

    expect(db['AssetMetadata'][`${ASSET}/Global/5`]).toMatchObject({ value: 'blob:mine' });
    expect(db['AssetMetadata'][`${OTHER}/Global/9`]).toBeUndefined();
  });

  it('matches the right call by ordinal when a batch sets two different keys on the same asset (asset_id alone cannot disambiguate)', async () => {
    const events = [
      assetRec('SetAssetMetadataValue', [
        codec('0xdid'),
        codec(ASSET),
        codec('blob:first'),
        VALUE_DETAIL_NONE(),
      ]),
      itemCompleted(),
      assetRec('SetAssetMetadataValue', [
        codec('0xdid'),
        codec(ASSET),
        codec('blob:second'),
        VALUE_DETAIL_NONE(),
      ]),
      itemCompleted(),
      batchCompleted(),
    ];

    await handleSetAssetMetadataValue(
      inExtrinsic(
        batchExtrinsic('batchAll', [
          setMetadataCall(ASSET, { Global: '1' }),
          setMetadataCall(ASSET, { Global: '2' }),
        ]),
        events,
        2
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
    const events = [
      assetRec('SetAssetMetadataValue', [
        codec('0xdid'),
        codec(ASSET),
        codec('blob:cf'),
        VALUE_DETAIL_NONE(),
      ]),
      itemCompleted(),
      assetRec('SetAssetMetadataValueDetails', [
        codec('0xdid'),
        codec(ASSET),
        codec({ expire: null, lockStatus: 'Locked' }),
      ]),
      itemCompleted(),
      batchCompleted(),
    ];

    await handleSetAssetMetadataValueDetails(
      inExtrinsic(
        batchExtrinsic('batchAll', [
          setMetadataCall(ASSET, { Global: '5' }),
          setMetadataCall(ASSET, { Global: '5' }, 'setAssetMetadataDetails'),
        ]),
        events,
        2
      )
    );

    expect(db['AssetMetadata'][`${ASSET}/Global/5`]).toMatchObject({ isLocked: true });
  });

  it('strips the comma toHuman() leaves in a 4+ digit key id stored on a proposal', async () => {
    db['MultiSigProposal'] = {
      '5MultiSig/18': {
        id: '5MultiSig/18',
        params: {
          isBatch: false,
          isBridge: false,
          proposals: [
            {
              module: 'asset',
              call: 'set_asset_metadata',
              args: JSON.stringify({ asset_id: ASSET, key: { Global: '1,234' } }),
            },
          ],
        },
      },
    };

    const events = [
      rec('multiSig', 'ProposalApproved'),
      assetRec('SetAssetMetadataValue', [
        codec('0xdid'),
        codec(ASSET),
        codec('blob:big'),
        VALUE_DETAIL_NONE(),
      ]),
      rec('multiSig', 'ProposalExecuted'),
    ];

    await handleSetAssetMetadataValue(
      inExtrinsic(multiSigApproveExtrinsic('5MultiSig', '18'), events, 1)
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

    const events = [
      rec('multiSig', 'ProposalApproved'),
      assetRec('SetAssetMetadataValue', [
        codec('0xdid'),
        codec(ASSET),
        codec('ipfs://cid'),
        VALUE_DETAIL_NONE(),
      ]),
      rec('multiSig', 'ProposalExecuted'),
    ];

    await handleSetAssetMetadataValue(
      inExtrinsic(multiSigApproveExtrinsic('5MultiSig', '16'), events, 1)
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

  it('does not swap keys when registerAndSetLocalAssetMetadata is batched with setAssetMetadata on the same asset', async () => {
    // registerAndSetLocalAssetMetadata emits a SetAssetMetadataValue of its own, so the two calls
    // produce two indistinguishable events. Each must resolve to the key its own call carries.
    const events = [
      assetRec('RegisterAssetMetadataLocalType', [
        codec('0xdid'),
        codec(ASSET),
        codec('Whitepaper'),
        codec('7'),
        codec({}),
      ]),
      assetRec('SetAssetMetadataValue', [
        codec('0xdid'),
        codec(ASSET),
        codec('blob:registered'),
        VALUE_DETAIL_NONE(),
      ]),
      itemCompleted(),
      assetRec('SetAssetMetadataValue', [
        codec('0xdid'),
        codec(ASSET),
        codec('blob:plain'),
        VALUE_DETAIL_NONE(),
      ]),
      itemCompleted(),
      batchCompleted(),
    ];

    const extrinsic = batchExtrinsic('batchAll', [
      call('asset', 'registerAndSetLocalAssetMetadata'),
      setMetadataCall(ASSET, { Global: '5' }),
    ]);

    await handleSetAssetMetadataValue(inExtrinsic(extrinsic, events, 1));
    resetMetadataKeyCache();
    await handleSetAssetMetadataValue(inExtrinsic(extrinsic, events, 3));

    expect(db['AssetMetadata'][`${ASSET}/Local/7`]).toMatchObject({ value: 'blob:registered' });
    expect(db['AssetMetadata'][`${ASSET}/Global/5`]).toMatchObject({ value: 'blob:plain' });
  });

  it('stays aligned when an earlier call in a forceBatch fails and emits nothing', async () => {
    // A failed call rolls its events back, so the surviving event must be attributed to the call
    // that actually ran. ItemFailed is what marks the gap.
    const events = [
      rec('utility', 'ItemFailed'),
      assetRec('SetAssetMetadataValue', [
        codec('0xdid'),
        codec(ASSET),
        codec('blob:survivor'),
        VALUE_DETAIL_NONE(),
      ]),
      itemCompleted(),
      rec('utility', 'BatchCompletedWithErrors'),
    ];

    await handleSetAssetMetadataValue(
      inExtrinsic(
        batchExtrinsic('forceBatch', [
          setMetadataCall(ASSET, { Global: '1' }),
          setMetadataCall(ASSET, { Global: '2' }),
        ]),
        events,
        1
      )
    );

    expect(db['AssetMetadata'][`${ASSET}/Global/2`]).toMatchObject({ value: 'blob:survivor' });
    expect(db['AssetMetadata'][`${ASSET}/Global/1`]).toBeUndefined();
  });

  it('gives each registerAndSetLocalAssetMetadata in a batch its own registered key', async () => {
    // Both calls register a key and set it, so the extrinsic carries two registration events. Each
    // setter takes the key registered by its own call, not the first one in the extrinsic.
    const events = [
      assetRec('RegisterAssetMetadataLocalType', [
        codec('0xdid'),
        codec(ASSET),
        codec('First'),
        codec('11'),
        codec({}),
      ]),
      assetRec('SetAssetMetadataValue', [
        codec('0xdid'),
        codec(ASSET),
        codec('blob:one'),
        VALUE_DETAIL_NONE(),
      ]),
      itemCompleted(),
      assetRec('RegisterAssetMetadataLocalType', [
        codec('0xdid'),
        codec(ASSET),
        codec('Second'),
        codec('12'),
        codec({}),
      ]),
      assetRec('SetAssetMetadataValue', [
        codec('0xdid'),
        codec(ASSET),
        codec('blob:two'),
        VALUE_DETAIL_NONE(),
      ]),
      itemCompleted(),
      batchCompleted(),
    ];

    const extrinsic = batchExtrinsic('batchAll', [
      call('asset', 'registerAndSetLocalAssetMetadata'),
      call('asset', 'registerAndSetLocalAssetMetadata'),
    ]);

    await handleSetAssetMetadataValue(inExtrinsic(extrinsic, events, 1));
    resetMetadataKeyCache();
    await handleSetAssetMetadataValue(inExtrinsic(extrinsic, events, 4));

    expect(db['AssetMetadata'][`${ASSET}/Local/11`]).toMatchObject({ value: 'blob:one' });
    expect(db['AssetMetadata'][`${ASSET}/Local/12`]).toMatchObject({ value: 'blob:two' });
  });

  it('leaves an existing lock alone when the value event carries no detail', async () => {
    // On chain a `None` detail leaves the stored details unchanged; clearing them wiped a real lock.
    db['AssetMetadata'] = {
      [`${ASSET}/Local/1`]: {
        id: `${ASSET}/Local/1`,
        assetId: ASSET,
        scope: 'Local',
        keyId: '1',
        isLocked: true,
        lockedUntil: new Date('2031-01-01T00:00:00Z'),
        expiry: new Date('2030-01-01T00:00:00Z'),
      },
    };

    const events = [
      assetRec('SetAssetMetadataValue', [
        codec('0xdid'),
        codec(ASSET),
        codec('ipfs://updated'),
        VALUE_DETAIL_NONE(),
      ]),
    ];

    await handleSetAssetMetadataValue(
      inExtrinsic(directExtrinsic(setMetadataCall(ASSET, { local: 1 })), events, 0)
    );

    expect(db['AssetMetadata'][`${ASSET}/Local/1`]).toMatchObject({
      value: 'ipfs://updated',
      isLocked: true,
      lockedUntil: new Date('2031-01-01T00:00:00Z'),
      expiry: new Date('2030-01-01T00:00:00Z'),
    });
  });

  it('records an anomaly when a details event cannot be matched to its call', async () => {
    await handleSetAssetMetadataValueDetails(
      inExtrinsic(
        directExtrinsic(call('someOther', 'wrapper')),
        [
          assetRec('SetAssetMetadataValueDetails', [
            codec('0xdid'),
            codec(ASSET),
            codec({ expire: null, lockStatus: 'Locked' }),
          ]),
        ],
        0
      )
    );

    expect(storeSet().mock.calls.some(([entity]) => entity === 'IndexerAnomaly')).toBe(true);
  });

  it('names the scheduler as the cause when a value event has no extrinsic at all', async () => {
    await handleSetAssetMetadataValue(
      metaEvent('SetAssetMetadataValue', [
        codec('0xdid'),
        codec(ASSET),
        codec('blob:scheduled'),
        VALUE_DETAIL_NONE(),
      ])
    );

    const anomaly = storeSet().mock.calls.find(([entity]) => entity === 'IndexerAnomaly');
    expect(anomaly).toBeDefined();
    expect(anomaly[2].detail).toContain('without an extrinsic');
    expect(db['AssetMetadata']).toBeUndefined();
  });

  it('resolves a metadata call nested inside a batch proposal executed via multiSig.approve', async () => {
    db['MultiSigProposal'] = {
      '5MultiSig/20': {
        id: '5MultiSig/20',
        params: {
          isBatch: true,
          isBridge: false,
          proposals: [
            { module: 'asset', call: 'create_asset', args: JSON.stringify({ asset_name: 'X' }) },
            {
              module: 'asset',
              call: 'set_asset_metadata',
              args: JSON.stringify({ asset_id: ASSET, key: { Global: '8' } }),
            },
          ],
        },
      },
    };

    const events = [
      rec('multiSig', 'ProposalApproved'),
      itemCompleted(),
      assetRec('SetAssetMetadataValue', [
        codec('0xdid'),
        codec(ASSET),
        codec('blob:nested'),
        VALUE_DETAIL_NONE(),
      ]),
      itemCompleted(),
      batchCompleted(),
      rec('multiSig', 'ProposalExecuted'),
    ];

    await handleSetAssetMetadataValue(
      inExtrinsic(multiSigApproveExtrinsic('5MultiSig', '20'), events, 2)
    );

    expect(db['AssetMetadata'][`${ASSET}/Global/8`]).toMatchObject({ value: 'blob:nested' });
  });

  it('records an anomaly for a forceBatch proposal, whose calls ProposalAdded does not unwrap', async () => {
    // `handleMultiSigProposalAdded` detects a batch with `method.startsWith('batch')`, so a
    // `forceBatch` proposal is stored as one opaque call and its metadata call is not visible here.
    db['MultiSigProposal'] = {
      '5MultiSig/21': {
        id: '5MultiSig/21',
        params: {
          isBatch: false,
          isBridge: false,
          proposals: [
            { module: 'utility', call: 'force_batch', args: JSON.stringify({ calls: [] }) },
          ],
        },
      },
    };

    const events = [
      rec('multiSig', 'ProposalApproved'),
      assetRec('SetAssetMetadataValue', [
        codec('0xdid'),
        codec(ASSET),
        codec('blob:forced'),
        VALUE_DETAIL_NONE(),
      ]),
      rec('multiSig', 'ProposalExecuted'),
    ];

    await handleSetAssetMetadataValue(
      inExtrinsic(multiSigApproveExtrinsic('5MultiSig', '21'), events, 1)
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
