import { hexToU8a } from '@polkadot/util';
import { __resetBlockContext } from '../../src/mappings/blockContext';
import { SubstrateExtrinsic } from '@subql/types';
import { createExtrinsic, handleExtrinsic } from '../../src/mappings/entities/block/mapExtrinsic';
import { IndexerAnomaly } from '../../src/types';
import { callOf } from './helpers';

/** signed by 0x4c0883a6...2318, whose address is `FROM_ETH` */
const FROM_ETH = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const FROM_SS58 = '2DTD2fX3yEHNTRURNtwZS9r9hqzFUNmzoMK1t9WWMauH9wkc';

const payloads = {
  /** EIP-1559 to the `modlpy/paddr` runtime pallets address, nonce 7 */
  runtimeCall:
    '0x02f87083190d5a07808477359400825208946d6f646c70792f7061646472000000000000000080871a0400d1070000c080a01ad9580e471e8fd43d716a5a772b0b3191282b2dc425fcefd0eb774980462976a005d32e0074b587c871dd0fe6a8e53572798570d2146410790e0d7ea19f94961b',
  /** EIP-1559 contract deployment carrying `0xdeadbeef` as init code */
  deploy:
    '0x02f85983190d5a07808477359400825208808084deadbeefc001a0678b44834b3ccc478253db225af42f9fc25d27e18453338d164b3ce62816aa4fa01c8f9951ee084d5e707172f7c5bce88b578db99d730c4d19e972aa4c487adc0e',
};

const INNER_CALL = callOf('asset', 'issue', [['asset_id', 'u128', 7]]);

interface MockOptions {
  section?: string;
  method?: string;
  payload?: string;
  events?: { section: string; method: string; data: any[] }[];
  success?: boolean;
  innerCall?: ReturnType<typeof callOf>;
  idx?: number;
  blockNumber?: number;
  signer?: string;
  ss58Format?: number;
}

/**
 * `resolveEthTransact` memoizes per `block/extrinsicIdx`, which uniquely identifies an extrinsic on
 * chain but not across tests, so each mock gets its own index
 */
let nextIdx = 1;

const mockExtrinsic = ({
  section = 'revive',
  method = 'ethTransact',
  payload = payloads.runtimeCall,
  events = [],
  success = true,
  innerCall,
  idx = nextIdx++,
  blockNumber = 4242,
  signer = '',
  ss58Format = 12,
}: MockOptions = {}): SubstrateExtrinsic =>
  ({
    idx,
    success,
    events: events.map(({ section: s, method: m, data }) => ({
      event: { section: s, method: m, data },
    })),
    block: {
      specVersion: 8000000,
      timestamp: new Date('2026-01-01T00:00:00Z'),
      block: { header: { number: { toString: () => `${blockNumber}` } } },
    },
    extrinsic: {
      length: 128,
      isSigned: signer !== '',
      signer: { isEmpty: signer === '', toString: () => signer },
      nonce: { toNumber: () => 99 },
      hash: { toJSON: () => '0xsubstratehash' },
      registry: {
        chainSS58: ss58Format,
        createType: (): unknown => {
          if (!innerCall) {
            throw new Error('unable to decode');
          }
          return innerCall;
        },
      },
      method: callOf(section, method, [['payload', 'Bytes', payload]]),
      args: [{ toU8a: () => hexToU8a(payload) }],
    },
  } as unknown as SubstrateExtrinsic);

