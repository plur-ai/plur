// The CI version stamp (#1605) on a tree whose plugins declare core as
// `workspace:<range>` (#1831). pnpm matches such a range without prereleases,
// so the stamp must point the plugins back at `workspace:*` or pnpm builds
// them before core (TS7016 in opencode's DTS build on PR #1845).
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = join(import.meta.dirname, '..', 'ci-stamp-version.mjs')
const RANGE = '>=0.23.0 <1'
const semver = createRequire(import.meta.url)('semver')

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'plur-stamp-'))
  dirs.push(root)
  mkdirSync(join(root, 'scripts'))
  copyFileSync(SCRIPT, join(root, 'scripts', 'ci-stamp-version.mjs'))
  const write = (pkg: string, manifest: object) => {
    mkdirSync(join(root, 'packages', pkg, 'src'), { recursive: true })
    writeFileSync(join(root, 'packages', pkg, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  }
  for (const pkg of ['core', 'mcp', 'cli', 'migrate']) write(pkg, { name: `@plur-ai/${pkg}`, version: '0.23.0' })
  write('opencode', {
    name: '@plur-ai/opencode',
    version: '0.21.5',
    dependencies: { '@plur-ai/core': `workspace:${RANGE}` },
    peerDependencies: { '@plur-ai/core': RANGE, '@opencode-ai/plugin': '>=1.18.0' },
  })
  write('claw', {
    name: '@plur-ai/claw',
    version: '0.20.0',
    dependencies: { '@plur-ai/core': `workspace:${RANGE}` },
    peerDependencies: { '@plur-ai/core': RANGE, openclaw: '>=2026.6.5' },
  })
  write('dsh', {
    name: '@plur-ai/dsh',
    version: '0.1.0',
    dependencies: { '@plur-ai/core': `workspace:${RANGE}`, 'js-yaml': '^4.3.1' },
    devDependencies: { '@plur-ai/ui': 'workspace:*' },
  })
  writeFileSync(join(root, 'packages/mcp/src/version.ts'), "export const VERSION = '0.23.0'\n")
  writeFileSync(join(root, 'packages/cli/src/version.ts'), "export const CLI_VERSION = '0.23.0'\n")
  writeFileSync(join(root, 'packages/opencode/src/version.ts'), "export const OPENCODE_PLUGIN_VERSION = '0.21.5'\n")
  return root
}

const read = (root: string, pkg: string) => JSON.parse(readFileSync(join(root, 'packages', pkg, 'package.json'), 'utf8'))

describe('ci-stamp-version.mjs', () => {
  it('the problem: pnpm matches workspace:<range> without prereleases, so the stamped core is outside it', () => {
    // pnpm's resolveWorkspaceRange: maxSatisfying(versions, range, { loose: true }).
    expect(semver.maxSatisfying(['0.23.0-ci.test'], RANGE, { loose: true })).toBeNull()
    expect(semver.maxSatisfying(['0.23.0-ci.test'], '*', { includePrerelease: true })).toBe('0.23.0-ci.test')
  })

  it('stamps the versions and points every plugin core dependency and peer at workspace:*', () => {
    const root = fixture()
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'ci-stamp-version.mjs'), 'ci.test'], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('PLUR_CI_VERSION=0.23.0-ci.test')
    expect(read(root, 'core').version).toBe('0.23.0-ci.test')
    for (const plugin of ['opencode', 'claw', 'dsh']) {
      const pkg = read(root, plugin)
      expect(pkg.dependencies['@plur-ai/core'], plugin).toBe('workspace:*')
      if (plugin !== 'dsh') expect(pkg.peerDependencies['@plur-ai/core'], plugin).toBe('workspace:*')
    }
    // Nothing else in the plugin manifests moves.
    expect(read(root, 'opencode').peerDependencies['@opencode-ai/plugin']).toBe('>=1.18.0')
    expect(read(root, 'claw').peerDependencies.openclaw).toBe('>=2026.6.5')
    expect(read(root, 'dsh').peerDependencies).toBeUndefined()
    expect(read(root, 'dsh').dependencies['js-yaml']).toBe('^4.3.1')
    expect(read(root, 'dsh').devDependencies['@plur-ai/ui']).toBe('workspace:*')
    expect(read(root, 'opencode').version).toBe('0.21.5-ci.test')
    expect(read(root, 'claw').version).toBe('0.20.0')
  })
})
