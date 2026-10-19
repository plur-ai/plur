import { expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { namespaceEngramId } from '@plur-ai/core'
import { runHello } from '../src/enterprise/hello.js'

it.each(['own', 'bare', 'foreign'].flatMap(kind => ['ENG-2026-10-19-001', 'ENG-STUB-1'].map(previous => ({ kind, previous }))))('a rerun preserves server identity for $kind $previous', async ({ kind, previous }) => {
  const home = mkdtempSync(join(tmpdir(), 'hello-server-id-')), log = join(home, 'calls.jsonl')
  try {
    const scope = 'user:example:fixture'
    const input = kind === 'bare' ? previous : namespaceEngramId(previous, kind === 'own' ? scope : 'user:other:fixture')
    const result = await runHello({
      launches: [{ tool: 'codex', launch: { command: process.execPath,
        args: [join(__dirname, 'helpers/fake-mcp-server.mjs')], env: { ...process.env, FAKE_LOG: log } } }],
      personalScope: scope, serverUrl: 'https://plur.example.com', statement: 'PLUR connected: fixture',
      previousId: input,
    })
    expect(result.saved.ok).toBe(true)
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(calls.find(call => call.tool === 'plur_learn')?.args.supersedes).toEqual([kind === 'foreign' ? input : previous])
  } finally { rmSync(home, { recursive: true, force: true }) }
})
