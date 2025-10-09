import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',
    transform: {
        '^.+\\.tsx?$': ['ts-jest', { useESM: true }],
    },
    moduleNameMapper: {
        // help Jest resolve ESM TS paths with .js in imports
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    testMatch: ['**/tests/**/*.spec.ts'],
    testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    extensionsToTreatAsEsm: ['.ts'],
    // quiet down ESM warnings
    verbose: false
};

export default config;
