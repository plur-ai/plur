import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeOpencodeConfig, opencodeMcpCommand, readOpencodeConfig, CURRENT_OPENCODE_PLUGIN_VERSION } from '../src/opencode-config.js'
import { parseJsonc } from '../src/lib/jsonc.js'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plur-upgrade-1602-'))
  vi.spyOn(process, 'cwd').mockReturnValue(home)
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

describe('OpenCode upgrade preserves the user document', () => {
  for (const tuple of [false, true]) {
    it(`changes only an old plugin string in commented JSONC (tuple=${tuple})`, () => {
      const p = join(home, 'opencode.jsonc')
      const plugin = tuple ? '["@plur-ai/opencode@0.1.1", { "limit" : 5 }]' : '"@plur-ai/opencode@0.1.1"'
      const original = '\ufeff{\r\n\t// @plur-ai/opencode@0.1.1 in this comment stays\r\n\t"plugin" : [ "other", '+plugin+', ],\r\n\t"mcp": { "plur": { "type":"remote", "url":"https://example.test/mcp" } },\r\n\t"model": "custom", // preserve spacing, CRLF and trailing commas\r\n}\r\n'
      writeFileSync(p, original)
      const result = writeOpencodeConfig(p, '0.21.2')
      expect(result.ok).toBe(true)
      expect(readFileSync(p, 'utf8')).toBe(original.replace('"@plur-ai/opencode@0.1.1"', JSON.stringify('@plur-ai/opencode@'+CURRENT_OPENCODE_PLUGIN_VERSION)))
      expect(writeOpencodeConfig(p, '0.21.2').changed).toBe(false)
    })
  }
  it.each(['@plur-ai/opencode', '@plur-ai/opencode@latest', '@plur-ai/opencode@'+CURRENT_OPENCODE_PLUGIN_VERSION, '@plur-ai/opencode@9.0.0'])('keeps %s byte-for-byte', spec => {
    const p=join(home,'opencode.jsonc')
    const original = '{ // user choice\n "plugin": [ '+JSON.stringify(spec)+' ], "mcp": {"plur":{"type":"remote"}}\n}\n'
    writeFileSync(p,original)
    expect(writeOpencodeConfig(p,'0.21.2').ok).toBe(true)
    expect(readFileSync(p,'utf8')).toBe(original)
  })
  it('uses the installed MCP entry on Unix and refreshes only an owned old command', () => {
    const entry=join(home,'node_modules/@plur-ai/mcp/dist/index.js')
    mkdirSync(join(home,'node_modules/@plur-ai/mcp/dist'),{recursive:true}); writeFileSync(entry,'')
    mkdirSync(join(home,'.plur/bin'),{recursive:true})
    writeFileSync(join(home,'.plur/bin/plur-mcp.meta.json'),JSON.stringify({entrypoint:entry}))
    expect(opencodeMcpCommand('0.21.2')).toEqual([process.execPath,entry])
    const command='["npx", "-y", "@plur-ai/mcp@0.19.4"]'
    const original='{\n "plugin": ["@plur-ai/opencode"],\n "mcp": {"plur": {"type":"local", "command": '+command+', "environment":{"PLUR_PATH":"/chosen/store"}, "enabled":false}},\n "theme": "dark"\n}\n'
    const p=join(home,'opencode.json');writeFileSync(p,original)
    expect(writeOpencodeConfig(p,'0.21.2').mcpPlurUpgraded).toBe(true)
    expect(readFileSync(p,'utf8')).toBe(original.replace(command,JSON.stringify([process.execPath,entry])))
  })
  it('reports an opted-out old plugin pin with its suggested upgrade', () => {
    const p=join(home,'opencode.json')
    const original='{"plugin":["@plur-ai/opencode@0.1.1"],"mcp":{"plur":{"type":"remote"}}}'
    writeFileSync(p,original)
    writeOpencodeConfig(p,'0.21.2',{upgradePlugin:false})
    expect(readFileSync(p,'utf8')).toBe(original)
    expect(readOpencodeConfig(p).pluginUpgrade).toEqual({from:'@plur-ai/opencode@0.1.1',to:'@plur-ai/opencode@'+CURRENT_OPENCODE_PLUGIN_VERSION})
  })
  it('adds missing PLUR fields without replacing existing comments or other plugins', () => {
    const p=join(home,'opencode.jsonc')
    writeFileSync(p,'{\n // user comment\n "plugin": ["other"],\n "model" : "custom"\n}\n')
    expect(writeOpencodeConfig(p,'0.21.2').ok).toBe(true)
    const result=readFileSync(p,'utf8')
    expect(result).toContain('// user comment')
    expect(result).toContain('"model" : "custom"')
    const cfg=parseJsonc(result) as any
    expect(cfg.plugin).toContain('other')
    expect(cfg.mcp.plur.type).toBe('local')
  })
  it.each(['{"plugin":["@plur-ai/opencode@0.1.1"],"plugin":[]}', '{"plugin":[,]}'])('refuses ambiguous or invalid JSONC without writing: %s', original => {
    const p=join(home,'opencode.jsonc'); writeFileSync(p,original)
    expect(writeOpencodeConfig(p,'0.21.2').ok).toBe(false)
    expect(readFileSync(p,'utf8')).toBe(original)
  })
})
