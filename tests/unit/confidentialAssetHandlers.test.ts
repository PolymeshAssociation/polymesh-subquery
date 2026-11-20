/**
 * Unit tests for the confidential assets (v2 / DART) event handlers.
 *
 * The chain prunes settlement state (encrypted legs, memo and affirmation statuses) at
 * finalization, so these handlers are the durable record of that data. The tests mock
 * `SubstrateEvent`s using the on-chain JSON/hex serialization of the pallet types.
 */

import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import {
  handleConfidentialAccountRegistered,
  handleConfidentialEncryptionKeyDistributed,
  handleConfidentialEncryptionKeyRegistered,
} from '../../src/mappings/entities/confidentialAssets/mapConfidentialAccount';
import {
  confidentialAssetKeyRows,
  handleConfidentialAccountAssetRegistered,
  handleConfidentialAssetCreated,
  handleConfidentialAssetMinted,
  handleConfidentialAssetUpdated,
} from '../../src/mappings/entities/confidentialAssets/mapConfidentialAsset';
import { handleConfidentialCurveTreeLeafUpdated } from '../../src/mappings/entities/confidentialAssets/mapConfidentialCurveTree';
import {
  getLegRef,
  handleConfidentialLegPartyUpdated,
  handleConfidentialSettlementCreated,
  handleConfidentialSettlementStatusUpdated,
} from '../../src/mappings/entities/confidentialAssets/mapConfidentialSettlement';

const SETTLEMENT_REF = '0x89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab';
const ACCOUNT_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
const ENCRYPTION_KEY = '0x2222222222222222222222222222222222222222222222222222222222222222';
const MEDIATOR_ENCRYPTION_KEY =
  '0x3333333333333333333333333333333333333333333333333333333333333333';

const mockCodec = (value: unknown, hex?: string): Codec =>
  ({
    toString: () => (typeof value === 'string' ? value : JSON.stringify(value)),
    toJSON: () => value,
    toHex: () => hex ?? String(value),
  } as unknown as Codec);

const mockEvent = (method: string, params: Codec[], idx = 2): SubstrateEvent =>
  ({
    idx,
    block: {
      block: { header: { number: { toString: () => '1234' } } },
      timestamp: new Date('2026-01-01T00:00:00Z'),
      specVersion: 8000000,
    },
    event: {
      method,
      section: 'confidentialAssets',
      data: params,
    },
  } as unknown as SubstrateEvent);

const blockId = '0000001234';
const blockEventId = `${blockId}/0000000002`;

const storeSet = (): jest.Mock => (globalThis as any).store.set as jest.Mock;
const storeGet = (): jest.Mock => (globalThis as any).store.get as jest.Mock;

describe('confidential account handlers', () => {
  it('should create a ConfidentialAccount and ConfidentialEncryptionKey on AccountRegistered', async () => {
    const event = mockEvent('AccountRegistered', [
      mockCodec(TEST_DID),
      mockCodec(ACCOUNT_KEY),
      mockCodec(ENCRYPTION_KEY),
    ]);

    await handleConfidentialAccountRegistered(event);

    expect(storeSet()).toHaveBeenCalledWith(
      'ConfidentialAccount',
      ACCOUNT_KEY,
      expect.objectContaining({
        id: ACCOUNT_KEY,
        publicKey: ACCOUNT_KEY,
        encryptionKeyId: ENCRYPTION_KEY,
        creatorId: TEST_DID,
        updatedEventId: blockEventId,
        createdEventId: blockEventId,
      })
    );
    expect(storeSet()).toHaveBeenCalledWith(
      'ConfidentialEncryptionKey',
      ENCRYPTION_KEY,
      expect.objectContaining({
        id: ENCRYPTION_KEY,
        encryptionKey: ENCRYPTION_KEY,
        creatorId: TEST_DID,
      })
    );
  });

  it('should create a ConfidentialEncryptionKey on EncryptionKeyRegistered', async () => {
    const event = mockEvent('EncryptionKeyRegistered', [
      mockCodec(TEST_DID),
      mockCodec(MEDIATOR_ENCRYPTION_KEY),
    ]);

    await handleConfidentialEncryptionKeyRegistered(event);

    expect(storeSet()).toHaveBeenCalledWith(
      'ConfidentialEncryptionKey',
      MEDIATOR_ENCRYPTION_KEY,
      expect.objectContaining({
        id: MEDIATOR_ENCRYPTION_KEY,
        creatorId: TEST_DID,
      })
    );
  });
});

