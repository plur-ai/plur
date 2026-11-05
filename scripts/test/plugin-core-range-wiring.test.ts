// The real repository's side of #1831: the three plugin manifests declare
// @plur-ai/core as a range, and release.sh runs the range check before it
// changes or publishes anything, and again after publishing.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const manifest = (pkg: string) => JSON.parse(read(`packages/${pkg}/package.json`))
const CORE = '@plur-ai/core'
// The same semver the check script uses (a root devDependency); loaded through
// require because the repo carries no type declarations for it.
const semver = createRequire(import.meta.url)('semver')
const coreVersion: string = manifest('core').version

// dsh declares core as a dependency only: pnpm 11's hoisted linker with
// autoInstallPeers: false (DeepSeek Harness profiles) does not link a package
// declared as both peer and dependency.
const DEPENDENCY_ONLY = new Set(['dsh'])

describe.each(['opencode', 'claw', 'dsh'])('@plur-ai/%s declares @plur-ai/core as a range', (plugin) => {
  const pkg = manifest(plugin)
  const peer: string | undefined = pkg.peerDependencies?.[CORE]
  const dep: string | undefined = pkg.dependencies?.[CORE]
  // The published range: what pnpm writes out for workspace:<range>.
  const range = dep?.startsWith('workspace:') ? dep.slice('workspace:'.length) : ''

  it('as a regular dependency on workspace:<range>, which pnpm publishes as the range', () => {
    // OpenClaw before 2026.6.5 installs with npm --omit=peer, and DeepSeek
    // Harness profiles do not auto-install peers, so the dependency is required.
    expect(dep, 'dependencies["@plur-ai/core"]').toMatch(/^workspace:/)
    expect(range).not.toBe('*')
    expect(semver.valid(range), 'an exact version is a pin, not a range').toBeNull()
    expect(semver.validRange(range)).not.toBeNull()
  })

  if (DEPENDENCY_ONLY.has(plugin)) {
    it('and not as a peer dependency', () => {
      expect(peer).toBeUndefined()
    })
  } else {
    it('and as a required peer dependency on the same published range', () => {
      expect(peer).toBe(range)
      expect(pkg.peerDependenciesMeta?.[CORE]?.optional).not.toBe(true)
    })
  }

  it('that includes the workspace core, which is what the plugin is built and tested against', () => {
    expect(semver.satisfies(coreVersion, range)).toBe(true)
    expect(semver.lte(semver.minVersion(range), coreVersion)).toBe(true)
  })

  it('that includes the next minor and patch core, so a core release does not strand it', () => {
    expect(semver.satisfies(semver.inc(coreVersion, 'patch'), range)).toBe(true)
    expect(semver.satisfies(semver.inc(coreVersion, 'minor'), range)).toBe(true)
  })

  it('and nowhere else, so the packed manifest carries no exact core', () => {
    expect(pkg.devDependencies?.[CORE]).toBeUndefined()
    expect(pkg.optionalDependencies?.[CORE]).toBeUndefined()
    expect(pkg.bundleDependencies ?? pkg.bundledDependencies ?? []).not.toContain(CORE)
  })
})

