import { spawn } from 'child_process'
import type { LlmFunction } from '@plur-ai/core'

/**
 * The CLI's model bridge: how a command that needs judgement (`plur tensions
 * --scan`, `plur consolidate --plan`) gets an `LlmFunction`. Core never calls
 * a model itself; it takes this function.
 *
 * Two kinds:
 *  - an OpenAI-compatible HTTP endpoint (`--llm-base-url` + `--llm-api-key`
 *    + `--model`, or OPENROUTER_API_KEY / OPENAI_API_KEY in the environment);
 *  - a host model command (`--llm-cmd "<shell command>"`, or PLUR_LLM_CMD):
 *    the prompt is written to the command's stdin and its stdout is the
 *    answer, e.g. `--llm-cmd "claude -p --model opus"`. This is how a host
 *    agent lends PLUR its own model without PLUR holding an API key.
 */

/** An OpenAI-compatible chat-completions endpoint. */
export function makeHttpLlm(baseUrl: string, apiKey: string, model = 'gpt-4o-mini'): LlmFunction {
  return async (prompt: string): Promise<string> => {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      }),
    })
    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status} ${response.statusText}`)
    }
    const data = (await response.json()) as any
    return data.choices?.[0]?.message?.content ?? ''
  }
}

/** The endpoint named by OPENROUTER_API_KEY or OPENAI_API_KEY, if either is set. */
export function getEnvHttpLlm(env: NodeJS.ProcessEnv = process.env): LlmFunction | undefined {
  const openrouterKey = env.OPENROUTER_API_KEY
  const openaiKey = env.OPENAI_API_KEY
  if (openrouterKey) return makeHttpLlm('https://openrouter.ai/api/v1', openrouterKey, 'openai/gpt-4o-mini')
  if (openaiKey) return makeHttpLlm('https://api.openai.com/v1', openaiKey, 'gpt-4o-mini')
  return undefined
}

/**
 * A host model command: run `command` through the shell, write the prompt to
 * its stdin, return its stdout. A non-zero exit, a signal or the timeout is an
 * error (with the command's stderr, trimmed), never an empty answer.
 */
export function makeCommandLlm(command: string, opts: { timeoutMs?: number } = {}): LlmFunction {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000
  return (prompt: string) => new Promise<string>((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`model command timed out after ${timeoutMs} ms`)) }, timeoutMs)
    child.stdout.setEncoding('utf8').on('data', d => { out += d })
    child.stderr.setEncoding('utf8').on('data', d => { err += d })
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`model command failed (${signal ?? `exit ${code}`})${err.trim() ? `: ${err.trim().slice(0, 500)}` : ''}`))
    })
    child.stdin.on('error', () => { /* the command may exit without reading */ })
    child.stdin.end(prompt)
  })
}

export interface LlmFlags {
  llmCmd?: string
  llmBaseUrl?: string
  llmApiKey?: string
  model?: string
}

/**
 * The model for a command, and a short description of where it came from.
 * Order: `--llm-cmd`, `--llm-base-url`, PLUR_LLM_CMD, then the API-key
 * environment variables. Undefined when none is configured.
 */
export function resolveCliLlm(flags: LlmFlags, env: NodeJS.ProcessEnv = process.env): { llm: LlmFunction; source: string } | undefined {
  if (flags.llmCmd) return { llm: makeCommandLlm(flags.llmCmd), source: '--llm-cmd' }
  if (flags.llmBaseUrl) return { llm: makeHttpLlm(flags.llmBaseUrl, flags.llmApiKey ?? '', flags.model), source: '--llm-base-url' }
  if (env.PLUR_LLM_CMD) return { llm: makeCommandLlm(env.PLUR_LLM_CMD), source: 'PLUR_LLM_CMD' }
  const http = getEnvHttpLlm(env)
  if (http) return { llm: http, source: env.OPENROUTER_API_KEY ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY' }
  return undefined
}

// ── ws/d (enrichment) API, kept alongside until the bridges are unified ──

/** The env-key HTTP bridge the tension scan has always used. */
export function getLlmFunction(): LlmFunction | undefined {
  return getEnvHttpLlm()
}

/** Default per-call timeout for a command bridge: model calls on a batch can be slow. */
export const LLM_CMD_TIMEOUT_MS = 10 * 60_000

export interface ResolvedLlm {
  llm: LlmFunction
  /** Model name to record on what it produced. */
  model: string
  /** Which bridge was chosen, for the user (never a secret). */
  via: string
}

/**
 * Pick the model bridge: `--llm-cmd` / `PLUR_LLM_CMD` first, then explicit
 * HTTP flags, then the env-key HTTP bridge. Undefined when none is set.
 */
export function resolveLlm(opts: { llmCmd?: string; model?: string; baseUrl?: string; apiKey?: string } = {}): ResolvedLlm | undefined {
  const cmd = opts.llmCmd ?? process.env.PLUR_LLM_CMD
  if (cmd && cmd.trim()) {
    return {
      llm: makeCommandLlm(cmd, { timeoutMs: LLM_CMD_TIMEOUT_MS }),
      model: opts.model ?? process.env.PLUR_LLM_MODEL ?? 'unspecified',
      via: opts.llmCmd ? '--llm-cmd' : 'PLUR_LLM_CMD',
    }
  }
  if (opts.baseUrl) {
    const model = opts.model ?? 'gpt-4o-mini'
    return { llm: makeHttpLlm(opts.baseUrl, opts.apiKey ?? '', model), model, via: '--llm-base-url' }
  }
  const m = opts.model
  if (process.env.OPENROUTER_API_KEY) {
    const model = m ?? 'openai/gpt-4o-mini'
    return { llm: makeHttpLlm('https://openrouter.ai/api/v1', process.env.OPENROUTER_API_KEY, model), model, via: 'OPENROUTER_API_KEY' }
  }
  if (process.env.OPENAI_API_KEY) {
    const model = m ?? 'gpt-4o-mini'
    return { llm: makeHttpLlm('https://api.openai.com/v1', process.env.OPENAI_API_KEY, model), model, via: 'OPENAI_API_KEY' }
  }
  return undefined
}
