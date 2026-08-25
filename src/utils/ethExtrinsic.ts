import { GenericCall } from '@polkadot/types';
import { ethereumEncode } from '@polkadot/util-crypto';
import { SubstrateExtrinsic } from '@subql/types';
import { EvmCallKindEnum } from '../types';
import { camelToSnakeCase } from './common';
import { RUNTIME_PALLETS_ADDR, ss58FromEthAddress } from './eth';
import { DecodedEthTx, decodeEthTransaction, ethTxHash, recoverEthSender } from './ethTransaction';

export interface ResolvedEthTransact {
  tx: DecodedEthTx;
  ethTxHash: string;
  /** checksummed address of the Ethereum key that signed the transaction */
  fromEthAddress: string;
  /** SS58 encoding of the `0xEE` padded account the runtime dispatches the call as */
  fromAddress: string;
  callKind: EvmCallKindEnum;
  /** the pallet that is actually dispatched, normalised for `ModuleIdEnum` */
  moduleId: string;
  /** the call that is actually dispatched, normalised for `CallIdEnum` */
  callId: string;
  paramsTxt: string;
  reverted: boolean;
  revertReason?: string;
  /** address of the deployed contract, taken from `revive.Instantiated` */
  contractAddress?: string;
}

/**
 * `revive.eth_transact` is included in the block as a bare extrinsic carrying the RLP encoded
 * Ethereum transaction. The runtime transforms it into `revive.eth_call`,
 * `revive.eth_instantiate_with_code` or `revive.eth_substrate_call` while checking the extrinsic,
 * so the dispatched call only exists in memory and has to be recovered from the payload
 */
export const isEthTransact = (extrinsic?: SubstrateExtrinsic): boolean =>
  extrinsic?.extrinsic.method.section === 'revive' &&
  camelToSnakeCase(extrinsic.extrinsic.method.method) === 'eth_transact';

/**
 * The Ethereum transaction envelope, for the calls that have no runtime call to describe.
 *
 * `input` is deliberately left out. It is the contract's init code for a deployment, which can run
 * to hundreds of kilobytes, and `extrinsics.params_txt` is additionally materialised into the
 * `params` jsonb column by `db/compat.sql`. `EvmTransaction.input` holds it once, under the same id
 */
const extractEthTxParams = (tx: DecodedEthTx) =>
  JSON.stringify({
    to: tx.to ?? null,
    value: tx.value.toString(),
    gasLimit: tx.gasLimit.toString(),
    nonce: tx.nonce.toString(),
  });

const resolveDispatchedCall = (
  extrinsic: SubstrateExtrinsic,
  tx: DecodedEthTx
): Pick<ResolvedEthTransact, 'callKind' | 'moduleId' | 'callId' | 'paramsTxt'> => {
  if (tx.to?.toLowerCase() === RUNTIME_PALLETS_ADDR) {
    try {
      /**
       * The calldata is passed as hex rather than bytes. The registry belongs to the host realm,
       * so a `Uint8Array` built in the sandbox would not pass its own `instanceof` check
       */
      const call = extrinsic.extrinsic.registry.createType(
        'Call',
        tx.data
      ) as unknown as GenericCall;

      return {
        callKind: EvmCallKindEnum.substrateCall,
        moduleId: call.section.toLowerCase(),
        callId: camelToSnakeCase(call.method),
        paramsTxt: JSON.stringify((call.toHuman() as any).args),
      };
    } catch (e) {
      logger.error(`Unable to decode the runtime call of an eth_transact extrinsic: ${e.message}`);

      return {
        callKind: EvmCallKindEnum.substrateCall,
        moduleId: 'revive',
        callId: 'eth_substrate_call',
        paramsTxt: extractEthTxParams(tx),
      };
    }
  }

  if (tx.to === undefined) {
    return {
      callKind: EvmCallKindEnum.instantiate,
      moduleId: 'revive',
      callId: 'eth_instantiate_with_code',
      paramsTxt: extractEthTxParams(tx),
    };
  }

  return {
    callKind: EvmCallKindEnum.call,
    moduleId: 'revive',
    callId: 'eth_call',
    paramsTxt: extractEthTxParams(tx),
  };
};

