import { beforeEach } from 'vitest'
import { _resetRemoteHostBreaker } from '@plur-ai/core'

// Same rationale as packages/core/test/helpers/reset-remote-breaker-setup.ts:
// the #1069 breaker is process-global by design, which makes it cross-test
// state — and this package's e2e-remote suite drives RemoteStore in-process.
beforeEach(() => {
  _resetRemoteHostBreaker()
})
