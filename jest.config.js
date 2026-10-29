/** @type {import('jest').Config} */
// eslint-disable-next-line no-undef
module.exports = {
  globalSetup: './tests/setup.ts',
  globalTeardown: './tests/teardown.ts',
  testEnvironment: 'node',

  collectCoverage: true,
  collectCoverageFrom: ['src/mappings/**/*.ts'],
  coverageDirectory: 'coverage',
  coverageProvider: 'v8',

  transform: {
    '^.+\\.(ts|tsx)?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
    '^.+\\.(js|jsx)$': 'babel-jest',
  },
  transformIgnorePatterns: ['node_modules/(?!(@polkadot|@babel/runtime/helpers/esm|@subql)/)'],
};
