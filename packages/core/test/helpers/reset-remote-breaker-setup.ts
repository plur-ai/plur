import { beforeEach } from 'vitest'
import { _resetRemoteHostBreaker } from '../../src/store/remote-store.js'

/**
 * The #1069 host breaker is deliberately process-global — that is its whole
 * job in production — which makes it cross-test state in a suite: one test
 * simulating a network failure marks its fixture host down, and every later
 * test against the same URL fast-fails with "host marked unreachable" instead
 * of exercising what it meant to (broke outbox, remote-routing,
 * remote-store-cache, supersedes-flush-remap and walk-cannot-tell on CI the
 * day it landed). Reset it before every test, suite-wide, so no future test
 * file has to know the breaker exists.
 */
beforeEach(() => {
  _resetRemoteHostBreaker()
})
