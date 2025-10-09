/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',

    // Use the non-deprecated transform config form (no `globals`)
    transform: {
        '^.+\\.tsx?$': [
            'ts-jest',
            {
                useESM: true,
                // Force ts-jest to compile tests/sources as ESM even if tsconfig uses NodeNext
                tsconfig: {
                    module: 'ESNext',
                    moduleResolution: 'NodeNext',
                    isolatedModules: true,
                    esModuleInterop: true,
                },
            },
        ],
    },

    // Treat .ts as ESM in Jest
    extensionsToTreatAsEsm: ['.ts'],

    // Allow `import '../src/foo.js'` in tests while resolving TS sources
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },

    // Keep it simple
    transformIgnorePatterns: ['/node_modules/'],
    testPathIgnorePatterns: ['/dist/'],
};
