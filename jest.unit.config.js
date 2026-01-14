/** @type {import('@ts-jest/dist/types').InitialOptionsTsJest} */
// Unit test configuration - runs without Docker/integration setup
// eslint-disable-next-line no-undef
module.exports = {
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.test.json',
    },
  },

  // Setup file to initialize globals before tests
  setupFilesAfterEnv: ['<rootDir>/tests/unit/setupJest.ts'],

  // No globalSetup/globalTeardown - unit tests run standalone
  testEnvironment: 'node',

  // Only run unit tests
  testMatch: ['**/tests/unit/**/*.test.ts'],

  collectCoverage: true,
  collectCoverageFrom: ['src/mappings/**/*.ts', 'src/utils/**/*.ts'],
  coverageDirectory: 'coverage-unit',
  coverageProvider: 'v8',

  transform: {
    '^.+\\.(ts|tsx)?$': 'ts-jest',
    '^.+\\.(js|jsx)$': 'babel-jest',
  },
  transformIgnorePatterns: ['node_modules/(?!(@polkadot|@babel/runtime/helpers/esm|@subql)/)'],

  // Clear mocks between tests
  clearMocks: true,
  resetMocks: true,
};