describe('createExtrinsic', () => {
  it('should leave a regular extrinsic untouched', () => {
    const extrinsic = createExtrinsic(
      mockExtrinsic({ section: 'balances', method: 'transferWithMemo', signer: 'someAddress' })
    );

    expect(extrinsic.moduleId).toEqual('balances');
    expect(extrinsic.callId).toEqual('transfer_with_memo');
    expect(extrinsic.signed).toEqual(1);
    expect(extrinsic.signedbyAddress).toEqual(1);
    expect(extrinsic.address).toEqual('someAddress');
    expect(extrinsic.nonce).toEqual(99);
    expect(extrinsic.ethAddress).toBeUndefined();
    expect(extrinsic.ethTxHash).toBeUndefined();
    // RLP is not UTF-8, so the payload stays hex
    expect(extrinsic.args).toEqual({ payload: payloads.runtimeCall });
  });

  it('should store no args and record an anomaly when an argument is not its declared type', () => {
    const anomaly = jest.spyOn(IndexerAnomaly.prototype, 'save').mockResolvedValue(undefined);
    const extrinsic = mockExtrinsic({ section: 'balances', method: 'transferWithMemo' });
    const call = extrinsic.extrinsic.method as unknown as { args: unknown[] };
    call.args[0] = { toRawType: () => 'Option<u32>', toString: () => '' };
    call.args.length = 1;
    (extrinsic.extrinsic.method as unknown as { meta: unknown }).meta = {
      args: [{ name: 'payload', type: 'Option<u32>' }],
    };

    const created = createExtrinsic(extrinsic);

    expect(created.args).toBeUndefined();
    expect(anomaly).toHaveBeenCalledTimes(1);
    expect(anomaly.mock.instances[0]).toMatchObject({ kind: 'UnreadableValue' });
    anomaly.mockRestore();
  });

  it('should attribute an eth_transact to the signing Ethereum key while staying unsigned', () => {
    const extrinsic = createExtrinsic(mockExtrinsic({ innerCall: INNER_CALL }));

    expect(extrinsic.address).toEqual(FROM_SS58);
    expect(extrinsic.ethAddress).toEqual(FROM_ETH);
    expect(extrinsic.ethTxHash).toEqual(
      '0xc5a3bbd37bc19ccfc6d8956f68fd13cfa397a7ed40b956c9414e2e9ad4707500'
    );
    // the extrinsic really is unsigned at the substrate layer
    expect(extrinsic.signed).toEqual(0);
    expect(extrinsic.signedbyAddress).toEqual(0);
  });

  it('should normalise a runtime call to the pallet and call that was dispatched', () => {
    const extrinsic = createExtrinsic(mockExtrinsic({ innerCall: INNER_CALL }));

    expect(extrinsic.moduleId).toEqual('asset');
    expect(extrinsic.moduleIdText).toEqual('asset');
    expect(extrinsic.callId).toEqual('issue');
    expect(extrinsic.callIdText).toEqual('issue');
    expect(extrinsic.args).toEqual({ assetId: '7' });
  });

  it('should use the Ethereum nonce rather than the (always zero) extrinsic nonce', () => {
    expect(createExtrinsic(mockExtrinsic({ innerCall: INNER_CALL })).nonce).toEqual(7);
  });

  it('should omit the init code from args, since EvmTransaction stores it', () => {
    const extrinsic = createExtrinsic(mockExtrinsic({ payload: payloads.deploy }));

    expect(extrinsic.callId).toEqual('eth_instantiate_with_code');
    expect(extrinsic.args).toEqual({
      to: null,
      value: '0',
      gasLimit: '21000',
      nonce: '7',
    });
    expect(JSON.stringify(extrinsic.args)).not.toContain('deadbeef');
  });

  it('should mark a reverted transaction as unsuccessful despite the extrinsic succeeding', () => {
    const extrinsic = createExtrinsic(
      mockExtrinsic({
        innerCall: INNER_CALL,
        success: true,
        events: [
          {
            section: 'revive',
            method: 'EthExtrinsicRevert',
            data: [{ toHuman: () => ({ Module: { index: '26', error: '0x01000000' } }) }],
          },
        ],
      })
    );

    expect(extrinsic.success).toEqual(0);
  });

  describe('batchFailed', () => {
    const batch = (...methods: string[]) =>
      createExtrinsic(
        mockExtrinsic({
          section: 'utility',
          method: 'batch',
          events: methods.map(method => ({ section: 'utility', method, data: [] })),
        })
      );

    it('is true when a batch was interrupted, though the extrinsic succeeded', () => {
      const extrinsic = batch('BatchInterrupted');

      expect(extrinsic.success).toEqual(1);
      expect(extrinsic.batchFailed).toBe(true);
    });

    it.each(['BatchInterruptedOld', 'BatchOptimisticFailed'])('is true on %s', method => {
      expect(batch(method).batchFailed).toBe(true);
    });

    it('is true when a force_batch carried on past failing calls', () => {
      expect(batch('ItemCompleted', 'ItemFailed', 'BatchCompletedWithErrors').batchFailed).toBe(
        true
      );
    });

    it('is false for a batch whose every call succeeded', () => {
      expect(batch('ItemCompleted', 'ItemCompleted', 'BatchCompleted').batchFailed).toBe(false);
    });

    it('is false for an extrinsic that is not a batch', () => {
      expect(createExtrinsic(mockExtrinsic({ innerCall: INNER_CALL })).batchFailed).toBe(false);
    });

    it('ignores an event of the same name from another pallet', () => {
      const extrinsic = createExtrinsic(
        mockExtrinsic({ events: [{ section: 'scheduler', method: 'ItemFailed', data: [] }] })
      );

      expect(extrinsic.batchFailed).toBe(false);
    });
  });

  it('should keep success 1 when nothing reverted', () => {
    expect(createExtrinsic(mockExtrinsic({ innerCall: INNER_CALL })).success).toEqual(1);
  });

  it('should fall back to the raw extrinsic when the payload cannot be decoded', () => {
    const extrinsic = createExtrinsic(mockExtrinsic({ payload: '0xdeadbeef' }));

    // `revive.eth_transact` surviving normalisation is the sentinel for a failed decode
    expect(extrinsic.moduleId).toEqual('revive');
    expect(extrinsic.callId).toEqual('eth_transact');
    expect(extrinsic.address).toBeNull();
    expect(extrinsic.ethTxHash).toBeUndefined();
  });
});

