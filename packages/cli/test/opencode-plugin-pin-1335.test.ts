/**
 * #1335 — `plur init` must recognise a user's pinned, tagged or tuple
 * `@plur-ai/opencode` plugin entry and leave it as it is. opencode
 * deduplicates plugins by package name and keeps the LAST occurrence, so an
 * appended bare entry would override the pin and drop the tuple's options.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { writeOpencodeConfig, readOpencodeConfig, isPlurOpencodePluginEntry } from '../src/opencode-config.js'

describe('opencode plugin entry compared by package name (#1335)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-1335-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it.each([
    ['a version pin', ['@plur-ai/opencode@0.1.1']],
    ['a tag', ['@plur-ai/opencode@latest']],
    ['the tuple form with options', [['@plur-ai/opencode', { injectLimit: 5 }]]],
    ['a pinned tuple', [['@plur-ai/opencode@0.1.1', { injectLimit: 5 }]]],
    ['the bare name among other plugins', ['other-plugin', '@plur-ai/opencode']],
  ])('with explicit preservation leaves %s exactly as it is, and doctor sees it as declared', (_label, plugin) => {
    const cfgPath = join(dir, 'opencode.json')
    writeFileSync(cfgPath, JSON.stringify({ plugin, mcp: { plur: { type: 'local', command: ['npx', '-y', '@plur-ai/mcp@0.21.0'], enabled: true } } }))
    writeOpencodeConfig(cfgPath, '0.21.0', { upgradePlugin: false })
    expect(JSON.parse(readFileSync(cfgPath, 'utf-8')).plugin).toEqual(plugin)
    expect(readOpencodeConfig(cfgPath).pluginDeclared).toBe(true)
  })

  it('still adds the plugin when only another package is present', () => {
    const cfgPath = join(dir, 'opencode.json')
    writeFileSync(cfgPath, JSON.stringify({ plugin: ['@plur-ai/opencode-extra', ['other', {}]] }))
    writeOpencodeConfig(cfgPath, '0.21.0')
    expect(JSON.parse(readFileSync(cfgPath, 'utf-8')).plugin)
      .toEqual(['@plur-ai/opencode-extra', ['other', {}], '@plur-ai/opencode'])
  })

  it.each([
    ['@plur-ai/opencode', true], ['@plur-ai/opencode@1.2.3', true], [['@plur-ai/opencode', {}], true],
    ['@plur-ai/opencode-extra', false], ['@plur-ai/opencode-extra@1.0.0', false], ['plur-ai/opencode', false],
    [[], false], [{ name: '@plur-ai/opencode' }, false], [null, false],
  ])('isPlurOpencodePluginEntry(%j) is %s', (entry, expected) => {
    expect(isPlurOpencodePluginEntry(entry)).toBe(expected)
  })
})
