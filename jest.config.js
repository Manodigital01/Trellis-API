module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    // Some deps pulled in by @stellar/stellar-sdk (uint8array-extras, @noble/*,
    // smol-toml, eventsource) publish untranspiled ESM (`export`/`import`) in
    // their .js. Jest ignores node_modules by default (see
    // transformIgnorePatterns below); down-level just those files with an
    // isolated, no-type-check transpile so they load under CommonJS.
    '.+/node_modules/.+\\.js$': ['ts-jest', { isolatedModules: true }],
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  transformIgnorePatterns: [
    // Keep ignoring node_modules EXCEPT the ESM-only chain under
    // @stellar/stellar-sdk, which must be transpiled to load in Jest, and
    // sanitize-html's ESM-only htmlparser2 dependency chain.
    '/node_modules/(?!(@stellar|@noble|@exodus|stellar-base|uint8array-extras|smol-toml|eventsource|htmlparser2|dom-serializer|domhandler|domutils|domelementtype|entities)/)',
    '\\.pnp\\.[^\\/]+$',
  ],
  moduleNameMapper: {
    // Resolve absolute "src/..." imports (tsconfig baseUrl) under rootDir.
    '^src/(.*)$': '<rootDir>/$1',
  },
  collectCoverageFrom: [
    '**/*.(t|j)s',
  ],
  coverageDirectory: '../coverage',
  // Floors set just below the measured baseline so coverage cannot silently
  // drop; raise them as tests are added. Directory keys resolve from the repo
  // root (where `npm run test:cov` runs) and are checked on their own, so
  // their files are left out of the global numbers.
  coverageThreshold: {
    global: { statements: 39, branches: 37, functions: 36, lines: 39 },
    './src/core/auth/': { statements: 33, branches: 20, functions: 26, lines: 32 },
    './src/payments/': { statements: 91, branches: 69, functions: 94, lines: 90 },
    './src/blockchain/': { statements: 22, branches: 23, functions: 19, lines: 21 },
  },
  testEnvironment: 'node',
};
