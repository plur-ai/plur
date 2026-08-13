/**
 * Reading the `plur` MCP entry a config actually declares (#764).
 *
 * `buildMcpServerEntry` synthesises the *recommended* entry — the shim, else
 * npx. That is right for `plur init` writing a config and wrong for `plur
 * doctor` verifying one: an install that launches the server another way then
 * gets diagnosed on a path it never uses.
 *
 * It fails in both directions, and the second is the dangerous one:
 *
 *   - false fail — a working local build reported "timeout after 20000ms",
 *     because the cold npx fallback measured 25.2s against a 20s budget;
 *   - false pass — a configured server that crashes on startup reports
 *     healthy, because npx fetched a good copy of a package the user is not
 *     running. The crash that motivated this (a stale dist importing a
 *     dependency removed in the SDK v2 migration) is invisible by construction.
 */
import { describe, it, expect } from 'vitest'
import { readPlurMcpEntry, hasPlurMcp } from '../src/mcp-config.js'

describe('readPlurMcpEntry', () => {
  it('returns the entry as written, not a reconstruction', () => {
    // The shape that actually broke: a direct node invocation of a local build,
    // with an env pin. None of this is recoverable from buildMcpServerEntry().
    const config = {
      mcpServers: {
        plur: {
          command: 'node',
          args: ['/Users/x/plur/packages/mcp/dist/index.js'],
          env: { PLUR_TOOL_PROFILE: 'full' },
        },
      },
    }
    expect(readPlurMcpEntry(config)).toEqual({
      command: 'node',
      args: ['/Users/x/plur/packages/mcp/dist/index.js'],
      env: { PLUR_TOOL_PROFILE: 'full' },
    })
  })

  it('carries env through, because it changes the tool surface', () => {
    // Probing without the config's env reports a tool count the user never
    // sees — PLUR_TOOL_PROFILE=full is 40 tools, lean is 12.
    const withEnv = readPlurMcpEntry({
      mcpServers: { plur: { command: 'x', env: { PLUR_TOOL_PROFILE: 'full' } } },
    })
    expect(withEnv?.env).toEqual({ PLUR_TOOL_PROFILE: 'full' })
  })

  it('omits env entirely when there is none to carry', () => {
    const entry = readPlurMcpEntry({ mcpServers: { plur: { command: 'x' } } })
    expect(entry).toEqual({ command: 'x', args: [] })
    expect(entry && 'env' in entry).toBe(false)
  })

  it('defaults args to an empty array rather than undefined', () => {
    // spawn(cmd, undefined) and spawn(cmd, []) differ; callers should not have
    // to guard.
    expect(readPlurMcpEntry({ mcpServers: { plur: { command: 'plur-mcp' } } })?.args).toEqual([])
  })

  it('returns null when there is nothing runnable to probe', () => {
    // A malformed entry must not become a fabricated command. Falling back to
    // the recommended default is honest; inventing one is not.
    expect(readPlurMcpEntry({})).toBeNull()
    expect(readPlurMcpEntry({ mcpServers: {} })).toBeNull()
    expect(readPlurMcpEntry({ mcpServers: { plur: {} } })).toBeNull()
    expect(readPlurMcpEntry({ mcpServers: { plur: { args: ['x'] } } })).toBeNull()
    expect(readPlurMcpEntry({ mcpServers: { plur: { command: '' } } })).toBeNull()
    expect(readPlurMcpEntry({ mcpServers: { plur: { command: 42 } } })).toBeNull()
  })

  it('drops non-string args and env values instead of passing them to spawn', () => {
    const entry = readPlurMcpEntry({
      mcpServers: { plur: { command: 'node', args: ['ok', 7, null], env: { GOOD: 'x', BAD: 3 } } },
    })
    expect(entry?.args).toEqual(['ok'])
    expect(entry?.env).toEqual({ GOOD: 'x' })
  })

  it('agrees with hasPlurMcp on whether an entry exists', () => {
    // hasPlurMcp is what doctor already uses to report `hasPlurMcp: true`. If
    // it says yes and this says null, doctor claims a server is configured and
    // then probes something else — the exact split this fix removes.
    const declared = { mcpServers: { plur: { command: 'node', args: ['x'] } } }
    expect(hasPlurMcp(declared)).toBe(true)
    expect(readPlurMcpEntry(declared)).not.toBeNull()

    const absent = { mcpServers: { other: { command: 'node' } } }
    expect(hasPlurMcp(absent)).toBe(false)
    expect(readPlurMcpEntry(absent)).toBeNull()
  })
})