describe('release.sh runs the plugin core-range check', () => {
  const script = read('scripts/release.sh')
  const lines = script.split('\n')
  const at = (pattern: RegExp, from = 0) => lines.findIndex((line, i) => i >= from && pattern.test(line))
  const preCheck = at(/check-plugin-core-range\.mjs" --core "\$VERSION" --releasing/)

  it('before any file is changed, in --dry-run too', () => {
    expect(preCheck).toBeGreaterThan(0)
    expect(preCheck).toBeLessThan(at(/^# --- 1\. Version bump ---/))
    expect(preCheck).toBeLessThan(at(/DRY RUN — stopping before publish/))
    // Not inside the Step 0 block, which --dry-run skips.
    const step0End = at(/^fi$/, at(/^if \[ "\$DRY_RUN" = false \]; then$/))
    expect(preCheck).toBeGreaterThan(step0End)
  })

  it('before the first publish', () => {
    expect(preCheck).toBeGreaterThan(0)
    expect(preCheck).toBeLessThan(at(/publish --access public/))
    expect(preCheck).toBeLessThan(at(/git push origin/))
  })

  it('aborting on exit 1 and on exit 2, never ignoring the result', () => {
    expect(lines[preCheck]).toMatch(/\|\| CORE_RANGE_STATUS=\$\?$/)
    expect(lines[preCheck]).not.toMatch(/\|\| true/)
    const block = lines.slice(preCheck, preCheck + 16).join('\n')
    expect(block).toMatch(/if \[ "\$CORE_RANGE_STATUS" -eq 1 \]; then[\s\S]*?exit 1/)
    expect(block).toMatch(/elif \[ "\$CORE_RANGE_STATUS" -ne 0 \]; then[\s\S]*?exit 1/)
    expect(block).toContain('--opencode <ver> --claw <ver> --dsh <ver>')
  })

  it('passes every plugin whose flag is given as being released', () => {
    for (const plugin of ['opencode', 'claw', 'dsh']) {
      const flag = plugin.toUpperCase()
      expect(script).toContain(`[ -n "$${flag}_VERSION" ] && RELEASING_PLUGINS="$RELEASING_PLUGINS,${plugin}"`)
    }
  })

  it('after publishing in --post mode, with the released plugins, and verify_pins no longer expects an exact core from a plugin', () => {
    const post = at(/check-plugin-core-range\.mjs" --core "\$VERSION" --post --releasing "\$\{RELEASING_PLUGINS#,\}"/)
    expect(post).toBeGreaterThan(at(/^# --- 9b\. Post-release pin verification ---/))
    expect(script).toContain('@plur-ai/core|@plur-ai/claw|@plur-ai/dsh|@plur-ai/opencode) want_core_pin=false')
  })
})

describe('release.sh Step 1 moves a released plugin core floor to the released core', () => {
  const script = read('scripts/release.sh')
  const lines = script.split('\n')
  const at = (pattern: RegExp, from = 0) => lines.findIndex((line, i) => i >= from && pattern.test(line))
  const step1 = at(/^# --- 1\. Version bump ---/)
  const step2 = at(/^# --- 2\. Build ---/)

  it.each(['claw', 'dsh', 'opencode'])('only inside the --%s block, once', (plugin) => {
    const calls = lines.flatMap((line, i) => (line.trim() === `set_plugin_core_floor ${plugin}` ? [i] : []))
    expect(calls).toHaveLength(1)
    const open = at(new RegExp(`^if \\[ -n "\\$${plugin.toUpperCase()}_VERSION" \\]; then$`), step1)
    const close = at(/^(else|fi)$/, open)
    expect(open).toBeGreaterThan(step1)
    expect(calls[0]).toBeGreaterThan(open)
    expect(calls[0]).toBeLessThan(close)
    expect(close).toBeLessThan(step2)
  })

  it('and proves the lockfile still installs frozen when any plugin flag is given', () => {
    const verify = at(/^\s+pnpm install --frozen-lockfile --offline/, step1)
    expect(verify).toBeGreaterThan(at(/^\s+set_plugin_core_floor opencode$/))
    expect(verify).toBeLessThan(step2)
    expect(lines[verify - 1]).toBe('if [ -n "$CLAW_VERSION$DSH_VERSION$OPENCODE_VERSION" ]; then')
  })

  it('rewrites the plugin dependency, its peer and its lockfile specifier, and nothing for other plugins', () => {
    const fn = script.slice(script.indexOf('set_plugin_core_floor() {'), script.indexOf('\n}\n', script.indexOf('set_plugin_core_floor() {')) + 3)
    const root = mkdtempSync(join(tmpdir(), 'plur-floor-'))
    try {
      const range = '>=0.23.0 <1'
      const plugins = {
        opencode: { dependencies: { [CORE]: `workspace:${range}` }, peerDependencies: { [CORE]: range, '@opencode-ai/plugin': '>=1.18.0' } },
        claw: { dependencies: { [CORE]: `workspace:${range}` }, peerDependencies: { [CORE]: range } },
        dsh: { dependencies: { [CORE]: `workspace:${range}`, 'js-yaml': '^4.3.1' } },
      }
      let lock = 'lockfileVersion: \'9.0\'\n\nimporters:\n'
      for (const [plugin, pkg] of Object.entries(plugins)) {
        mkdirSync(join(root, 'packages', plugin), { recursive: true })
        writeFileSync(join(root, 'packages', plugin, 'package.json'), JSON.stringify({ name: `@plur-ai/${plugin}`, ...pkg }, null, 2) + '\n')
        lock += `\n  packages/${plugin}:\n    dependencies:\n      '@plur-ai/core':\n        specifier: workspace:${range}\n        version: link:../core\n`
      }
      lock += '\npackages:\n'
      writeFileSync(join(root, 'pnpm-lock.yaml'), lock)
      writeFileSync(join(root, 'run.sh'), `set -euo pipefail\nVERSION=0.24.0\n${fn}\nset_plugin_core_floor opencode\nset_plugin_core_floor dsh\n`)
      const r = spawnSync('bash', ['run.sh'], { cwd: root, encoding: 'utf8' })
      expect(r.status, r.stderr).toBe(0)
      const pkg = (plugin: string) => JSON.parse(readFileSync(join(root, 'packages', plugin, 'package.json'), 'utf8'))
      expect(pkg('opencode').dependencies[CORE]).toBe('workspace:>=0.24.0 <1')
      expect(pkg('opencode').peerDependencies[CORE]).toBe('>=0.24.0 <1')
      expect(pkg('opencode').peerDependencies['@opencode-ai/plugin']).toBe('>=1.18.0')
      expect(pkg('dsh').dependencies[CORE]).toBe('workspace:>=0.24.0 <1')
      expect(pkg('dsh').peerDependencies).toBeUndefined()
      expect(pkg('claw').dependencies[CORE]).toBe(`workspace:${range}`)
      expect(pkg('claw').peerDependencies[CORE]).toBe(range)
      const after = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
      const specifier = (plugin: string) => after.split(`  packages/${plugin}:\n`)[1].split('\n\n')[0]
      expect(specifier('opencode')).toContain('specifier: workspace:>=0.24.0 <1')
      expect(specifier('dsh')).toContain('specifier: workspace:>=0.24.0 <1')
      expect(specifier('claw')).toContain(`specifier: workspace:${range}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
