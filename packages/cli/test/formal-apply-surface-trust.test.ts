/**
 * Formal-verification apply phase, decision E3 ("opencode rule everywhere"),
 * 2026-09-26.
 *
 * A `.plur.yaml` `scope`/`domain` from a directory the user has not trusted
 * (`plur trust <dir>`) is ignored by every CLI hook adapter, with a notice that
 * names the file and the trust command — the rule @plur-ai/opencode already
 * followed (`resolveTrustedScope`). Before, the hooks adopted a cloned repo's
 * scope as "a local filter that needs no gate" and told the model to learn
 * under it. Trusted directories behave as before.
 * spec/formal/findings/adapters.md §9, PlurSpec/Adapters.lean §9.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { trustDirectory } from '@plur-ai/core'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

// `printsScope`: the hook tells the model "Project scope: …" when it adopts one
// (codex inject prints no scope line, so only the refusal side is visible).
const HOOKS: Array<{ name: string; hook: string; printsScope: boolean; input: (repo: string) => object }> = [
  { name: 'hook-inject', hook: 'hook-inject', printsScope: true, input: () => ({ session_id: 's1', prompt: 'how do we deploy' }) },
  { name: 'codex inject', hook: 'hook-codex-inject', printsScope: false, input: () => ({ session_id: 's1', prompt: 'how do we deploy' }) },
  { name: 'cursor session-start', hook: 'hook-cursor-session-start', printsScope: true, input: () => ({ conversation_id: 'c1' }) },
  { name: 'antigravity', hook: 'hook-agy-pre-invocation', printsScope: true, input: (repo) => ({ conversationId: 'c1', invocationNum: 0, workspacePaths: [repo] }) },
]

describe('CLI hooks ignore an untrusted .plur.yaml scope (E3)', () => {
  let dir: string
  let repo: string
  let tmpIdx = 0

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-e3-'))
    repo = join(dir, 'cloned-repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(dir, '.plur'), { recursive: true })
    writeFileSync(join(dir, '.plur', 'config.yaml'), 'embeddings:\n  enabled: false\nindex: false\n')
    writeFileSync(join(repo, '.plur.yaml'), 'scope: group:acme/eng\ndomain: acme.eng\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function run(hook: string, input: object): string {
    const tmp = join(dir, `tmp-${tmpIdx++}`)
    mkdirSync(tmp, { recursive: true })
    const r = runCli('node', [CLI, hook], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: tmp, PLUR_PATH: join(dir, '.plur') },
      cwd: repo,
    })
    return (r.stdout ?? '') + (r.stderr ?? '')
  }

  for (const h of HOOKS) {
    it(`${h.name}: untrusted → scope not adopted; the folder question asks instead (decision J)`, { timeout: 90_000 }, () => {
      const out = run(h.hook, h.input(repo))
      expect(out).not.toContain('Project scope: group:acme/eng')
      // The folder-map question (#1418) replaces the old notice. Asserting it
      // keeps this replay from passing on empty output.
      expect(out).toContain('requests project settings')
    })

    it(`${h.name}: trusted → scope adopted as before`, { timeout: 90_000 }, () => {
      trustDirectory(repo, join(dir, '.plur'))
      const out = run(h.hook, h.input(repo))
      if (h.printsScope) expect(out).toContain('Project scope: group:acme/eng')
      expect(out).not.toContain('requests project settings')
    })
  }
})
