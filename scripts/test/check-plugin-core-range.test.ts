// The plugin core-range release check (#1831), driven as release.sh drives
// it: a child process with a stub npm and a fixture repository, judged by its
// exit code. 0 pass, 1 a requirement excludes the core, 2 could not check.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = join(import.meta.dirname, '..', 'check-plugin-core-range.mjs')
const RANGE = '>=0.23.0 <1'
const PLUGINS = ['opencode', 'claw', 'dsh'] as const

type NpmAnswer = { stdout?: string; status?: number; stderr?: string }
type Fixture = Partial<Record<(typeof PLUGINS)[number], NpmAnswer>>

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plur-core-range-'))
  dirs.push(dir)
  return dir
}

/** A published `latest` manifest as `npm view --json` prints it. */
function published(version: string, core: { peer?: string; dep?: string }): NpmAnswer {
  return {
    status: 0,
    stdout: JSON.stringify({
      name: 'x',
      version,
      ...(core.dep ? { dependencies: { '@plur-ai/core': core.dep } } : {}),
      ...(core.peer ? { peerDependencies: { '@plur-ai/core': core.peer } } : {}),
    }),
  }
}

const notFound: NpmAnswer = { status: 1, stdout: JSON.stringify({ error: { code: 'E404', summary: 'Not Found' } }) }
const unreachable: NpmAnswer = {
  status: 1,
  stdout: JSON.stringify({ error: { code: 'ECONNREFUSED', summary: 'request failed' } }),
}

function workspaceManifest(peer: string | undefined, dep: string | undefined) {
  return {
    name: 'x',
    version: '0.0.0',
    ...(dep ? { dependencies: { '@plur-ai/core': dep } } : {}),
    ...(peer ? { peerDependencies: { '@plur-ai/core': peer } } : {}),
  }
}

// dsh declares core as a dependency only: pnpm 11's hoisted linker with
// autoInstallPeers: false (DeepSeek Harness profiles) does not link a package
// declared as both peer and dependency.
const DSH_WORKSPACE = workspaceManifest(undefined, `workspace:${RANGE}`)

/** Run the check against a fixture repository and a stub npm answering from `npm`. */
function run(
  args: string[],
  npm: Fixture,
  workspace: Partial<Record<(typeof PLUGINS)[number], object>> = {},
  env: Record<string, string> = {},
) {
  const dir = tempDir()
  const root = join(dir, 'repo')
  for (const plugin of PLUGINS) {
    mkdirSync(join(root, 'packages', plugin), { recursive: true })
    const manifest = workspace[plugin] ?? (plugin === 'dsh' ? DSH_WORKSPACE : workspaceManifest(RANGE, `workspace:${RANGE}`))
    writeFileSync(join(root, 'packages', plugin, 'package.json'), JSON.stringify(manifest))
  }
  const answers = Object.fromEntries(Object.entries(npm).map(([plugin, answer]) => [`@plur-ai/${plugin}@latest`, answer]))
  writeFileSync(join(dir, 'answers.json'), JSON.stringify(answers))
  const stub = join(dir, 'npm-stub.mjs')
  writeFileSync(
    stub,
    [
      "import { readFileSync, appendFileSync } from 'node:fs'",
      'const [cmd, spec, json] = process.argv.slice(2)',
      "appendFileSync(process.env.STUB_NPM_LOG, spec + '\\n')",
      "if (cmd !== 'view' || json !== '--json') { console.error('unexpected npm call'); process.exit(9) }",
      "const answer = JSON.parse(readFileSync(process.env.STUB_NPM_ANSWERS, 'utf8'))[spec]",
      "if (!answer) { console.error('no fixture for ' + spec); process.exit(9) }",
      'if (answer.stdout) process.stdout.write(answer.stdout)',
      'if (answer.stderr) process.stderr.write(answer.stderr)',
      'process.exit(answer.status ?? 0)',
    ].join('\n'),
  )
  const log = join(dir, 'npm.log')
  writeFileSync(log, '')
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PLUR_RELEASE_ROOT: root,
      PLUR_RELEASE_NPM_CLI: stub,
      STUB_NPM_ANSWERS: join(dir, 'answers.json'),
      STUB_NPM_LOG: log,
      ...env,
    },
  })
  const asked = readFileSync(log, 'utf8').split('\n').filter(Boolean)
  return { status: result.status, out: result.stdout + result.stderr, asked }
}

/** Every plugin published with the range, as after the first release that ships it. */
const CURRENT: Fixture = {
  opencode: published('0.21.6', { peer: RANGE, dep: RANGE }),
  claw: published('0.20.1', { peer: RANGE, dep: RANGE }),
  dsh: published('0.1.1', { dep: RANGE }),
}

