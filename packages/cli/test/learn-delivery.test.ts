import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const TEAM = 'group:example/eng'

/**
 * #1264 — `plur learn` to a shared scope with no matching url store saved the
 * engram on this machine only and printed nothing to say so.
 */
describe('plur learn reports delivery (#1264)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-cli-delivery-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const run = (args: string, json: boolean) => execSync(
    `node ${CLI} ${args} --path ${dir}${json ? ' --json' : ''} 2>&1`,
    { encoding: 'utf-8', timeout: 15000 },
  ).trim()

  it('--json carries delivery "local" and a warning naming the shared scope', () => {
    const out = JSON.parse(run(`learn "team fact with nowhere to go" --scope ${TEAM}`, true))
    expect(out.delivery).toBe('local')
    expect(String(out.delivery_warning)).toContain(TEAM)
  })

  it('--json carries delivery "local" and no warning for a personal scope', () => {
    const out = JSON.parse(run('learn "my own preference" --scope global', true))
    expect(out.delivery).toBe('local')
    expect(out.delivery_warning).toBeUndefined()
  })

  // Text mode cannot run through a spawned CLI (a piped stdout auto-selects
  // JSON), so these run in-process with json: false — the quiet.test.ts pattern.
  const textRun = async (argv: string[], quiet = false): Promise<string> => {
    const out: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { out.push(String(c)); return true }) as never)
    try {
      const { run: learn } = await import('../src/commands/learn.js')
      await learn(argv, { path: dir, json: false, quiet })
    } finally { spy.mockRestore() }
    return out.join('')
  }

  it('text output prints the warning for a shared scope that stayed local, even with --quiet', async () => {
    const out = await textRun(['another team fact with nowhere to go', '--scope', TEAM], true)
    expect(out).toMatch(/Warning:.*group:example\/eng/)
  })

  it('text output prints no delivery warning for a personal scope', async () => {
    const out = await textRun(['another preference of mine', '--scope', 'global'])
    expect(out).toContain('Learned:')
    expect(out).not.toMatch(/is shared, but/)
  })
})
