import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { compareSemver, extractManifestVersion } from '../src/index.js'

/**
 * Unit tests for the pack-upgrade helpers in `mcp/src/index.ts`. These
 * helpers ship in the `plur init` upgrade path and decide whether bundled
 * packs replace existing installs. A bug here means existing users silently
 * miss new pack content — exactly the scenario 0.9.4 was supposed to fix.
 */

describe('compareSemver', () => {
  it('detects newer minor version', () => {
    expect(compareSemver('1.1.0', '1.0.0')).toBeGreaterThan(0)
    expect(compareSemver('1.0.0', '1.1.0')).toBeLessThan(0)
  })

  it('detects newer major version', () => {
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0)
  })

  it('detects newer patch version', () => {
    expect(compareSemver('1.0.1', '1.0.0')).toBeGreaterThan(0)
  })

  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0)
  })

  it('treats missing patch as 0 ("1.0" === "1.0.0")', () => {
    expect(compareSemver('1.0', '1.0.0')).toBe(0)
    expect(compareSemver('1.0.0', '1.0')).toBe(0)
  })

  it('treats missing minor as 0 ("2" > "1.9")', () => {
    expect(compareSemver('2', '1.9')).toBeGreaterThan(0)
  })

  it('strips prerelease suffix — "1.0.0-rc1" === "1.0.0"', () => {
    // Documented behavior: prerelease compares equal to base release. Not
    // strictly correct semver but adequate for the pack ecosystem (no
    // prerelease packs in the bundled set).
    expect(compareSemver('1.0.0-rc1', '1.0.0')).toBe(0)
  })

  it('strips build metadata — "1.0.0+build.1" === "1.0.0"', () => {
    expect(compareSemver('1.0.0+build.1', '1.0.0')).toBe(0)
  })

  it('handles leading "v" prefix — "v1.0.0" === "1.0.0"', () => {
    expect(compareSemver('v1.0.0', '1.0.0')).toBe(0)
    expect(compareSemver('V1.0.0', '1.0.0')).toBe(0)
  })

  it('non-numeric segments parse as 0 (does not throw)', () => {
    // "abc" parses as 0; "1.0.0" wins. Defense against malformed manifests.
    expect(compareSemver('abc.0.0', '1.0.0')).toBeLessThan(0)
    expect(compareSemver('1.0.0', 'abc.0.0')).toBeGreaterThan(0)
  })

  it('calendar versioning sorts by numeric segments', () => {
    // "2025.04" parses as [2025, 4, 0]. A calendar-versioned pack will
    // compare as far-future against any semver — meaning calendar-versioned
    // user packs will never receive bundled upgrades. Documented behavior.
    expect(compareSemver('2025.04', '1.1.0')).toBeGreaterThan(0)
    expect(compareSemver('1.1.0', '2025.04')).toBeLessThan(0)
  })
})

describe('extractManifestVersion', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-manifest-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true })
  })

  function writeSkill(content: string): string {
    const path = join(dir, 'SKILL.md')
    writeFileSync(path, content)
    return path
  }

  it('extracts quoted version', () => {
    const path = writeSkill(`---\nname: Test\nversion: "1.2.3"\n---\nbody`)
    expect(extractManifestVersion(path)).toBe('1.2.3')
  })

  it('extracts unquoted version', () => {
    const path = writeSkill(`---\nname: Test\nversion: 1.2.3\n---\nbody`)
    expect(extractManifestVersion(path)).toBe('1.2.3')
  })

  it('returns null when no frontmatter', () => {
    const path = writeSkill(`# No frontmatter\n\nversion: 1.2.3 (in body, not metadata)`)
    expect(extractManifestVersion(path)).toBeNull()
  })

  it('returns null when version key missing', () => {
    const path = writeSkill(`---\nname: Test\ndescription: A pack\n---\nbody`)
    expect(extractManifestVersion(path)).toBeNull()
  })

  it('returns null for missing file', () => {
    expect(extractManifestVersion(join(dir, 'does-not-exist.md'))).toBeNull()
  })

  it('rejects nested-key version (avoids false positive)', () => {
    // `version` here belongs to the nested `metadata` block, not the pack
    // root. The regex anchors at start-of-line; the leading whitespace
    // disqualifies it.
    const path = writeSkill(`---\nname: Test\nmetadata:\n  version: 99.99.99\n---\nbody`)
    expect(extractManifestVersion(path)).toBeNull()
  })

  it('extracts when version appears with extra whitespace', () => {
    const path = writeSkill(`---\nname: Test\nversion:  "1.2.3"  \n---\nbody`)
    expect(extractManifestVersion(path)).toBe('1.2.3')
  })

  it('handles malformed frontmatter (no closing ---)', () => {
    const path = writeSkill(`---\nname: Test\nversion: "1.2.3"\nno closing fence`)
    // No closing ---, so the frontmatter regex fails. Should return null,
    // not the version (which would be a false positive).
    expect(extractManifestVersion(path)).toBeNull()
  })
})
