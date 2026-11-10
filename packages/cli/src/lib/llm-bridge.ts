/**
 * The CLI's model bridge: how a command that needs judgement (tension scan,
 * enrichment) gets an `LlmFunction`. Core never calls a model itself; the
 * host supplies one.
 *
 * Two conventions, in this order:
 *
 *  1. A command (`--llm-cmd` or env `PLUR_LLM_CMD`): run through the shell,
 *     the prompt on stdin, the reply read from stdout. This is how a host
 *     model with its own login is used — e.g. `claude -p --model opus` — with
 *     no API key in PLUR's hands. The model name to record comes from
 *     `--model` or env `PLUR_LLM_MODEL`.
 *  2. An OpenAI-compatible HTTP endpoint (the tension scan's existing
 *     convention): explicit `--llm-base-url` + `--llm-api-key`, else
 *     `OPENROUTER_API_KEY`, else `OPENAI_API_KEY`.
 */
import { spawn } from 'child_process'
import type { LlmFunction } from '@plur-ai/core'

/** Create an OpenAI-compatible LLM function from base URL + key + model. */
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

/** The env-key HTTP bridge the tension scan has always used. */
export function getLlmFunction(): LlmFunction | undefined {
  return resolveHttpFromEnv()?.llm
}

function resolveHttpFromEnv(model?: string): { llm: LlmFunction; model: string; via: string } | undefined {
  const openrouterKey = process.env.OPENROUTER_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY
  if (openrouterKey) {
    const m = model ?? 'openai/gpt-4o-mini'
    return { llm: makeHttpLlm('https://openrouter.ai/api/v1', openrouterKey, m), model: m, via: 'OPENROUTER_API_KEY' }
  }
  if (openaiKey) {
    const m = model ?? 'gpt-4o-mini'
    return { llm: makeHttpLlm('https://api.openai.com/v1', openaiKey, m), model: m, via: 'OPENAI_API_KEY' }
  }
  return undefined
}

/** Default per-call timeout for a command bridge: model calls on a batch can be slow. */
export const LLM_CMD_TIMEOUT_MS = 10 * 60_000

/** Run `cmd` through the shell with `prompt` on stdin; resolve stdout. */
export function makeCommandLlm(cmd: string, timeoutMs = LLM_CMD_TIMEOUT_MS): LlmFunction {
  return (prompt: string) => new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`model command timed out after ${Math.round(timeoutMs / 1000)} s`)) }, timeoutMs)
    child.stdout.on('data', d => out.push(d))
    child.stderr.on('data', d => err.push(d))
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'))
      else reject(new Error(`model command exited ${code}: ${Buffer.concat(err).toString('utf8').trim().slice(0, 300)}`))
    })
    child.stdin.on('error', () => { /* the command may exit before reading everything; close reports it */ })
    child.stdin.end(prompt)
  })
}

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
      llm: makeCommandLlm(cmd),
      model: opts.model ?? process.env.PLUR_LLM_MODEL ?? 'unspecified',
      via: opts.llmCmd ? '--llm-cmd' : 'PLUR_LLM_CMD',
    }
  }
  if (opts.baseUrl) {
    const model = opts.model ?? 'gpt-4o-mini'
    return { llm: makeHttpLlm(opts.baseUrl, opts.apiKey ?? '', model), model, via: '--llm-base-url' }
  }
  return resolveHttpFromEnv(opts.model)
}
