/**
 * #1347: the folder map must not change what an existing `.plur.yaml` does.
 *
 * The golden files under `fixtures/plur-yaml/` were captured from `main`
 * BEFORE the folder map landed, by running this suite with
 * `PLUR_UPDATE_GOLDEN=1` (trusted-scope-hint.txt: captured on main's sources
 * with the trust recorded in trust.yaml, as main reads it). The suite replays the same fixtures and compares
 * the hook's stdout byte for byte, after replacing the temp directory with
 * `<DIR>`, dates with `<DATE>` and session ids with `<UUID>` (all change on every run).
 *
 * Regenerate only when a hook's output changes ON PURPOSE, and say so in the
 * PR. A diff here from a folder-map change is the regression this guards.
 *
 * HOME, USERPROFILE, TMPDIR and PLUR_PATH are set inside each spawn, so the
 * real ~/.plur is never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { resolveFolderPolicy } from '@plur-ai/core'

const CLI = builtCliPath(join(__dirname, '..'))
const GOLDEN_DIR = join(__dirname, 'fixtures', 'plur-yaml')
const UPDATE = process.env.PLUR_UPDATE_GOLDEN === '1'

describe('existing .plur.yaml behaviour is unchanged by the folder map (#1347)', () => {
  let dir: string
  let repo: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'plur-yaml-fixture-')))
    mkdirSync(join(dir, 'tmp'), { recursive: true })
    repo = join(dir, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    env = {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      TMPDIR: join(dir, 'tmp'),
      PLUR_PATH: join(dir, '.plur'),
    }
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function cli(args: string[], input?: string): string {
    const r = runCli('node', [CLI, ...args], {
      encoding: 'utf-8', env, cwd: repo, ...(input !== undefined ? { input } : {}),
    })
    return r.stdout ?? ''
  }

  function normalise(out: string): string {
    return out
      .split(dir).join('<DIR>')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<UUID>')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<TS>')
      .replace(/ENG-\d{4}-\d{2}-\d{2}-/g, 'ENG-<DATE>-')
      .replace(/\d{4}-\d{2}-\d{2}/g, '<DATE>')
  }

  function check(name: string, actual: string): void {
    const file = join(GOLDEN_DIR, `${name}.txt`)
    if (UPDATE) {
      mkdirSync(GOLDEN_DIR, { recursive: true })
      writeFileSync(file, actual)
      return
    }
    expect(existsSync(file), `golden ${file} missing`).toBe(true)
    expect(actual).toBe(readFileSync(file, 'utf8'))
  }

  function seedAndInject(): string {
    cli(['learn', 'Fixture deploys go through the blue staging lane before release',
      '--scope', 'project:fixture', '--domain', 'fixture.deploy', '--json'])
    return normalise(cli(['hook-inject'], JSON.stringify({ prompt: 'how do fixture deploys reach release' })))
  }

  // Decision D1 ("ignore-ask"): only a TRUSTED .plur.yaml keeps today's
  // behaviour, so the unchanged-behaviour golden is a trusted fixture. Trust
  // is granted the way main records it (trust.yaml), which this branch imports.
  it('a TRUSTED scope/domain .plur.yaml: hook-inject output matches main', () => {
    writeFileSync(join(repo, '.plur.yaml'), 'scope: project:fixture\ndomain: fixture.deploy\n')
    mkdirSync(join(dir, '.plur'), { recursive: true })
    writeFileSync(join(dir, '.plur', 'trust.yaml'), `version: 1\ntrusted:\n  - ${repo}\n`)
    check('trusted-scope-hint', seedAndInject())
  }, 60_000)

  // D1: an UNTRUSTED .plur.yaml that requests a scope resolves to ask. The
  // hooks switch to the resolver in the hook-integration PR; until then this
  // pins the resolver's answer for the same fixture.
  it('an UNTRUSTED scope/domain .plur.yaml resolves to ask (D1)', () => {
    writeFileSync(join(repo, '.plur.yaml'), 'scope: project:fixture\ndomain: fixture.deploy\n')
    expect(resolveFolderPolicy(repo, { root: join(dir, '.plur'), home: dir })).toEqual({
      mode: 'ask', remoteAllowed: false, source: 'plur-yaml', reason: 'untrusted-plur-yaml',
      requested: { scope: 'project:fixture', domain: 'fixture.deploy' },
    })
  })

  it('an untrusted remote .plur.yaml: same refusal notice as main, no dial', () => {
    // Port 9 (discard) on loopback: nothing listens, and an untrusted remote
    // must not be dialled anyway.
    writeFileSync(join(repo, '.plur.yaml'), [
      'scope: project:fixture',
      'remote_url: http://127.0.0.1:9',
      'remote_token: fixture-token',
      'remote_scopes:',
      '  - project:fixture',
      '',
    ].join('\n'))
    check('untrusted-remote', seedAndInject())
  }, 60_000)

  it('a remote .plur.yaml trusted in a legacy trust.yaml: same output as main (no refusal)', () => {
    writeFileSync(join(repo, '.plur.yaml'), [
      'scope: project:fixture',
      'remote_url: http://127.0.0.1:9',
      'remote_token: fixture-token',
      'remote_scopes:',
      '  - project:fixture',
      '',
    ].join('\n'))
    // Written by hand in the pre-#1347 format, as an older version left it.
    mkdirSync(join(dir, '.plur'), { recursive: true })
    const trustYaml = `version: 1\ntrusted:\n  - ${repo}\n`
    writeFileSync(join(dir, '.plur', 'trust.yaml'), trustYaml)
    check('legacy-trusted-remote', seedAndInject())
    // trust.yaml is never rewritten (a downgrade must still work).
    expect(readFileSync(join(dir, '.plur', 'trust.yaml'), 'utf8')).toBe(trustYaml)
  }, 60_000)
})
