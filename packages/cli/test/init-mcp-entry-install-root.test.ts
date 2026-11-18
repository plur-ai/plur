// security audit 2026-11-06: plur init takes @plur-ai/mcp only from the CLI's own install root, never a higher ancestor.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { _resolveMcpEntrypoint } from '../src/commands/init.js'

let base: string
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-mcp-root-'))) })
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

function plantMcp(pkg: string): string {
  mkdirSync(join(pkg, 'dist'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@plur-ai/mcp', version: '0.0.0-dummy' }))
  writeFileSync(join(pkg, 'dist', 'index.js'), '// dummy, never executed\n')
  return join(pkg, 'dist', 'index.js')
}

const npm = 'C/Users/u/AppData/Roaming/npm/node_modules'
const pnpm = 'pnpm/global/5/node_modules'
// [layout, CLI entry, where @plur-ai/mcp is planted, expected: the planted entry or null]
const cases: Array<[string, string, string, boolean]> = [
  ['npm: a drive-root ancestor is ignored', `${npm}/@plur-ai/cli/dist/index.js`, 'C/node_modules/@plur-ai/mcp', false],
  ['npm: beside the CLI counts', `${npm}/@plur-ai/cli/dist/index.js`, `${npm}/@plur-ai/mcp`, true],
  ['pnpm: above the store is ignored', `${pnpm}/.pnpm/@plur-ai+cli@0.0.0/node_modules/@plur-ai/cli/dist/index.js`, 'node_modules/@plur-ai/mcp', false],
  ['pnpm: the store-level node_modules counts', `${pnpm}/.pnpm/@plur-ai+cli@0.0.0/node_modules/@plur-ai/cli/dist/index.js`, `${pnpm}/@plur-ai/mcp`, true],
  ['monorepo: packages/cli -> packages/mcp', 'repo/packages/cli/dist/index.js', 'repo/packages/mcp', true],
]

describe('resolveMcpEntrypoint looks only in the CLI install root', () => {
  it.each(cases)('%s', (_name, cli, planted, found) => {
    const entry = join(base, cli)
    mkdirSync(dirname(entry), { recursive: true })
    const mcp = plantMcp(join(base, planted))
    expect(_resolveMcpEntrypoint(entry)).toBe(found ? mcp : null)
  })
})
