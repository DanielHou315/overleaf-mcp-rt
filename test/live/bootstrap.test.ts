import { describe, it, expect } from 'vitest'
import { acquireTarget, isBootstrap } from './helpers.js'

/**
 * Phase one of a matrix run (LIVE_PHASE=bootstrap): register the admin and create
 * the projects, touching no document — a project can only be switched to
 * history-ot while none of its docs is loaded. run-matrix.sh flips the flag in
 * Mongo after this, then runs live.test.ts.
 */
describe.skipIf(!isBootstrap || process.env.LIVE_PHASE !== 'bootstrap')('live bootstrap', () => {
  it('creates one project per OT protocol', async () => {
    const classic = await acquireTarget('sharejs-text-ot')
    const historyOt = await acquireTarget('history-ot')
    expect(classic.projectId).not.toBe(historyOt.projectId)
  }, 10 * 60_000)
})
