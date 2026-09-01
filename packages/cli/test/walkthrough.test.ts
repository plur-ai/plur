/**
 * The recorded walkthrough must keep working.
 *
 * `docs/demo/provenance-walkthrough.sh` is what somebody is shown when they ask
 * what this feature does. A demo that no longer matches the tool is worse than
 * no demo: it teaches the wrong thing, and nobody notices until it is played to
 * an audience.
 *
 * So it runs here, the same way anyone runs it, and the claims it makes on
 * screen are asserted rather than trusted.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { statSync, existsSync } from 'node:fs'

const SCRIPT = join(__dirname, '..', '..', '..', 'docs', 'demo', 'provenance-walkthrough.sh')
const CLI = join(__dirname, '..', 'dist', 'index.js')

/** Strip the colour codes the script writes for readability. */
const ESCAPES = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[a-zA-Z]', 'g')

describe('the provenance walkthrough', () => {
  // Snapshot the real store before the script runs, so the guard below can
  // assert the filesystem rather than trusting that a write would show up in
  // stdout. Absent store is fine — nothing to protect.
  const REAL = join(homedir(), '.plur')
  const realStoreMtimeBefore = existsSync(REAL) ? statSync(REAL).mtimeMs : null

  const output = execFileSync('bash', [SCRIPT], {
    encoding: 'utf8',
    timeout: 60_000,
    // DEMO_FAST drops the pauses that exist for the recording. Without it
    // this holds a worker for minutes doing nothing and starves the suite.
    env: { ...process.env, PLUR_CLI: CLI, DEMO_FAST: '1' },
  }).replace(ESCAPES, '')

  it('runs to the end', () => {
    expect(output).toContain('Done.')
  })

  it('shows a memory with nothing recorded about it, and says so', () => {
    expect(output).toContain('"complete": false')
    expect(output).toContain('who asserted it')
  })

  it('shows a fully recorded memory reaching complete', () => {
    expect(output).toContain('"complete": true')
  })

  it('shows a pack shipping provenance without being asked', () => {
    expect(output).toContain('provenance_files')
    expect(output).toContain('pack.jsonld')
  })

  it('shows the recipient being told nothing was verified', () => {
    expect(output).toContain('verified  : False')
    expect(output).toContain('Nothing here has been verified')
  })

  it('shows tampering being caught', () => {
    // A check nobody has seen fail is not a check.
    expect(output).toContain('does not match the integrity value it shipped')
  })

  it('shows the honest pack installing afterwards', () => {
    expect(output).toContain('integrity : ok')
  })

  it('shows a corrected memory naming its replacement', () => {
    expect(output).toMatch(/superseded_by : \['ENG-/)
  })

  it('shows the record is real W3C PROV with licences as policy', () => {
    expect(output).toContain('http://www.w3.org/ns/prov#')
    expect(output).toContain('http://www.w3.org/ns/odrl/2/')
    expect(output).toContain('odrl permissions')
  })

  it('never touches the real store', () => {
    // Every command in the script is pointed at a temporary directory.
    //
    // This used to assert against a hardcoded /Users/<name>/.plur, which is the
    // macOS shape — on Linux CI, where HOME is /home/runner, the pattern could
    // never match and the guard was inert in the environment it actually runs
    // in. Resolve the path instead, and check the filesystem rather than only
    // the output: a silent write would leave stdout clean.
    expect(output).not.toContain(REAL)
    // Only meaningful when there was a store to protect; a machine without one
    // has nothing to assert and must not fail for that reason.
    if (realStoreMtimeBefore !== null) {
      expect(statSync(REAL).mtimeMs).toBe(realStoreMtimeBefore)
    }
  })
}, 90_000)
