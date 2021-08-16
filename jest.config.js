/** @type {import('@ts-jest/dist/types').InitialOptionsTsJest} */
module.exports = {
  globals: {
    "ts-jest": {
      tsconfig: "tsconfig.test.json",
    },
  },

  testEnvironment: "node",

  collectCoverage: true,
  collectCoverageFrom: ["src/mappings/**/*.ts"],
  coverageDirectory: "coverage",
  coverageProvider: "v8",

  transform: {
    "^.+\\.(ts|tsx)?$": "ts-jest",
    "^.+\\.(js|jsx)$": "babel-jest",
  },
  transformIgnorePatterns: [
    "node_modules/(?!(@polkadot|@babel/runtime/helpers/esm|@subql)/)",
  ],
};
