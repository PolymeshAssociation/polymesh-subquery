import { RLP } from '@ethereumjs/rlp';
import { u8aConcat, u8aToHex } from '@polkadot/util';
import { ethereumEncode, keccakAsHex, keccakAsU8a, secp256k1Recover } from '@polkadot/util-crypto';

export const ETH_TX_TYPE_LEGACY = 0;
export const ETH_TX_TYPE_EIP2930 = 1;
export const ETH_TX_TYPE_EIP1559 = 2;

export interface DecodedEthTx {
  /** 0 = legacy, 1 = EIP-2930, 2 = EIP-1559. EIP-4844/7702 are rejected by the chain */
  txType: 0 | 1 | 2;
  chainId?: bigint;
  nonce: bigint;
  /** `undefined` for a contract deployment */
  to?: string;
  value: bigint;
  /** hex encoded calldata. For a runtime call this is a SCALE encoded `RuntimeCall` */
  data: string;
  gasLimit: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  /** keccak256 of the signing payload, i.e. the message the signature covers */
  sigHash: Uint8Array;
  signature: Uint8Array;
  recovery: number;
}

const SIGNATURE_COMPONENT_LENGTH = 32;
const H160_LENGTH = 20;

/**
 * Mappings run inside a vm2 sandbox, where an `instanceof Uint8Array` check against the bundle's
 * own realm does not hold for values that crossed the boundary. `ArrayBuffer.isView` inspects the
 * internal slot instead, so it works across realms
 */
const isBytes = (item: unknown): item is Uint8Array => ArrayBuffer.isView(item);

const toBigInt = (item: Uint8Array): bigint => {
  if (item.length === 0) {
    return BigInt(0);
  }
  return BigInt(u8aToHex(item));
};

const toAddress = (item: Uint8Array): string | undefined =>
  item.length === H160_LENGTH ? ethereumEncode(item) : undefined;

const padSignatureComponent = (item: Uint8Array): Uint8Array => {
  const padded = new Uint8Array(SIGNATURE_COMPONENT_LENGTH);
  padded.set(item, SIGNATURE_COMPONENT_LENGTH - item.length);
  return padded;
};

/**
 * The hash an Ethereum wallet reports for a transaction, and the hash `pallet_revive` uses when
 * building the ethereum block. See `evm/block_hash/block_builder.rs`
 */
export const ethTxHash = (payload: Uint8Array): string => keccakAsHex(Uint8Array.from(payload));

const decodeLegacy = (payload: Uint8Array): DecodedEthTx | undefined => {
  const fields = RLP.decode(payload);

  if (!Array.isArray(fields) || fields.length !== 9 || !fields.every(isBytes)) {
    return undefined;
  }

  const [nonce, gasPrice, gasLimit, to, value, data, v, r, s] = fields as Uint8Array[];

  const rawV = toBigInt(v);
  const unsigned = [nonce, gasPrice, gasLimit, to, value, data];

  let chainId: bigint | undefined;
  let recovery: number;
  let sigHash: Uint8Array;

  if (rawV === BigInt(27) || rawV === BigInt(28)) {
    // pre EIP-155, the signature covers the transaction fields only
    recovery = Number(rawV) - 27;
    sigHash = keccakAsU8a(RLP.encode(unsigned));
  } else if (rawV >= BigInt(35)) {
    chainId = (rawV - BigInt(35)) / BigInt(2);
    recovery = Number((rawV - BigInt(35)) % BigInt(2));
    sigHash = keccakAsU8a(RLP.encode([...unsigned, chainId, new Uint8Array(), new Uint8Array()]));
  } else {
    return undefined;
  }

  return {
    txType: ETH_TX_TYPE_LEGACY,
    chainId,
    nonce: toBigInt(nonce),
    to: toAddress(to),
    value: toBigInt(value),
    data: u8aToHex(data),
    gasLimit: toBigInt(gasLimit),
    gasPrice: toBigInt(gasPrice),
    sigHash,
    signature: u8aConcat(padSignatureComponent(r), padSignatureComponent(s)),
    recovery,
  };
};

