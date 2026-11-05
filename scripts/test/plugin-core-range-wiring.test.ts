// The real repository's side of #1831: the three plugin manifests declare
// @plur-ai/core as a range, and release.sh runs the range check before it
// changes or publishes anything, and again after publishing.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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

  it('after publishing in --post mode, and verify_pins no longer expects an exact core from a plugin', () => {
    const post = at(/check-plugin-core-range\.mjs" --core "\$VERSION" --post/)
    expect(post).toBeGreaterThan(at(/^# --- 9b\. Post-release pin verification ---/))
    expect(script).toContain('@plur-ai/core|@plur-ai/claw|@plur-ai/dsh|@plur-ai/opencode) want_core_pin=false')
  })
})
