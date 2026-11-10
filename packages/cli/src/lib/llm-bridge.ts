/**
 * The CLI's ONE model bridge: how a command that needs judgement gets an
 * `LlmFunction`. Core never calls a model itself (no external calls in core);
 * it takes this function. Used by `plur consolidate`, `plur enrich`,
 * `plur pins audit` and `plur tensions --scan`.
 *
 * Precedence:
 *  1. A host model command — `--llm-cmd "<shell command>"`, else the
 *     `PLUR_LLM_CMD` environment variable. The prompt is written to its stdin
 *     and its stdout is the reply (e.g. `claude -p --model opus`), so the host
 *     lends PLUR its own model and login without PLUR holding an API key.
 *     Per-call limit: `PLUR_LLM_TIMEOUT_MS`, default 10 minutes.
 *  2. An explicit OpenAI-compatible endpoint — `--llm-base-url` +
 *     `--llm-api-key` (+ `--model`).
 *  3. ONLY for callers that opt in with `allowEnvKeys` (`plur tensions`, whose
 *     existing users rely on it): `OPENROUTER_API_KEY`, else `OPENAI_API_KEY`.
 *     The newer commands never pick up an API key from the environment on
 *     their own; with no explicit bridge they refuse ({@link missingLlmMessage}).
 */
import { spawn } from 'child_process'
import type { LlmFunction } from '@plur-ai/core'

/** Environment variable naming the model command. */
export const LLM_CMD_ENV = 'PLUR_LLM_CMD'
/** Environment variable naming the model recorded on what a command bridge produced. */
export const LLM_MODEL_ENV = 'PLUR_LLM_MODEL'
/** Environment variable overriding the per-call limit of a command bridge. */
export const LLM_TIMEOUT_ENV = 'PLUR_LLM_TIMEOUT_MS'
/** Default per-call limit for a command bridge: model calls on a batch can be slow. */
export const DEFAULT_LLM_TIMEOUT_MS = 10 * 60_000
/** Recorded model name when a command bridge is used without --model / PLUR_LLM_MODEL. */
export const UNSPECIFIED_MODEL = 'unspecified'

/** The per-call limit for a command bridge: PLUR_LLM_TIMEOUT_MS when it is a positive integer, else 10 minutes. */
export function llmTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env[LLM_TIMEOUT_ENV] ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LLM_TIMEOUT_MS
}

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

/**
 * A host model command: run `command` through the shell once per prompt,
 * write the prompt to its stdin, return its stdout. A non-zero exit, a
 * signal, the timeout or an empty answer is an error (with the command's
 * stderr, trimmed), never an empty reply.
 */
export function makeCommandLlm(command: string, opts: { timeoutMs?: number } = {}): LlmFunction {
  const timeoutMs = opts.timeoutMs ?? llmTimeoutMs()
  return (prompt: string) => new Promise<string>((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`The model command did not answer within ${Math.round(timeoutMs / 1000)}s (${LLM_CMD_ENV} / --llm-cmd; limit: ${LLM_TIMEOUT_ENV}).`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8').on('data', d => { out += d })
    child.stderr.setEncoding('utf8').on('data', d => { err += d })
    child.once('error', e => { clearTimeout(timer); reject(new Error(`The model command could not start: ${e.message}`)) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`The model command failed (${signal ?? `exit ${code}`}): ${err.trim().slice(0, 500) || 'no error output'}`))
      if (!out.trim()) return reject(new Error('The model command printed nothing.'))
      resolve(out)
    })
    child.stdin.on('error', () => { /* the command may exit without reading; close reports it */ })
    child.stdin.end(prompt)
  })
}

export interface LlmBridgeOptions {
  /** `--llm-cmd`. */
  llmCmd?: string
  /** `--llm-base-url`. */
  baseUrl?: string
  /** `--llm-api-key`. */
  apiKey?: string
  /** `--model`: the endpoint's model, or the name recorded for a command bridge. */
  model?: string
  /**
   * Fall back to OPENROUTER_API_KEY / OPENAI_API_KEY. Only `plur tensions`
   * sets this (existing behaviour); the newer commands must not.
   */
  allowEnvKeys?: boolean
}

export interface ResolvedLlm {
  llm: LlmFunction
  /** Model name to record on what it produced. */
  model: string
  /** Which bridge was chosen, for the user (never a secret). */
  via: '--llm-cmd' | 'PLUR_LLM_CMD' | '--llm-base-url' | 'OPENROUTER_API_KEY' | 'OPENAI_API_KEY'
  /** The shell command, for a command bridge. */
  command?: string
}

/** Pick the model bridge by the precedence above. Undefined when none applies. */
export function resolveLlm(opts: LlmBridgeOptions = {}, env: NodeJS.ProcessEnv = process.env): ResolvedLlm | undefined {
  const flagCmd = opts.llmCmd?.trim()
  const envCmd = env[LLM_CMD_ENV]?.trim()
  const command = flagCmd || envCmd
  if (command) {
    return {
      llm: makeCommandLlm(command, { timeoutMs: llmTimeoutMs(env) }),
      model: opts.model ?? (env[LLM_MODEL_ENV]?.trim() || UNSPECIFIED_MODEL),
      via: flagCmd ? '--llm-cmd' : 'PLUR_LLM_CMD',
      command,
    }
  }
  if (opts.baseUrl) {
    const model = opts.model ?? 'gpt-4o-mini'
    return { llm: makeHttpLlm(opts.baseUrl, opts.apiKey ?? '', model), model, via: '--llm-base-url' }
  }
  if (opts.allowEnvKeys) {
    // The tension scan's long-standing env-key bridge, model defaults as before.
    if (env.OPENROUTER_API_KEY) {
      const model = 'openai/gpt-4o-mini'
      return { llm: makeHttpLlm('https://openrouter.ai/api/v1', env.OPENROUTER_API_KEY, model), model, via: 'OPENROUTER_API_KEY' }
    }
    if (env.OPENAI_API_KEY) {
      const model = 'gpt-4o-mini'
      return { llm: makeHttpLlm('https://api.openai.com/v1', env.OPENAI_API_KEY, model), model, via: 'OPENAI_API_KEY' }
    }
  }
  return undefined
}

/** The refusal printed when a command needs a model and none was given. */
export function missingLlmMessage(command: string, opts: { allowEnvKeys?: boolean; extra?: string } = {}): string {
  const lines = [
    `${command} needs a model. Give it one of:`,
    `  --llm-cmd "<command>"  or  ${LLM_CMD_ENV}="<command>"   the prompt goes to its stdin, its stdout is the answer`,
    `                                                     (for example ${LLM_CMD_ENV}="claude -p --model opus")`,
    '  --llm-base-url <url> --llm-api-key <key> [--model <name>]   an OpenAI-compatible endpoint',
  ]
  if (opts.allowEnvKeys) lines.push('  or set OPENROUTER_API_KEY / OPENAI_API_KEY')
  else lines.push('An API key in the environment (OPENROUTER_API_KEY / OPENAI_API_KEY) is not used on its own; pass it with --llm-base-url and --llm-api-key.')
  if (opts.extra) lines.push(opts.extra)
  return lines.join('\n')
}