describe('handleExtrinsic', () => {
  const DID = '0x0100000000000000000000000000000000000000000000000000000000000000';

  beforeEach(() => {
    __resetBlockContext();
    (globalThis as any).store = {
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
    };
    // `getOrCreateAccount` consults the key record before indexing an account
    (globalThis as any).api.query = {
      identity: { keyRecords: jest.fn().mockResolvedValue({ isEmpty: true }) },
    };
    Object.assign((globalThis as any).api, { registry: { chainSS58: 12 } });
  });

  const saved = (entity: string) =>
    (globalThis as any).store.set.mock.calls
      .filter(([name]: [string]) => name === entity)
      .map(([, , props]: [string, string, any]) => props);

  it('should save an EvmTransaction alongside the extrinsic', async () => {
    const extrinsic = mockExtrinsic({ payload: payloads.deploy });
    const expectedId = `0000004242/${`${extrinsic.idx}`.padStart(10, '0')}`;

    await handleExtrinsic(extrinsic);

    expect(saved('Extrinsic')).toHaveLength(1);

    const [evmTransaction] = saved('EvmTransaction');
    expect(evmTransaction).toMatchObject({
      id: expectedId,
      extrinsicId: expectedId,
      blockId: '0000004242',
      callKind: 'instantiate',
      ethTxType: 2,
      fromEthAddress: FROM_ETH,
      fromAccountId: FROM_SS58,
      toEthAddress: undefined,
      value: '0',
      ethNonce: BigInt(7),
      chainId: '1641818',
      input: '0xdeadbeef',
      reverted: false,
    });
  });

  it('should not save an EvmTransaction when the payload cannot be decoded', async () => {
    await handleExtrinsic(mockExtrinsic({ payload: '0xdeadbeef' }));

    expect(saved('Extrinsic')).toHaveLength(1);
    expect(saved('EvmTransaction')).toHaveLength(0);
  });

  it('should not index an account for a sender with no on-chain key record', async () => {
    await handleExtrinsic(mockExtrinsic({ innerCall: INNER_CALL }));

    expect(saved('Account')).toHaveLength(0);
  });

  it('should index the recovered sender as an Ethereum account when it holds a key record', async () => {
    (globalThis as any).api.query.identity.keyRecords = jest.fn().mockResolvedValue({
      isEmpty: false,
      unwrap: () => ({ isPrimaryKey: true, asPrimaryKey: { toString: () => DID } }),
    });

    // A different block from the case above: account resolution is cached per block, negatives
    // included, so the same address cannot answer differently within one block
    await handleExtrinsic(mockExtrinsic({ innerCall: INNER_CALL, blockNumber: 4243 }));

    expect(saved('Account')).toMatchObject([
      {
        id: FROM_SS58,
        address: FROM_SS58,
        identityId: DID,
        keyType: 'ethereum',
        evmAddress: FROM_ETH,
      },
    ]);
  });
});
