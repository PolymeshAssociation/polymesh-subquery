/**
 * Type declarations for SubQuery runtime globals and shared test utilities.
 * Note: The `store` global type is provided by @subql/types-core
 */

import { ApiPromise } from '@polkadot/api';
import { ApiDecoration } from '@polkadot/api/types';
import { Codec } from '@polkadot/types/types';

type ApiAt = ApiDecoration<'promise'> & {
  rpc: ApiPromise['rpc'];
};

declare global {
  // SubQuery runtime globals
  const api: ApiAt;
  const unsafeApi: ApiPromise | undefined;
  const logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };

  // Shared test constants
  /** Standard test address used across staking tests */
  const TEST_ADDRESS: string;
  /** Standard test DID used across staking tests */
  const TEST_DID: string;
  /** All possible RewardDestination enum values */
  const REWARD_DESTINATIONS: readonly string[];

  // Shared test helpers
  /** Creates a mock Codec object for testing */
  const createMockCodec: (value: string | number) => Codec;
  /** Checks if a string contains only digits (used for parameter type detection) */
  const isNumericString: (value: string) => boolean;
  /** Simulates the getTextValue utility from common.ts */
  const getTextValue: (codec: Codec) => string;
  /** Simulates the getBigIntValue utility from common.ts */
  const getBigIntValue: (codec: Codec) => bigint;
}

export {};
