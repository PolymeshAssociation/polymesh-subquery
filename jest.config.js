/** @type {import('@ts-jest/dist/types').InitialOptionsTsJest} */
module.exports = {
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.test.json',
    },
  },

  globalSetup: './tests/setup.ts',
  globalTeardown: './tests/teardown.ts',
  testEnvironment: 'node',

  collectCoverage: true,
  collectCoverageFrom: ['src/mappings/**/*.ts'],
  coverageDirectory: 'coverage',
  coverageProvider: 'v8',

  transform: {
    '^.+\\.(ts|tsx)?$': 'ts-jest',
    '^.+\\.(js|jsx)$': 'babel-jest',
  },
  transformIgnorePatterns: ['node_modules/(?!(@polkadot|@babel/runtime/helpers/esm|@subql)/)'],

  // TODO @prashantasdeveloper remove `testPathIgnorePatterns` when all entities are migrated
  testPathIgnorePatterns: ['tests/integration/'],
};
