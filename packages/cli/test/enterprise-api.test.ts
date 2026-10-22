import { describe, expect, it } from 'vitest'
import * as api from '../src/enterprise-api.js'

// The contract with @plur-ai/plur-enterprise, which imports
// `@plur-ai/cli/enterprise-api`. Removing or renaming an export breaks that
// package, so the list is pinned: change it on purpose, together with it.
describe('@plur-ai/cli/enterprise-api', () => {
  it('exports exactly what plur-enterprise builds on', () => {
    expect(Object.keys(api).sort()).toEqual([
      'CLI_VERSION', 'DEVICE_KEY_RE', 'backupSecretFile', 'backupWriter', 'codexConfigTomlPath',
      'codexMcpEnvironment', 'countUploadCandidates', 'deviceName', 'deviceSignIn', 'fetchMe',
      'isHeadless', 'isVsCodeRemote', 'isWslRelease', 'parseJsonc', 'patchCodexEntry', 'personalScopeOf',
      'readCodexEntry', 'redactConsoleWith', 'resolveCodexBinary', 'takeoverMessage', 'unambiguousJsonc', 'urlOpener',
    ])
  })

  it('the package exposes it as a subpath export, and no plur-enterprise command', async () => {
    const { readFileSync } = await import('fs')
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(pkg.exports['./enterprise-api']).toEqual({ types: './dist/enterprise-api.d.ts', import: './dist/enterprise-api.js' })
    expect(Object.keys(pkg.bin)).toEqual(['plur'])
  })
})
