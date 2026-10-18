// The real exec adapter behind the shared ExecFn (#1638). It must pass env,
// timeout and stdin through (the narrower type dropped env and timeout), turn a
// timeout into a non-zero status, and never run a .cmd/.bat without a shell on
// Windows (spawnSync gives EINVAL there; a shell would re-parse the arguments).
import { describe, it, expect } from 'vitest'
import { createExec, EXEC_TIMEOUT_STATUS, EXEC_START_FAILED_STATUS, EXEC_REFUSED_STATUS } from '../src/enterprise/exec.js'
import type { ExecFn as LaunchCheckExecFn } from '../src/enterprise/launch-check.js'
import type { ExecFn } from '../src/enterprise/exec.js'

const node = process.execPath
const exec = createExec(process.platform)

describe('createExec', () => {
  it('passes the env through', () => {
    const r = exec(node, ['-e', 'process.stdout.write(process.env.PLUR_EXEC_PROBE ?? "unset")'], {
      env: { ...process.env, PLUR_EXEC_PROBE: 'from-env' },
    })
    expect(r).toEqual({ status: 0, stdout: 'from-env' })
  })

  it('passes stdin through', () => {
    const r = exec(node, ['-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(s.toUpperCase()))'], {
      input: 'hello',
    })
    expect(r).toEqual({ status: 0, stdout: 'HELLO' })
  })

  it('a timeout is a non-zero status, not null', () => {
    const r = exec(node, ['-e', 'setTimeout(()=>{}, 10000)'], { timeoutMs: 300 })
    expect(r.status).toBe(EXEC_TIMEOUT_STATUS)
  })

  it('a command that cannot start is a non-zero status, not a throw', () => {
    const r = exec('plur-no-such-command-xyz', [])
    expect(r).toEqual({ status: EXEC_START_FAILED_STATUS, stdout: '' })
  })

  it('a non-zero exit is reported as is', () => {
    expect(exec(node, ['-e', 'process.exit(3)']).status).toBe(3)
  })

  it('win32: a .cmd or .bat is refused without being started', () => {
    const win = createExec('win32')
    for (const cmd of ['C:\\npm\\npx.cmd', 'C:\\tools\\plur.BAT']) {
      expect(win(cmd, ['--version'])).toEqual({ status: EXEC_REFUSED_STATUS, stdout: '' })
    }
  })

  it('launch-check uses the same ExecFn type', () => {
    const f: ExecFn = exec
    const g: LaunchCheckExecFn = f
    expect(typeof g).toBe('function')
  })
})
