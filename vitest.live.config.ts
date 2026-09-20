import { defineConfig } from 'vitest/config'

// The live suite (test/live): the built server against a real Overleaf.
// Skips itself unless LIVE_OVERLEAF_URL or LIVE_HOST is set — see test/live/README.md.
export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    // One scenario builds on the previous one's state (scratch folder, seen docs).
    sequence: { concurrent: false },
    reporters: ['verbose'],
  },
})