describe('check-plugin-core-range: published plugins', () => {
  it('passes when every published range includes the core being released', () => {
    const r = run(['--core', '0.24.0'], CURRENT)
    expect(r.status, r.out).toBe(0)
    expect(r.asked).toEqual(['@plur-ai/opencode@latest', '@plur-ai/claw@latest', '@plur-ai/dsh@latest'])
  })

  it('passes an exact pin equal to the core being released', () => {
    const r = run(['--core', '0.24.0'], { ...CURRENT, claw: published('0.20.1', { dep: '0.24.0' }) })
    expect(r.status, r.out).toBe(0)
  })

  it('fails a plugin that pins an older core exactly, and names the flags to add', () => {
    const r = run(['--core', '0.23.0'], {
      opencode: published('0.21.5', { dep: '0.21.5' }),
      claw: published('0.20.0', { dep: '0.20.0' }),
      dsh: published('0.1.0', { dep: '0.17.2' }),
    })
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('@plur-ai/opencode@0.21.5 pins @plur-ai/core 0.21.5 exactly')
    expect(r.out).toContain('@plur-ai/dsh@0.1.0 pins @plur-ai/core 0.17.2 exactly')
    expect(r.out).toContain('--opencode <next version> --claw <next version> --dsh <next version>')
    expect(r.out).toContain('#1831')
  })

  it('fails a range that excludes the core (a caret range at the next minor)', () => {
    const r = run(['--core', '0.24.0'], { ...CURRENT, opencode: published('0.21.6', { peer: '^0.23.0' }) })
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('requires @plur-ai/core "^0.23.0", which excludes 0.24.0')
    expect(r.out).toContain('--opencode <next version>')
    expect(r.out).not.toContain('--claw <next version>')
  })

  it('reads the peer range before the dependency', () => {
    const r = run(['--core', '0.24.0'], { ...CURRENT, claw: published('0.20.1', { peer: RANGE, dep: '0.23.0' }) })
    expect(r.status, r.out).toBe(0)
  })

  it('fails a published plugin with no core requirement', () => {
    const r = run(['--core', '0.24.0'], { ...CURRENT, claw: published('0.20.1', {}) })
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('declares no @plur-ai/core requirement')
  })

  it('a 1.0 core fails the range on purpose', () => {
    const r = run(['--core', '1.0.0', '--releasing', 'opencode,claw,dsh'], {})
    expect(r.status, r.out).toBe(1)
  })
})

describe('check-plugin-core-range: could not check is exit 2, never a pass', () => {
  it('package not found', () => {
    const r = run(['--core', '0.24.0'], { ...CURRENT, dsh: notFound })
    expect(r.status, r.out).toBe(2)
    expect(r.out).toContain('@plur-ai/dsh: not found on the registry')
  })

  it('registry unreachable', () => {
    const r = run(['--core', '0.24.0'], { ...CURRENT, claw: unreachable })
    expect(r.status, r.out).toBe(2)
    expect(r.out).toContain('ECONNREFUSED')
  })

  it('an answer that is not JSON', () => {
    const r = run(['--core', '0.24.0'], { ...CURRENT, opencode: { status: 0, stdout: '<html>proxy error</html>' } })
    expect(r.status, r.out).toBe(2)
    expect(r.out).toContain('did not answer JSON')
  })

  it('JSON that is not a manifest', () => {
    const r = run(['--core', '0.24.0'], { ...CURRENT, opencode: { status: 0, stdout: '[]' } })
    expect(r.status, r.out).toBe(2)
  })

  it('npm-cli.js that does not exist', () => {
    const r = run(['--core', '0.24.0'], CURRENT, {}, { PLUR_RELEASE_NPM_CLI: '/nonexistent/npm-cli.js' })
    expect(r.status, r.out).toBe(2)
  })

  it('semver that cannot be imported', () => {
    const dir = tempDir()
    const copy = join(dir, 'check-plugin-core-range.mjs')
    copyFileSync(SCRIPT, copy)
    const r = spawnSync(process.execPath, [copy, '--core', '0.24.0'], { encoding: 'utf8' })
    expect(r.status, r.stdout + r.stderr).toBe(2)
    expect(r.stderr).toContain('semver is not importable')
  })

  it.each([[[]], [['--core']], [['--core', 'latest']], [['--core', '0.24.0', '--releasing', 'cursor']], [['--core', '0.24.0', '--bogus']]])(
    'bad arguments %j',
    (args) => {
      const r = run(args, CURRENT)
      expect(r.status, r.out).toBe(2)
    },
  )

  it('a definite failure is reported over a could-not-check', () => {
    const r = run(['--core', '0.24.0'], { opencode: published('0.21.5', { dep: '0.21.5' }), claw: unreachable, dsh: notFound })
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('could not check')
  })
})

