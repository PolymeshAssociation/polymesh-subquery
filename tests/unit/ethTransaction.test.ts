import { hexToU8a } from '@polkadot/util';
import { decodeEthTransaction, ethTxHash, recoverEthSender } from '../../src/utils/ethTransaction';

/**
 * All fixtures are signed by the well known key
 * `0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318` and were produced with
 * `viem`/`ethers`, so recovering this address proves the signing payload is reconstructed correctly
 */
const FROM = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const RUNTIME_PALLETS_ADDR = '0x6D6f646c70792F70616464720000000000000000';
const CHAIN_ID = BigInt(1641818);

/** SCALE encoded runtime call used as the calldata of the runtime call fixtures */
const RUNTIME_CALL_DATA = '0x1a0400d1070000';

const fixtures = {
  /** legacy, pre EIP-155 (v = 28, no chain id) */
  preEip155:
    '0xf86a07843b9aca00825208946d6f646c70792f7061646472000000000000000080871a0400d10700001ca0fc002ddd590397eb57d80accad2187139a588efec1c0e1690f204630df6a9f9da07555591dd0cdf2c438a8d7c09aadf3a1315d581867d14be2875b3289a6fc8754',
  /** legacy, EIP-155 protected */
  legacy:
    '0xf86d07843b9aca00825208946d6f646c70792f7061646472000000000000000080871a0400d107000083321ad7a09cccde7ed1a91a9ccb998fda4e84905a535c04038e89c238e8cd01dd179afd79a039f778f34a3fe7dee7e904339f1717cbb230499a9b3a809c0f90a2940792357a',
  /** EIP-2930 with an empty access list */
  eip2930:
    '0x01f86f83190d5a07843b9aca00825208946d6f646c70792f7061646472000000000000000080871a0400d1070000c001a0061b3f7b36bfe94ac9efac1f84c1396d20b7d142f7b67057f847b15315bad211a0650fedb72ed5a3212585008fb0d35d8d873d53964321ebd8e13374ffdabb34e8',
  /** EIP-2930 with a populated access list, which must be re-encoded verbatim */
  eip2930AccessList:
    '0x01f8a883190d5a07843b9aca00825208946d6f646c70792f7061646472000000000000000080871a0400d1070000f838f7941111111111111111111111111111111111111111e1a0222222222222222222222222222222222222222222222222222222222222222280a0033705865ce8025fa872a1f08012f758da539edc676322c57790be03293f8337a07cfda1455f125dcfd331cfcce0989a74061747e53bdadfc95e9aa9925fc920dd',
  /** EIP-1559 */
  eip1559:
    '0x02f87083190d5a07808477359400825208946d6f646c70792f7061646472000000000000000080871a0400d1070000c080a01ad9580e471e8fd43d716a5a772b0b3191282b2dc425fcefd0eb774980462976a005d32e0074b587c871dd0fe6a8e53572798570d2146410790e0d7ea19f94961b',
  /** EIP-1559 contract deployment, `to` is absent */
  deploy:
    '0x02f85983190d5a07808477359400825208808084deadbeefc001a0678b44834b3ccc478253db225af42f9fc25d27e18453338d164b3ce62816aa4fa01c8f9951ee084d5e707172f7c5bce88b578db99d730c4d19e972aa4c487adc0e',
  /** EIP-1559 contract call carrying a non zero value */
  contract:
    '0x02f86e83190d5a0780847735940082520894111111111111111111111111111111111111111182303983abcdefc001a0e1b9d314aef5057b2802806da131c5ba18badfac2d8fa4566833dddc6612de41a077ac570d496b96b87039d116fff59777299856720536ba683e6a6014be3b0f6d',
};

describe('decodeEthTransaction + recoverEthSender', () => {
  it.each(Object.entries(fixtures))('should recover the signer of the %s fixture', (_, raw) => {
    const tx = decodeEthTransaction(hexToU8a(raw));

    expect(tx).toBeDefined();
    expect(recoverEthSender(tx)).toEqual(FROM);
  });

  it('should decode a pre EIP-155 legacy transaction without a chain id', () => {
    const tx = decodeEthTransaction(hexToU8a(fixtures.preEip155));

    expect(tx.txType).toEqual(0);
    expect(tx.chainId).toBeUndefined();
    expect(tx.gasPrice).toEqual(BigInt(1000000000));
  });

  it('should decode a legacy transaction', () => {
    const tx = decodeEthTransaction(hexToU8a(fixtures.legacy));

    expect(tx.txType).toEqual(0);
    expect(tx.chainId).toEqual(CHAIN_ID);
    expect(tx.nonce).toEqual(BigInt(7));
    expect(tx.to).toEqual(RUNTIME_PALLETS_ADDR);
    expect(tx.value).toEqual(BigInt(0));
    expect(tx.data).toEqual(RUNTIME_CALL_DATA);
    expect(tx.gasLimit).toEqual(BigInt(21000));
    expect(tx.gasPrice).toEqual(BigInt(1000000000));
    expect(tx.maxFeePerGas).toBeUndefined();
  });

  it('should decode an EIP-2930 transaction', () => {
    const tx = decodeEthTransaction(hexToU8a(fixtures.eip2930));

    expect(tx.txType).toEqual(1);
    expect(tx.chainId).toEqual(CHAIN_ID);
    expect(tx.gasPrice).toEqual(BigInt(1000000000));
    expect(tx.data).toEqual(RUNTIME_CALL_DATA);
  });

  it('should decode an EIP-1559 transaction', () => {
    const tx = decodeEthTransaction(hexToU8a(fixtures.eip1559));

    expect(tx.txType).toEqual(2);
    expect(tx.chainId).toEqual(CHAIN_ID);
    expect(tx.maxFeePerGas).toEqual(BigInt(2000000000));
    expect(tx.maxPriorityFeePerGas).toEqual(BigInt(0));
    expect(tx.gasPrice).toBeUndefined();
  });

  it('should leave `to` undefined for a contract deployment', () => {
    const tx = decodeEthTransaction(hexToU8a(fixtures.deploy));

    expect(tx.to).toBeUndefined();
    expect(tx.data).toEqual('0xdeadbeef');
  });

  it('should decode a value bearing contract call', () => {
    const tx = decodeEthTransaction(hexToU8a(fixtures.contract));

    expect(tx.to).toEqual('0x1111111111111111111111111111111111111111');
    expect(tx.value).toEqual(BigInt(12345));
    expect(tx.data).toEqual('0xabcdef');
  });

  it('should return undefined for unsupported and malformed payloads', () => {
    // EIP-4844 and EIP-7702 are rejected by the runtime before inclusion
    expect(decodeEthTransaction(hexToU8a('0x03c0'))).toBeUndefined();
    expect(decodeEthTransaction(hexToU8a('0x04c0'))).toBeUndefined();
    expect(decodeEthTransaction(new Uint8Array())).toBeUndefined();
    expect(decodeEthTransaction(hexToU8a('0xdeadbeef'))).toBeUndefined();
    // a legacy transaction with an invalid `v`
    expect(decodeEthTransaction(hexToU8a('0xc9808080808080808080'))).toBeUndefined();
  });
});

describe('ethTxHash', () => {
  it('should be the keccak256 of the raw payload', () => {
    expect(ethTxHash(hexToU8a(fixtures.eip1559))).toEqual(
      '0xc5a3bbd37bc19ccfc6d8956f68fd13cfa397a7ed40b956c9414e2e9ad4707500'
    );
  });
});
