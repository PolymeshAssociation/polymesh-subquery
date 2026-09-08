import { hexToU8a } from '@polkadot/util';
import { SubstrateExtrinsic } from '@subql/types';
import { createExtrinsic, handleExtrinsic } from '../../src/mappings/entities/block/mapExtrinsic';

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

const INNER_CALL = { section: 'asset', method: 'issue', args: { asset_id: '0x1234' } };

interface MockOptions {
  section?: string;
  method?: string;
  payload?: string;
  events?: { section: string; method: string; data: any[] }[];
  success?: boolean;
  innerCall?: { section: string; method: string; args: Record<string, unknown> };
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
          return {
            section: innerCall.section,
            method: innerCall.method,
            toHuman: () => ({ args: innerCall.args }),
          };
        },
      },
      method: { section, method },
      args: [{ toU8a: () => hexToU8a(payload) }],
      toHuman: () => ({ method: { args: { payload } } }),
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
    expect(extrinsic.paramsTxt).toEqual(JSON.stringify(INNER_CALL.args));
  });

  it('should use the Ethereum nonce rather than the (always zero) extrinsic nonce', () => {
    expect(createExtrinsic(mockExtrinsic({ innerCall: INNER_CALL })).nonce).toEqual(7);
  });

  it('should omit the init code from paramsTxt, since EvmTransaction stores it', () => {
    const extrinsic = createExtrinsic(mockExtrinsic({ payload: payloads.deploy }));

    expect(extrinsic.callId).toEqual('eth_instantiate_with_code');
    expect(JSON.parse(extrinsic.paramsTxt)).toEqual({
      to: null,
      value: '0',
      gasLimit: '21000',
      nonce: '7',
    });
    expect(extrinsic.paramsTxt).not.toContain('deadbeef');
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
      callKind: 'instantiate',
      ethTxType: 2,
      fromEthAddress: FROM_ETH,
      fromAddress: FROM_SS58,
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
      toJSON: () => ({ primaryKey: DID }),
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

  it('should record a successful revive.mapAccount', async () => {
    await handleExtrinsic(
      mockExtrinsic({
        section: 'revive',
        method: 'mapAccount',
        signer: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
        ss58Format: 42,
      })
    );

    expect(saved('EvmAccountMapping')).toMatchObject([
      {
        // keccak256(<Alice's public key>)[12..], as `AddressMapper::to_address` derives it
        id: '0x9621DDe636dE098B43Efb0fA9b61fAcFE328F99D',
        address: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
        mapped: true,
      },
    ]);
  });

  it('should record revive.unmapAccount as no longer mapped', async () => {
    await handleExtrinsic(
      mockExtrinsic({
        section: 'revive',
        method: 'unmapAccount',
        signer: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
        ss58Format: 42,
      })
    );

    expect(saved('EvmAccountMapping')[0]).toMatchObject({ mapped: false });
  });

  it('should update an existing mapping rather than creating a second row', async () => {
    const id = '0x9621DDe636dE098B43Efb0fA9b61fAcFE328F99D';
    // as if seeded from the genesis `mapped_accounts` config
    (globalThis as any).store.get = jest.fn().mockResolvedValue({
      id,
      evmAddress: id,
      address: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
      mapped: true,
      datetime: new Date(0),
      createdBlockId: '0000000000',
      updatedBlockId: '0000000000',
    });

    await handleExtrinsic(
      mockExtrinsic({
        section: 'revive',
        method: 'unmapAccount',
        signer: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
        ss58Format: 42,
      })
    );

    expect(saved('EvmAccountMapping')).toMatchObject([
      {
        id,
        mapped: false,
        // the genesis creation block is preserved, only the update block moves
        createdBlockId: '0000000000',
        updatedBlockId: '0000004242',
      },
    ]);
  });

  it('should ignore a failed mapping call', async () => {
    await handleExtrinsic(
      mockExtrinsic({ section: 'revive', method: 'mapAccount', signer: 'x', success: false })
    );

    expect(saved('EvmAccountMapping')).toHaveLength(0);
  });
});