describe('check-plugin-core-range: workspace manifests', () => {
  it('a plugin being released is judged on its workspace manifest, not on npm', () => {
    const r = run(['--core', '0.24.0', '--releasing', 'opencode,claw'], { dsh: published('0.1.1', { dep: RANGE }) })
    expect(r.status, r.out).toBe(0)
    expect(r.asked).toEqual(['@plur-ai/dsh@latest'])
  })

  it('the first release: old exact pins on npm pass once all three plugins ride along', () => {
    const r = run(['--core', '0.24.0', '--releasing', 'opencode,claw,dsh'], {
      opencode: published('0.21.5', { dep: '0.21.5' }),
    })
    expect(r.status, r.out).toBe(0)
    expect(r.asked).toEqual([])
  })

  it('fails a workspace range tightened so it excludes the core, even for a plugin not being released', () => {
    const tight = workspaceManifest('^0.23.0', 'workspace:^0.23.0')
    const r = run(['--core', '0.24.0'], CURRENT, { claw: tight })
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('workspace @plur-ai/claw peer requires @plur-ai/core "^0.23.0", which excludes 0.24.0')
  })

  it.each([
    ['no peer', workspaceManifest(undefined, 'workspace:*'), 'declares no @plur-ai/core peer dependency'],
    ['an exact peer', workspaceManifest('0.24.0', 'workspace:0.24.0'), 'must be a published range'],
    ['a workspace: peer', workspaceManifest('workspace:*', 'workspace:*'), 'must be a published range'],
    ['the old workspace:* dependency', workspaceManifest(RANGE, 'workspace:*'), `expected "workspace:${RANGE}"`],
    ['no dependency', workspaceManifest(RANGE, undefined), 'is "(none)"'],
    [
      'core also in devDependencies',
      { ...workspaceManifest(RANGE, `workspace:${RANGE}`), devDependencies: { '@plur-ai/core': 'workspace:*' } },
      'must not also be a devDependency',
    ],
  ])('fails a peer-plus-dependency plugin (claw) with %s', (_label, manifest, message) => {
    const r = run(['--core', '0.24.0', '--releasing', 'opencode,claw,dsh'], {}, { claw: manifest })
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(message)
  })
})

describe('check-plugin-core-range: dsh declares core as a dependency only', () => {
  it('accepts the dependency-only shape', () => {
    const r = run(['--core', '0.24.0', '--releasing', 'opencode,claw,dsh'], {})
    expect(r.status, r.out).toBe(0)
  })

  it.each([
    ['a core peer as well', workspaceManifest(RANGE, `workspace:${RANGE}`), 'must not declare a @plur-ai/core peer dependency'],
    ['the old workspace:* dependency', workspaceManifest(undefined, 'workspace:*'), 'must be workspace:<range>, not "workspace:*"'],
    ['an exact workspace pin', workspaceManifest(undefined, 'workspace:0.24.0'), 'must be workspace:<range>'],
    ['no core at all', workspaceManifest(undefined, undefined), 'not "(none)"'],
    ['a range that excludes the core', workspaceManifest(undefined, 'workspace:^0.23.0'), 'dependency requires @plur-ai/core "^0.23.0", which excludes 0.24.0'],
  ])('fails dsh with %s', (_label, manifest, message) => {
    const r = run(['--core', '0.24.0', '--releasing', 'opencode,claw,dsh'], {}, { dsh: manifest })
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(message)
  })

  it('a published dsh with a dependency range that includes the core passes', () => {
    const r = run(['--core', '0.24.0', '--releasing', 'opencode,claw'], { dsh: published('0.1.1', { dep: RANGE }) })
    expect(r.status, r.out).toBe(0)
  })
})

describe('check-plugin-core-range --post', () => {
  it('reads npm for every plugin and skips the workspace manifests', () => {
    const tight = workspaceManifest('^0.23.0', 'workspace:^0.23.0')
    const r = run(['--core', '0.24.0', '--post', '--releasing', 'claw'], CURRENT, { claw: tight })
    expect(r.status, r.out).toBe(0)
    expect(r.asked).toHaveLength(3)
  })

  it('keeps the exit codes, and tells the operator how to realign', () => {
    const behind = run(['--core', '0.24.0', '--post'], { ...CURRENT, dsh: published('0.1.0', { dep: '0.17.2' }) })
    expect(behind.status, behind.out).toBe(1)
    expect(behind.out).toContain('./scripts/release.sh <version> --dsh <next version>')
    const unknown = run(['--core', '0.24.0', '--post'], { ...CURRENT, dsh: unreachable })
    expect(unknown.status, unknown.out).toBe(2)
  })
})