/**
 * An Ethereum transaction always completes successfully at the extrinsic level, since even a
 * reverted call has to store its receipt. `revive.EthExtrinsicRevert` is the only signal that it
 * actually failed
 */
const extractOutcome = (
  extrinsic: SubstrateExtrinsic
): Pick<ResolvedEthTransact, 'reverted' | 'revertReason' | 'contractAddress'> => {
  let reverted = false;
  let revertReason: string;
  let contractAddress: string;

  extrinsic.events.forEach(({ event }) => {
    if (event.section !== 'revive') {
      return;
    }
    if (event.method === 'EthExtrinsicRevert') {
      reverted = true;
      revertReason = JSON.stringify(event.data[0]?.toHuman());
    }
    if (event.method === 'Instantiated') {
      /**
       * `H160.toString()` renders lower cased hex. Every other address this indexer stores is
       * EIP-55 checksummed, and equality filters are case sensitive, so it has to be normalised
       * for a query to be able to join this against `Account.evmAddress` or `toEthAddress`
       */
      const raw = event.data[1]?.toString();
      contractAddress = raw ? ethereumEncode(raw) : undefined;
    }
  });

  return { reverted, revertReason, contractAddress };
};

let memoBlockId = '';
const memo = new Map<number, ResolvedEthTransact | undefined>();

/**
 * Decodes the Ethereum transaction wrapped by a `revive.eth_transact` extrinsic, or `undefined`
 * for any other extrinsic and for a payload that cannot be decoded.
 *
 * Results are memoized per block, since recovering the signer is comparatively expensive and this
 * is called once for the extrinsic and again for every event it emitted
 */
export const resolveEthTransact = (
  extrinsic: SubstrateExtrinsic
): ResolvedEthTransact | undefined => {
  if (!isEthTransact(extrinsic)) {
    return undefined;
  }

  const blockId = extrinsic.block.block.header.number.toString();

  if (memoBlockId !== blockId) {
    memoBlockId = blockId;
    memo.clear();
  }

  if (memo.has(extrinsic.idx)) {
    return memo.get(extrinsic.idx);
  }

  const resolved = decodeEthTransact(extrinsic);
  memo.set(extrinsic.idx, resolved);

  return resolved;
};

const decodeEthTransact = (extrinsic: SubstrateExtrinsic): ResolvedEthTransact | undefined => {
  const [payload] = extrinsic.extrinsic.args;

  if (!payload) {
    return undefined;
  }

  /**
   * Normalise the bytes into this realm as they cross the sandbox boundary. `u8aToU8a`, which
   * every `@polkadot/util-crypto` helper runs its input through, does not recognise a foreign
   * `Uint8Array` and silently produces the wrong bytes for it
   */
  const raw = Uint8Array.from(payload.toU8a(true));
  const tx = decodeEthTransaction(raw);

  if (!tx) {
    logger.error(
      `Unable to decode the payload of the eth_transact extrinsic at ${extrinsic.block.block.header.number.toString()}/${
        extrinsic.idx
      }`
    );
    return undefined;
  }

  const fromEthAddress = recoverEthSender(tx);

  if (!fromEthAddress) {
    logger.error(
      `Unable to recover the signer of the eth_transact extrinsic at ${extrinsic.block.block.header.number.toString()}/${
        extrinsic.idx
      }`
    );
    return undefined;
  }

  return {
    tx,
    ethTxHash: ethTxHash(raw),
    fromEthAddress,
    fromAddress: ss58FromEthAddress(fromEthAddress, extrinsic.extrinsic.registry.chainSS58),
    ...resolveDispatchedCall(extrinsic, tx),
    ...extractOutcome(extrinsic),
  };
};
