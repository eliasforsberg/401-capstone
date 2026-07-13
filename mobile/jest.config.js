// Feature: ai-inventory-manager — Jest configuration
// Using .js format since ts-node is not installed in this project.
/** @type {import('jest').Config} */
const config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
  verbose: true,
};

module.exports = config;
