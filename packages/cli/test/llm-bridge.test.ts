/**
 * The one CLI model bridge (packages/cli/src/lib/llm-bridge.ts).
 *
 * Precedence: --llm-cmd / PLUR_LLM_CMD, then an explicit --llm-base-url.
 * Owner rule: the newer commands (consolidate, enrich, pins audit) never fall
 * back to OPENROUTER_API_KEY / OPENAI_API_KEY from the environment; only
 * `plur tensions` keeps that, for its existing users.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { resolveLlm, makeCommandLlm, llmTimeoutMs, missingLlmMessage, DEFAULT_LLM_TIMEOUT_MS } from '../src/lib/llm-bridge.js'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))
const ENV_KEY_ONLY = { PLUR_LLM_CMD: '', OPENROUTER_API_KEY: 'sk-or-test-not-a-key', OPENAI_API_KEY: 'sk-test-not-a-key' }

describe('resolveLlm', () => {
  it('prefers --llm-cmd, then PLUR_LLM_CMD, then an explicit base URL', () => {
    const env = { PLUR_LLM_CMD: 'echo env' }
    expect(resolveLlm({ llmCmd: 'echo flag', baseUrl: 'http://x' }, env)).toMatchObject({ via: '--llm-cmd', command: 'echo flag' })
    expect(resolveLlm({ baseUrl: 'http://x' }, env)).toMatchObject({ via: 'PLUR_LLM_CMD', command: 'echo env' })
    expect(resolveLlm({ baseUrl: 'http://x', model: 'm1' }, {})).toMatchObject({ via: '--llm-base-url', model: 'm1' })
  })

  it('never uses an environment API key unless the caller opts in (tensions only)', () => {
    expect(resolveLlm({}, ENV_KEY_ONLY)).toBeUndefined()
    expect(resolveLlm({ allowEnvKeys: true }, ENV_KEY_ONLY)).toMatchObject({ via: 'OPENROUTER_API_KEY' })
    expect(resolveLlm({ allowEnvKeys: true }, { OPENAI_API_KEY: 'k' })).toMatchObject({ via: 'OPENAI_API_KEY' })
  })

  it('records PLUR_LLM_MODEL or --model for a command bridge', () => {
    expect(resolveLlm({}, { PLUR_LLM_CMD: 'cat', PLUR_LLM_MODEL: 'opus' })!.model).toBe('opus')
    expect(resolveLlm({ model: 'm' }, { PLUR_LLM_CMD: 'cat' })!.model).toBe('m')
    expect(resolveLlm({}, { PLUR_LLM_CMD: 'cat' })!.model).toBe('unspecified')
  })

  it('PLUR_LLM_TIMEOUT_MS sets the per-call limit, default ten minutes', () => {
    expect(llmTimeoutMs({})).toBe(DEFAULT_LLM_TIMEOUT_MS)
    expect(DEFAULT_LLM_TIMEOUT_MS).toBe(600_000)
    expect(llmTimeoutMs({ PLUR_LLM_TIMEOUT_MS: '1500' })).toBe(1500)
    expect(llmTimeoutMs({ PLUR_LLM_TIMEOUT_MS: 'nope' })).toBe(DEFAULT_LLM_TIMEOUT_MS)
  })

  it('the refusal names every option, and says an env key is not used on its own', () => {
    const m = missingLlmMessage('plur enrich --plan')
    for (const s of ['--llm-cmd', 'PLUR_LLM_CMD', '--llm-base-url', '--llm-api-key', 'not used on its own']) expect(m).toContain(s)
  })
})

describe('makeCommandLlm', () => {
  it('writes the prompt to stdin and returns stdout', async () => {
    expect(await makeCommandLlm('cat')('hello model')).toBe('hello model')
  })
  it('a non-zero exit, an empty answer and the timeout are errors', async () => {
    await expect(makeCommandLlm('echo boom >&2; exit 3')('x')).rejects.toThrow(/exit 3.*boom/)
    await expect(makeCommandLlm('true')('x')).rejects.toThrow(/printed nothing/)
    await expect(makeCommandLlm('sleep 5', { timeoutMs: 200 })('x')).rejects.toThrow(/did not answer/)
  })
})

describe('consolidate, enrich and pins audit refuse with only an environment API key', { timeout: 60_000 }, () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-llm-bridge-'))
    mkdirSync(join(home, '.plur'))
    writeFileSync(join(home, '.plur', 'config.yaml'), 'embeddings:\n  enabled: false\nindex: false\n')
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: home, encoding: 'utf8', timeout: 30_000,
    env: { ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1', ...ENV_KEY_ONLY },
  })

  for (const [name, args] of [
    ['plur consolidate --plan', ['consolidate', '--plan', '--out', 'plan.json']],
    ['plur enrich --plan', ['enrich', '--plan']],
    ['plur pins audit', ['pins', 'audit', '--out', 'audit.json']],
  ] as const) {
    it(name, () => {
      const r = run([...args])
      expect(r.status, r.stdout + r.stderr).toBe(1)
      const text = r.stdout + r.stderr
      expect(text).toContain('needs a model')
      expect(text).toContain('--llm-cmd')
      expect(text).toContain('--llm-base-url')
      expect(text).toContain('not used on its own')
    })
  }
})