const decodeEip2930 = (payload: Uint8Array): DecodedEthTx | undefined => {
  const fields = RLP.decode(payload.subarray(1));

  if (!Array.isArray(fields) || fields.length !== 11) {
    return undefined;
  }

  const [chainId, nonce, gasPrice, gasLimit, to, value, data, accessList, yParity, r, s] = fields;

  if (![chainId, nonce, gasPrice, gasLimit, to, value, data, yParity, r, s].every(isBytes)) {
    return undefined;
  }

  const unsigned = [chainId, nonce, gasPrice, gasLimit, to, value, data, accessList];

  return {
    txType: ETH_TX_TYPE_EIP2930,
    chainId: toBigInt(chainId as Uint8Array),
    nonce: toBigInt(nonce as Uint8Array),
    to: toAddress(to as Uint8Array),
    value: toBigInt(value as Uint8Array),
    data: u8aToHex(data as Uint8Array),
    gasLimit: toBigInt(gasLimit as Uint8Array),
    gasPrice: toBigInt(gasPrice as Uint8Array),
    sigHash: keccakAsU8a(u8aConcat(new Uint8Array([ETH_TX_TYPE_EIP2930]), RLP.encode(unsigned))),
    signature: u8aConcat(
      padSignatureComponent(r as Uint8Array),
      padSignatureComponent(s as Uint8Array)
    ),
    recovery: Number(toBigInt(yParity as Uint8Array)),
  };
};

const decodeEip1559 = (payload: Uint8Array): DecodedEthTx | undefined => {
  const fields = RLP.decode(payload.subarray(1));

  if (!Array.isArray(fields) || fields.length !== 12) {
    return undefined;
  }

  const [
    chainId,
    nonce,
    maxPriorityFeePerGas,
    maxFeePerGas,
    gasLimit,
    to,
    value,
    data,
    accessList,
    yParity,
    r,
    s,
  ] = fields;

  const scalars = [
    chainId,
    nonce,
    maxPriorityFeePerGas,
    maxFeePerGas,
    gasLimit,
    to,
    value,
    data,
    yParity,
    r,
    s,
  ];

  if (!scalars.every(isBytes)) {
    return undefined;
  }

  const unsigned = [
    chainId,
    nonce,
    maxPriorityFeePerGas,
    maxFeePerGas,
    gasLimit,
    to,
    value,
    data,
    accessList,
  ];

  return {
    txType: ETH_TX_TYPE_EIP1559,
    chainId: toBigInt(chainId as Uint8Array),
    nonce: toBigInt(nonce as Uint8Array),
    to: toAddress(to as Uint8Array),
    value: toBigInt(value as Uint8Array),
    data: u8aToHex(data as Uint8Array),
    gasLimit: toBigInt(gasLimit as Uint8Array),
    maxFeePerGas: toBigInt(maxFeePerGas as Uint8Array),
    maxPriorityFeePerGas: toBigInt(maxPriorityFeePerGas as Uint8Array),
    sigHash: keccakAsU8a(u8aConcat(new Uint8Array([ETH_TX_TYPE_EIP1559]), RLP.encode(unsigned))),
    signature: u8aConcat(
      padSignatureComponent(r as Uint8Array),
      padSignatureComponent(s as Uint8Array)
    ),
    recovery: Number(toBigInt(yParity as Uint8Array)),
  };
};

/**
 * Decodes the RLP payload of a `revive.ethTransact` extrinsic.
 *
 * Returns `undefined` for anything that cannot be decoded, including the EIP-4844 and EIP-7702
 * transaction types, which the runtime rejects before they can be included in a block
 */
export const decodeEthTransaction = (rawPayload: Uint8Array): DecodedEthTx | undefined => {
  if (rawPayload.length === 0) {
    return undefined;
  }

  /**
   * Mappings run inside a vm2 sandbox, so the bytes handed to us belong to a different realm than
   * the bundled RLP codec, whose own `instanceof Uint8Array` checks would reject them. Copying
   * into a local array makes every value derived from it, including the decoded fields that are
   * re-encoded to rebuild the signing payload, safe to pass back in
   */
  const payload = Uint8Array.from(rawPayload);

  try {
    const firstByte = payload[0];

    // EIP-2718 typed transactions use a type identifier in [0x00, 0x7f]
    if (firstByte > 0x7f) {
      return decodeLegacy(payload);
    }
    if (firstByte === ETH_TX_TYPE_EIP2930) {
      return decodeEip2930(payload);
    }
    if (firstByte === ETH_TX_TYPE_EIP1559) {
      return decodeEip1559(payload);
    }

    return undefined;
  } catch (e) {
    logger.error(`Unable to RLP decode an Ethereum transaction: ${e.message}`);
    return undefined;
  }
};

/**
 * Recovers the checksummed Ethereum address that signed the transaction
 */
export const recoverEthSender = (tx: DecodedEthTx): string | undefined => {
  if (tx.recovery !== 0 && tx.recovery !== 1) {
    return undefined;
  }

  try {
    return ethereumEncode(secp256k1Recover(tx.sigHash, tx.signature, tx.recovery));
  } catch (e) {
    logger.error(`Unable to recover the signer of an Ethereum transaction: ${e.message}`);
    return undefined;
  }
};