describe('shared key distribution', () => {
  const SHARED_KEY = `0x${'44'.repeat(32)}`;

  it('records each key a shared key was distributed to', async () => {
    await handleConfidentialEncryptionKeyDistributed(
      mockEvent('EncryptionKeyDistributed', [
        mockCodec(TEST_DID),
        mockCodec(SHARED_KEY),
        mockCodec({
          publicKey: SHARED_KEY,
          recipientPks: [ENCRYPTION_KEY, MEDIATOR_ENCRYPTION_KEY],
          inner: '0x00',
        }),
      ])
    );

    expect(store.bulkCreate).toHaveBeenCalledWith('ConfidentialSharedKeyRecipient', [
      {
        id: `${SHARED_KEY}/${ENCRYPTION_KEY}`,
        sharedKeyId: SHARED_KEY,
        recipientId: ENCRYPTION_KEY,
        createdEventId: blockEventId,
      },
      expect.objectContaining({
        id: `${SHARED_KEY}/${MEDIATOR_ENCRYPTION_KEY}`,
        recipientId: MEDIATOR_ENCRYPTION_KEY,
      }),
    ]);
  });

  it('throws on a proof without recipients', async () => {
    await expect(
      handleConfidentialEncryptionKeyDistributed(
        mockEvent('EncryptionKeyDistributed', [
          mockCodec(TEST_DID),
          mockCodec(SHARED_KEY),
          mockCodec({ publicKey: SHARED_KEY }),
        ])
      )
    ).rejects.toThrow('KeyDistributionProof did not have the expected shape');
  });
});

