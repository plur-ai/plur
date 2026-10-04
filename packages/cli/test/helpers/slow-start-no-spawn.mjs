// Test preload (#1318 review): model a slow Node start and a failed worker
// spawn, so hook-auto-rate takes its inline path late in the editor's budget.
// PLUR_TEST_SLOW_START_MS blocks startup; child_process.spawn always throws.
import { createRequire, syncBuiltinESMExports } from 'node:module'

const require = createRequire(import.meta.url)
const cp = require('node:child_process')
cp.spawn = () => { throw new Error('spawn disabled by test preload') }
syncBuiltinESMExports()

const ms = parseInt(process.env.PLUR_TEST_SLOW_START_MS ?? '0', 10)
if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
