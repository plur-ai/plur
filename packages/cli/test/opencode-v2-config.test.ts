import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeOpencodeConfig, readOpencodeConfig, CURRENT_OPENCODE_PLUGIN_VERSION } from '../src/opencode-config.js'
import { parseJsonc } from '../src/lib/jsonc.js'
let home: string, path: string
beforeEach(()=>{home=mkdtempSync(join(tmpdir(),'plur-v2-config-'));path=join(home,'opencode.jsonc');vi.stubEnv('HOME',home);vi.stubEnv('USERPROFILE',home);vi.spyOn(process,'cwd').mockReturnValue(home)})
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();rmSync(home,{recursive:true,force:true})})
it('upgrades only a native object package spec, preserving options, BOM, comments and CRLF',()=>{
 const original='\ufeff{\r\n // retained\r\n "plugins": [{"package":"@plur-ai/opencode@0.1.1","options":{"nested":true}}],\r\n "mcp":{"servers":{"plur":{"type":"remote","url":"https://example.test/mcp","disabled":true}}}\r\n}\r\n'
 writeFileSync(path,original)
 expect(writeOpencodeConfig(path,'0.21.4').ok).toBe(true)
 expect(readFileSync(path,'utf8')).toBe(original.replace('@plur-ai/opencode@0.1.1','@plur-ai/opencode@'+CURRENT_OPENCODE_PLUGIN_VERSION))
 expect(writeOpencodeConfig(path,'0.21.4').changed).toBe(false)
 expect(readOpencodeConfig(path)).toMatchObject({pluginDeclared:true,mcpPlurDeclared:true,mcpPlurDisabled:true})
})
it('reports an old native object pin when the user opts out of upgrading',()=>{
 writeFileSync(path,JSON.stringify({plugins:[{package:'@plur-ai/opencode@0.1.1',options:{x:1}}],mcp:{servers:{plur:{disabled:true}}}}))
 writeOpencodeConfig(path,'0.21.4',{upgradePlugin:false})
 expect(readOpencodeConfig(path)).toMatchObject({pluginDeclared:true,pluginUpgrade:{from:'@plur-ai/opencode@0.1.1',to:'@plur-ai/opencode@'+CURRENT_OPENCODE_PLUGIN_VERSION}})
})
it.each(['-plur','-pl*','-*'])('preserves native removal %s without re-enabling PLUR',remove=>{
 const original=JSON.stringify({plugins:['@plur-ai/opencode',remove],mcp:{servers:{plur:{type:'remote',disabled:true}}}})
 writeFileSync(path,original);writeOpencodeConfig(path,'0.21.4')
 expect(readFileSync(path,'utf8')).toBe(original)
 expect(readOpencodeConfig(path)).toMatchObject({pluginDeclared:false,pluginDisabled:true})
})
it('does not append a duplicate when either accepted plugin array already declares PLUR',()=>{
 writeFileSync(path,JSON.stringify({plugin:['other'],plugins:['@plur-ai/opencode'],mcp:{servers:{plur:{type:'remote'}}}}))
 writeOpencodeConfig(path,'0.21.4')
 const cfg=parseJsonc(readFileSync(path,'utf8')) as any
 expect(cfg.plugin).toEqual(['other']);expect(cfg.plugins).toEqual(['@plur-ai/opencode'])
 expect(cfg.mcp.plur).toBeUndefined()
})
it('adds a missing server in the existing native map with native enablement semantics',()=>{
 writeFileSync(path,JSON.stringify({plugins:[],mcp:{servers:{other:{type:'remote',url:'https://example.test'}}}}))
 expect(writeOpencodeConfig(path,'0.21.4').ok).toBe(true)
 const cfg=parseJsonc(readFileSync(path,'utf8')) as any
 expect(cfg.plugins).toEqual(['@plur-ai/opencode'])
 expect(cfg.plugin).toBeUndefined();expect(cfg.mcp.plur).toBeUndefined()
 expect(cfg.mcp.servers.plur).toMatchObject({type:'local',disabled:false})
 expect(cfg.mcp.servers.other.url).toBe('https://example.test')
})
it.each([{plugins:{}},{mcp:{servers:[]}},{mcp:{servers:'broken'}}])('refuses malformed native containers without modifying them: %j',cfg=>{
 const original=JSON.stringify(cfg);writeFileSync(path,original)
 expect(writeOpencodeConfig(path,'0.21.4').ok).toBe(false)
 expect(readOpencodeConfig(path).ok).toBe(false)
 expect(readFileSync(path,'utf8')).toBe(original)
})
