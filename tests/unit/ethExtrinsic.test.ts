import { hexToU8a } from '@polkadot/util';
import { SubstrateExtrinsic } from '@subql/types';
import { EvmCallKindEnum } from '../../src/types';
import { isEthTransact, resolveEthTransact } from '../../src/utils/ethExtrinsic';

const FROM_ETH = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
/** `FROM_ETH` padded with 12 `0xEE` bytes and SS58 encoded with the Polymesh prefix */
const FROM_SS58 = '2DTD2fX3yEHNTRURNtwZS9r9hqzFUNmzoMK1t9WWMauH9wkc';

const fixtures = {
  runtimeCall:
    '0x02f87083190d5a07808477359400825208946d6f646c70792f7061646472000000000000000080871a0400d1070000c080a01ad9580e471e8fd43d716a5a772b0b3191282b2dc425fcefd0eb774980462976a005d32e0074b587c871dd0fe6a8e53572798570d2146410790e0d7ea19f94961b',
  deploy:
    '0x02f85983190d5a07808477359400825208808084deadbeefc001a0678b44834b3ccc478253db225af42f9fc25d27e18453338d164b3ce62816aa4fa01c8f9951ee084d5e707172f7c5bce88b578db99d730c4d19e972aa4c487adc0e',
  contractCall:
    '0x02f86e83190d5a0780847735940082520894111111111111111111111111111111111111111182303983abcdefc001a0e1b9d314aef5057b2802806da131c5ba18badfac2d8fa4566833dddc6612de41a077ac570d496b96b87039d116fff59777299856720536ba683e6a6014be3b0f6d',
};

interface MockOptions {
  section?: string;
  method?: string;
  payload?: string;
  events?: { section: string; method: string; data: any[] }[];
  /** the call `registry.createType('Call', ...)` resolves the runtime call calldata to */
  innerCall?: { section: string; method: string; args: Record<string, unknown> };
  blockNumber?: number;
  idx?: number;
}

const mockExtrinsic = ({
  section = 'revive',
  method = 'ethTransact',
  payload = fixtures.runtimeCall,
  events = [],
  innerCall,
  blockNumber = 1000,
  idx = 1,
}: MockOptions = {}): SubstrateExtrinsic => {
  const registry = {
    chainSS58: 12,
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
  };

  return {
    idx,
    success: true,
    events: events.map(({ section: s, method: m, data }) => ({
      event: { section: s, method: m, data },
    })),
    block: {
      block: { header: { number: { toString: () => `${blockNumber}` } } },
    },
    extrinsic: {
      registry,
      method: { section, method },
      args: [{ toU8a: () => hexToU8a(payload) }],
    },
  } as unknown as SubstrateExtrinsic;
};

describe('isEthTransact', () => {
  it('should identify a revive.ethTransact extrinsic', () => {
    expect(isEthTransact(mockExtrinsic())).toBe(true);
  });

  it('should reject other revive calls and other pallets', () => {
    expect(isEthTransact(mockExtrinsic({ method: 'ethCall' }))).toBe(false);
    expect(isEthTransact(mockExtrinsic({ section: 'utility', method: 'batch' }))).toBe(false);
    expect(isEthTransact(undefined)).toBe(false);
  });
});

describe('resolveEthTransact', () => {
  it('should attribute the transaction to the signing Ethereum key', () => {
    const resolved = resolveEthTransact(mockExtrinsic({ innerCall: RUNTIME_CALL }));

    expect(resolved.fromEthAddress).toEqual(FROM_ETH);
    expect(resolved.fromAddress).toEqual(FROM_SS58);
    expect(resolved.ethTxHash).toEqual(
      '0xc5a3bbd37bc19ccfc6d8956f68fd13cfa397a7ed40b956c9414e2e9ad4707500'
    );
  });

  it('should normalise a runtime call to the pallet and call it dispatches', () => {
    const resolved = resolveEthTransact(mockExtrinsic({ innerCall: RUNTIME_CALL }));

    expect(resolved.callKind).toEqual(EvmCallKindEnum.substrateCall);
    expect(resolved.moduleId).toEqual('asset');
    expect(resolved.callId).toEqual('issue');
    expect(resolved.paramsTxt).toEqual(JSON.stringify(RUNTIME_CALL.args));
  });

  it('should fall back to eth_substrate_call when the runtime call cannot be decoded', () => {
    const resolved = resolveEthTransact(mockExtrinsic({ idx: 2 }));

    expect(resolved.callKind).toEqual(EvmCallKindEnum.substrateCall);
    expect(resolved.moduleId).toEqual('revive');
    expect(resolved.callId).toEqual('eth_substrate_call');
  });

  it('should resolve a contract deployment', () => {
    const resolved = resolveEthTransact(
      mockExtrinsic({
        idx: 3,
        payload: fixtures.deploy,
        events: [{ section: 'revive', method: 'Instantiated', data: [FROM_ETH, CONTRACT_ADDRESS] }],
      })
    );

    expect(resolved.callKind).toEqual(EvmCallKindEnum.instantiate);
    expect(resolved.moduleId).toEqual('revive');
    expect(resolved.callId).toEqual('eth_instantiate_with_code');
    expect(resolved.contractAddress).toEqual(CONTRACT_ADDRESS);
    expect(resolved.tx.to).toBeUndefined();
  });

  it('should resolve a contract call', () => {
    const resolved = resolveEthTransact(mockExtrinsic({ idx: 4, payload: fixtures.contractCall }));

    expect(resolved.callKind).toEqual(EvmCallKindEnum.call);
    expect(resolved.moduleId).toEqual('revive');
    expect(resolved.callId).toEqual('eth_call');
    expect(resolved.reverted).toBe(false);
    expect(resolved.revertReason).toBeUndefined();
  });

  it('should flag a reverted transaction', () => {
    const resolved = resolveEthTransact(
      mockExtrinsic({
        idx: 5,
        payload: fixtures.contractCall,
        events: [
          {
            section: 'revive',
            method: 'EthExtrinsicRevert',
            data: [{ toHuman: () => ({ Module: { index: '80', error: '0x0c000000' } }) }],
          },
        ],
      })
    );

    expect(resolved.reverted).toBe(true);
    expect(resolved.revertReason).toEqual(
      JSON.stringify({ Module: { index: '80', error: '0x0c000000' } })
    );
  });

  it('should memoize per extrinsic and evict when the block changes', () => {
    const createType = jest.fn().mockReturnValue({
      section: 'asset',
      method: 'issue',
      toHuman: () => ({ args: {} }),
    });
    const extrinsic = mockExtrinsic({ idx: 6, innerCall: RUNTIME_CALL });
    (extrinsic.extrinsic.registry as any).createType = createType;

    resolveEthTransact(extrinsic);
    resolveEthTransact(extrinsic);
    expect(createType).toHaveBeenCalledTimes(1);

    const nextBlock = mockExtrinsic({ idx: 6, blockNumber: 1001, innerCall: RUNTIME_CALL });
    (nextBlock.extrinsic.registry as any).createType = createType;
    resolveEthTransact(nextBlock);
    expect(createType).toHaveBeenCalledTimes(2);
  });

  it('should return undefined for an undecodable payload', () => {
    expect(resolveEthTransact(mockExtrinsic({ idx: 7, payload: '0xdeadbeef' }))).toBeUndefined();
  });
});

const CONTRACT_ADDRESS = '0x9621DDe636dE098B43Efb0fA9b61fAcFE328F99D';
const RUNTIME_CALL = {
  section: 'asset',
  method: 'issue',
  args: { asset_id: '0x1234', amount: '1,000' },
};
