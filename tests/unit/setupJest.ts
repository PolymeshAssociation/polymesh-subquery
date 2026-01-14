/**
 * Jest setup file for unit tests.
 * Sets up global mocks and shared test utilities required by SubQuery runtime.
 */

import { Codec } from '@polkadot/types/types';

// ============================================================================
// Shared Test Constants
// ============================================================================

/** Standard test address used across staking tests */
(globalThis as any).TEST_ADDRESS = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

/** Standard test DID used across staking tests */
(globalThis as any).TEST_DID = '0x0100000000000000000000000000000000000000000000000000000000000000';

/** All possible RewardDestination enum values */
(globalThis as any).REWARD_DESTINATIONS = ['Staked', 'Stash', 'Controller', 'Account', 'None'];

// ============================================================================
// Shared Test Helpers
// ============================================================================

/** Creates a mock Codec object for testing */
(globalThis as any).createMockCodec = (value: string | number): Codec => {
  const stringValue = String(value);
  return {
    toString: () => stringValue,
    toJSON: () => value,
    toHuman: () => stringValue,
  } as unknown as Codec;
};

/** Checks if a string contains only digits (used for parameter type detection) */
(globalThis as any).isNumericString = (value: string): boolean => /^\d+$/.test(value);

/** Simulates the getTextValue utility from common.ts */
(globalThis as any).getTextValue = (codec: Codec): string => codec?.toString() || '';

/** Simulates the getBigIntValue utility from common.ts */
(globalThis as any).getBigIntValue = (codec: Codec): bigint => BigInt(codec?.toString() || '0');

// ============================================================================
// SubQuery Runtime Mocks
// ============================================================================

// Mock the global `api` object that SubQuery injects at runtime
(globalThis as any).api = {
  runtimeVersion: {
    specName: {
      toString: () => 'polymesh',
    },
    specVersion: {
      toNumber: () => 8000000,
    },
  },
  query: {},
  tx: {},
  rpc: {},
};

// Mock the global `store` object that SubQuery injects at runtime
(globalThis as any).store = {
  get: jest.fn().mockResolvedValue(undefined),
  getByField: jest.fn().mockResolvedValue([]),
  set: jest.fn().mockResolvedValue(undefined),
  remove: jest.fn().mockResolvedValue(undefined),
  bulkCreate: jest.fn().mockResolvedValue(undefined),
  bulkUpdate: jest.fn().mockResolvedValue(undefined),
};

// Mock the global `logger` if needed
(globalThis as any).logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
