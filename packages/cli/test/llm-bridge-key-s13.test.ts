/**
 * S13: an API key on the command line lands in shell history and the process
 * list. The bridge also takes it from a named environment variable
 * (`--llm-api-key-env NAME`), warns when it is passed on argv, and refuses a
 * plain-http base URL unless it is a loopback address (the key would travel
 * in clear text).
 */
import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { resolveLlm, checkLlmBaseUrl } from '../src/lib/llm-bridge.js'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

describe('llm bridge key handling (S13)', () => {
  it('takes the key from a named environment variable', () => {
    const warnings: string[] = []
    const r = resolveLlm({ baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'MY_LLM_KEY' }, { MY_LLM_KEY: 'sk-from-env' }, { warn: w => warnings.push(w) })
    expect(r?.via).toBe('--llm-base-url')
    expect(warnings).toEqual([])
  })

  it('an unset or empty named variable is an error, naming the variable and never a value', () => {
    expect(() => resolveLlm({ baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'MISSING_KEY' }, {})).toThrow(/MISSING_KEY/)
    expect(() => resolveLlm({ baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'EMPTY' }, { EMPTY: '' })).toThrow(/EMPTY/)
  })

  it('both --llm-api-key and --llm-api-key-env is an error', () => {
    expect(() => resolveLlm({ baseUrl: 'https://api.example.com/v1', apiKey: 'k', apiKeyEnv: 'K' }, { K: 'v' })).toThrow(/both/i)
  })

  it('warns when the key is passed on argv, without echoing it', () => {
    const warnings: string[] = []
    resolveLlm({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret-123' }, {}, { warn: w => warnings.push(w) })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/--llm-api-key-env/)
    expect(warnings[0]).not.toContain('sk-secret-123')
  })

  it.each([
    ['https://api.example.com/v1', true],
    ['http://localhost:11434/v1', true],
    ['http://127.0.0.1:8080', true],
    ['http://127.8.9.10:8080', true],
    ['http://[::1]:8080/v1', true],
    ['http://api.example.com/v1', false],
    ['http://10.0.0.5/v1', false],
    ['http://localhost.evil.example/v1', false],
    ['ftp://api.example.com', false],
    ['not a url', false],
  ])('base URL %s allowed=%s', (url, ok) => {
    expect(checkLlmBaseUrl(url) === null).toBe(ok)
    if (!ok) expect(() => resolveLlm({ baseUrl: url, apiKey: 'k' }, {}, { warn: () => {} })).toThrow()
  })

  it('the CLI refuses a plain-http remote base URL before sending anything', () => {
    const home = mkdtempSync(join(tmpdir(), 'plur-s13-'))
    try {
      const r = spawnSync(process.execPath, [builtCliPath(join(__dirname, '..')), 'enrich', '--plan', '--llm-base-url', 'http://api.example.com/v1', '--llm-api-key-env', 'S13_KEY'], {
        cwd: home, encoding: 'utf8', timeout: 30_000,
        env: { ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1', S13_KEY: 'sk-x', PLUR_LLM_CMD: '' },
      })
      expect(r.status).not.toBe(0)
      expect(r.stderr + r.stdout).toMatch(/https/)
      expect(r.stderr + r.stdout).not.toContain('sk-x')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 40_000)
})
