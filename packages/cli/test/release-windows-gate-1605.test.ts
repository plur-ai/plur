import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join, resolve, delimiter } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'

const gate = resolve(__dirname, '../../../scripts/release-windows-gate.sh')
const row = (event: string, conclusion = 'success', time = '2026-10-05T12:00:00Z', status = 'completed') =>
  ['1', status, conclusion, time, event].join('\t')
function run(rows: string[], queryFails = false) {
  const dir = mkdtempSync(join(tmpdir(), 'plur-gate-'))
  try {
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\n[ "$GATE_QUERY_FAIL" != "1" ] || exit 1\nprintf "%s\\n" "$GATE_ROWS"\n', { mode: 0o755 })
    return spawnSync('bash', [gate, 'a'.repeat(40)], { encoding: 'utf8',
      env: { ...process.env, PATH: dir + delimiter + process.env.PATH, GATE_ROWS: rows.join('\n'), GATE_QUERY_FAIL: queryFails ? '1' : '0' } })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
describe.skipIf(process.platform === 'win32')('Windows release gate requires mandatory-editor evidence (#1605)', () => {
  it.each(['push', 'workflow_dispatch'])('accepts a successful %s run', event => {
    expect(run([row(event)]).status).toBe(0)
  })
  it.each(['pull_request', 'schedule', 'workflow_call'])('rejects a %s success alone', event => {
    expect(run([row(event)]).status).toBe(1)
  })
  it('a later PR rerun cannot mask a failed push', () => {
    expect(run([row('push', 'failure'), row('pull_request', 'success', '2026-10-05T13:00:00Z')]).status).toBe(1)
  })
  it('a later PR failure does not invalidate successful release evidence', () => {
    expect(run([row('push'), row('pull_request', 'failure', '2026-10-05T13:00:00Z')]).status).toBe(0)
  })
  it.each(['failure', 'cancelled', 'skipped'])('rejects latest eligible %s', conclusion => {
    expect(run([row('push'), row('workflow_dispatch', conclusion, '2026-10-05T13:00:00Z')]).status).toBe(1)
  })
  it('rejects a pending eligible run, missing evidence and a failed API query', () => {
    expect(run([row('push', 'none', '2026-10-05T13:00:00Z', 'in_progress')]).status).toBe(1)
    expect(run([]).status).toBe(1)
    expect(run([], true).status).toBe(1)
  })
})