describe('confidential asset handlers', () => {
  const assetCreatedParams = (): Codec[] => [
    mockCodec(TEST_DID),
    mockCodec('42'),
    mockCodec({ [ACCOUNT_KEY]: MEDIATOR_ENCRYPTION_KEY }),
    mockCodec([ENCRYPTION_KEY]),
    mockCodec('0x5465737420546f6b656e'), // "Test Token"
    mockCodec('0x54455354'), // "TEST"
    mockCodec('6'),
    mockCodec('0x7b7d'), // "{}"
  ];

  it('keeps each encryption key and each mediator once', () => {
    expect(
      confidentialAssetKeyRows('A1', ['0xenc1', '0xenc2', '0xenc1'], ['0xacc', '0xacc'])
    ).toEqual({
      encryptionKeys: [
        { id: 'A1/0xenc1', assetId: 'A1', encryptionKeyId: '0xenc1' },
        { id: 'A1/0xenc2', assetId: 'A1', encryptionKeyId: '0xenc2' },
      ],
      mediators: [{ id: 'A1/0xacc', assetId: 'A1', accountId: '0xacc' }],
    });
  });

  const created = (entity: string): { id: string }[] =>
    ((store.bulkCreate as jest.Mock).mock.calls.find(([name]) => name === entity)?.[1] ?? []) as {
      id: string;
    }[];

  it('should create a ConfidentialAsset on AssetCreated', async () => {
    await handleConfidentialAssetCreated(mockEvent('AssetCreated', assetCreatedParams()));

    expect(storeSet()).toHaveBeenCalledWith(
      'ConfidentialAsset',
      '42',
      expect.objectContaining({
        id: '42',
        assetId: 42,
        name: 'Test Token',
        symbol: 'TEST',
        decimals: 6,
        data: '{}',
        creatorId: TEST_DID,
        totalSupply: BigInt(0),
      })
    );
    expect(
      storeSet().mock.calls.find(([entity]) => entity === 'ConfidentialAsset')[2]
    ).not.toHaveProperty('auditors');
    expect(store.bulkCreate).toHaveBeenCalledWith('ConfidentialAssetEncryptionKey', [
      {
        id: `42/${ENCRYPTION_KEY}`,
        assetId: '42',
        encryptionKeyId: ENCRYPTION_KEY,
        createdEventId: blockEventId,
      },
      expect.objectContaining({ id: `42/${MEDIATOR_ENCRYPTION_KEY}` }),
    ]);
    expect(store.bulkCreate).toHaveBeenCalledWith('ConfidentialAssetMediator', [
      {
        id: `42/${ACCOUNT_KEY}`,
        assetId: '42',
        accountId: ACCOUNT_KEY,
        createdEventId: blockEventId,
      },
    ]);
  });

  it('gives a key named as an auditor and as a mediator’s key one row', async () => {
    const params = assetCreatedParams();
    params[3] = mockCodec([MEDIATOR_ENCRYPTION_KEY, ENCRYPTION_KEY]);

    await handleConfidentialAssetCreated(mockEvent('AssetCreated', params));

    expect(created('ConfidentialAssetEncryptionKey').map(({ id }) => id)).toEqual([
      `42/${MEDIATOR_ENCRYPTION_KEY}`,
      `42/${ENCRYPTION_KEY}`,
    ]);
  });

  it('gives a mediator-only key the same row as a key also named as an auditor', async () => {
    const params = assetCreatedParams();
    params[3] = mockCodec([]);

    await handleConfidentialAssetCreated(mockEvent('AssetCreated', params));

    expect(created('ConfidentialAssetEncryptionKey').map(({ id }) => id)).toEqual([
      `42/${MEDIATOR_ENCRYPTION_KEY}`,
    ]);
  });

  it('writes no rows for an asset with neither auditors nor mediators', async () => {
    const params = assetCreatedParams();
    params[2] = mockCodec({});
    params[3] = mockCodec([]);

    await handleConfidentialAssetCreated(mockEvent('AssetCreated', params));

    expect(store.bulkCreate).not.toHaveBeenCalled();
  });

  it('replaces the asset’s keys and mediators on AssetUpdated, dropping the ones it no longer names', async () => {
    storeGet().mockResolvedValueOnce({ id: '42' });
    ((globalThis as any).store.getByFields as jest.Mock)
      .mockResolvedValueOnce([{ id: `42/${MEDIATOR_ENCRYPTION_KEY}` }])
      .mockResolvedValueOnce([{ id: `42/${ACCOUNT_KEY}` }]);

    await handleConfidentialAssetUpdated(
      mockEvent('AssetUpdated', [
        mockCodec(TEST_DID),
        mockCodec('42'),
        mockCodec({}),
        mockCodec([ENCRYPTION_KEY]),
      ])
    );

    expect(store.bulkRemove).toHaveBeenCalledWith('ConfidentialAssetEncryptionKey', [
      `42/${MEDIATOR_ENCRYPTION_KEY}`,
    ]);
    expect(store.bulkRemove).toHaveBeenCalledWith('ConfidentialAssetMediator', [
      `42/${ACCOUNT_KEY}`,
    ]);
    expect(created('ConfidentialAssetEncryptionKey')).toEqual([
      expect.objectContaining({ id: `42/${ENCRYPTION_KEY}`, createdEventId: blockEventId }),
    ]);
    expect(storeSet()).toHaveBeenCalledWith(
      'ConfidentialAsset',
      '42',
      expect.objectContaining({ updatedEventId: blockEventId })
    );
  });

  it('leaves a key or mediator the update keeps alone, so it keeps the event that added it', async () => {
    storeGet().mockResolvedValueOnce({ id: '42' });
    ((globalThis as any).store.getByFields as jest.Mock)
      .mockResolvedValueOnce([{ id: `42/${ENCRYPTION_KEY}` }])
      .mockResolvedValueOnce([{ id: `42/${ACCOUNT_KEY}` }]);

    await handleConfidentialAssetUpdated(
      mockEvent('AssetUpdated', [
        mockCodec(TEST_DID),
        mockCodec('42'),
        mockCodec({ [ACCOUNT_KEY]: MEDIATOR_ENCRYPTION_KEY }),
        mockCodec([ENCRYPTION_KEY]),
      ])
    );

    expect(store.bulkRemove).not.toHaveBeenCalled();
    expect(created('ConfidentialAssetEncryptionKey').map(({ id }) => id)).toEqual([
      `42/${MEDIATOR_ENCRYPTION_KEY}`,
    ]);
    expect(created('ConfidentialAssetMediator')).toEqual([]);
  });

  it('should update total supply on AssetMinted', async () => {
    storeGet().mockResolvedValueOnce({ id: '42', totalSupply: BigInt(0) });

    await handleConfidentialAssetMinted(
      mockEvent('AssetMinted', [
        mockCodec(TEST_DID),
        mockCodec('42'),
        mockCodec('1000'),
        mockCodec('5000'),
        mockCodec(ACCOUNT_KEY),
      ])
    );

    expect(storeSet()).toHaveBeenCalledWith(
      'ConfidentialAsset',
      '42',
      expect.objectContaining({ totalSupply: BigInt(5000), updatedEventId: blockEventId })
    );
  });

  it('should not throw when minting an unknown asset', async () => {
    storeGet().mockResolvedValueOnce(undefined);

    await expect(
      handleConfidentialAssetMinted(
        mockEvent('AssetMinted', [
          mockCodec(TEST_DID),
          mockCodec('999'),
          mockCodec('1'),
          mockCodec('1'),
          mockCodec(ACCOUNT_KEY),
        ])
      )
    ).resolves.not.toThrow();

    expect(storeSet()).not.toHaveBeenCalled();
  });

  it('should create a ConfidentialAccountAsset on AccountAssetRegistered', async () => {
    await handleConfidentialAccountAssetRegistered(
      mockEvent('AccountAssetRegistered', [
        mockCodec(TEST_DID),
        mockCodec(ACCOUNT_KEY),
        mockCodec('42'),
      ])
    );

    expect(storeSet()).toHaveBeenCalledWith(
      'ConfidentialAccountAsset',
      `42/${ACCOUNT_KEY}`,
      expect.objectContaining({
        accountId: ACCOUNT_KEY,
        assetId: '42',
      })
    );
  });
});

describe('confidential settlement handlers', () => {
  const legHexes = ['0xdeadbeef01', '0xdeadbeef02'];

  const settlementCreatedParams = (): Codec[] => [
    mockCodec(SETTLEMENT_REF),
    mockCodec('0x736f6d65206d656d6f'), // "some memo"
    mockCodec('1200'),
    // the legs param is a Vec<LegEncrypted>, which is iterable
    legHexes.map(hex => mockCodec({}, hex)) as unknown as Codec,
  ];

  it('should extract settlement and leg id from a LegRef', () => {
    // polkadot.js camel cases metadata field names, so on chain `leg_id` is serialized as `legId`
    expect(getLegRef(mockCodec({ settlement: SETTLEMENT_REF, legId: 1 }))).toEqual({
      settlementId: SETTLEMENT_REF,
      legId: 1,
    });
  });

  it('should create a ConfidentialSettlement and its encrypted legs on SettlementCreated', async () => {
    await handleConfidentialSettlementCreated(
      mockEvent('SettlementCreated', settlementCreatedParams())
    );

    expect(storeSet()).toHaveBeenCalledWith(
      'ConfidentialSettlement',
      SETTLEMENT_REF,
      expect.objectContaining({
        id: SETTLEMENT_REF,
        memo: 'some memo',
        assetRootBlock: 1200,
        legCount: 2,
        status: 'Pending',
        updatedEventId: blockEventId,
        createdEventId: blockEventId,
      })
    );

    legHexes.forEach((encryptedData, legId) => {
      expect(storeSet()).toHaveBeenCalledWith(
        'ConfidentialLeg',
        `${SETTLEMENT_REF}/${legId}`,
        expect.objectContaining({
          settlementId: SETTLEMENT_REF,
          legId,
          encryptedData,
        })
      );
    });
  });

  it('should update the settlement status on SettlementStatusUpdated', async () => {
    storeGet().mockResolvedValueOnce({ id: SETTLEMENT_REF, status: 'Pending' });

    await handleConfidentialSettlementStatusUpdated(
      mockEvent('SettlementStatusUpdated', [mockCodec(SETTLEMENT_REF), mockCodec('Executed')])
    );

    expect(storeSet()).toHaveBeenCalledWith(
      'ConfidentialSettlement',
      SETTLEMENT_REF,
      expect.objectContaining({ status: 'Executed', updatedEventId: blockEventId })
    );
  });

  it('should throw on an unknown settlement status', async () => {
    await expect(
      handleConfidentialSettlementStatusUpdated(
        mockEvent('SettlementStatusUpdated', [mockCodec(SETTLEMENT_REF), mockCodec('Bogus')])
      )
    ).rejects.toThrow('Unknown confidential settlement status: Bogus');
  });

  describe('leg party affirmation events', () => {
    const legRef = (legId = 0): Codec => mockCodec({ settlement: SETTLEMENT_REF, legId });

    it.each([
      ['SenderAffirmed', 'Sender', 'Affirmed'],
      ['ReceiverAffirmed', 'Receiver', 'Affirmed'],
      ['SenderCounterUpdated', 'Sender', 'Finalized'],
      ['ReceiverClaimed', 'Receiver', 'Finalized'],
      ['SenderAffirmationReverted', 'Sender', 'Reverted'],
      ['ReceiverAffirmationReverted', 'Receiver', 'Reverted'],
    ])('should record %s as %s -> %s', async (method, party, status) => {
      await handleConfidentialLegPartyUpdated(mockEvent(method, [legRef()]));

      expect(storeSet()).toHaveBeenCalledWith(
        'ConfidentialLegAffirmation',
        `${SETTLEMENT_REF}/0/${party}`,
        expect.objectContaining({
          settlementId: SETTLEMENT_REF,
          legId: `${SETTLEMENT_REF}/0`,
          party,
          keyIndex: undefined,
          status,
        })
      );
    });

    it.each([
      ['MediatorAffirmed', 'Affirmed'],
      ['MediatorRejected', 'Rejected'],
    ])('should record %s with the mediator key index', async (method, status) => {
      await handleConfidentialLegPartyUpdated(mockEvent(method, [legRef(1), mockCodec('4')]));

      expect(storeSet()).toHaveBeenCalledWith(
        'ConfidentialLegAffirmation',
        `${SETTLEMENT_REF}/1/Mediator/4`,
        expect.objectContaining({
          legId: `${SETTLEMENT_REF}/1`,
          party: 'Mediator',
          keyIndex: 4,
          status,
        })
      );
    });

    it('should update an existing affirmation record for the same party', async () => {
      const existing = {
        id: `${SETTLEMENT_REF}/0/Sender`,
        status: 'Affirmed',
        updatedEventId: blockEventId,
      };
      storeGet().mockResolvedValueOnce(existing);

      await handleConfidentialLegPartyUpdated(mockEvent('SenderCounterUpdated', [legRef()]));

      expect(storeSet()).toHaveBeenCalledWith(
        'ConfidentialLegAffirmation',
        `${SETTLEMENT_REF}/0/Sender`,
        expect.objectContaining({ status: 'Finalized', updatedEventId: blockEventId })
      );
    });
  });
});

describe('confidential curve tree leaf handler', () => {
  const COMMITMENT = '0x4444444444444444444444444444444444444444444444444444444444444444';

  it.each([
    ['AccountStateLeafInserted', 'Account'],
    ['FeeAccountStateLeafInserted', 'FeeAccount'],
    ['AssetStateLeafUpdated', 'Asset'],
  ])('should store the leaf for %s in the %s tree', async (method, tree) => {
    await handleConfidentialCurveTreeLeafUpdated(
      mockEvent(method, [mockCodec('7'), mockCodec(COMMITMENT, COMMITMENT)])
    );

    expect(storeSet()).toHaveBeenCalledWith(
      'ConfidentialCurveTreeLeaf',
      `${tree}/7`,
      expect.objectContaining({
        tree,
        leafIndex: BigInt(7),
        value: COMMITMENT,
        updatedEventId: blockEventId,
      })
    );
  });

  it('should update an existing asset tree leaf in place', async () => {
    const existing = {
      id: 'Asset/7',
      tree: 'Asset',
      leafIndex: BigInt(7),
      value: '0x00',
      updatedEventId: blockEventId,
    };
    storeGet().mockResolvedValueOnce(existing);

    await handleConfidentialCurveTreeLeafUpdated(
      mockEvent('AssetStateLeafUpdated', [mockCodec('7'), mockCodec(COMMITMENT, COMMITMENT)])
    );

    expect(storeSet()).toHaveBeenCalledWith(
      'ConfidentialCurveTreeLeaf',
      'Asset/7',
      expect.objectContaining({ value: COMMITMENT, updatedEventId: blockEventId })
    );
  });
});
