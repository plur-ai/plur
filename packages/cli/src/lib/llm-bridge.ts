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
 *     `--llm-api-key-env <VAR>` (the key read from that environment variable;
 *     `--llm-api-key <key>` still works and warns: argv lands in shell
 *     history and the process list) (+ `--model`). The base URL must be
 *     https, or plain http to a loopback address only (S13).
 *  3. ONLY for callers that opt in with `allowEnvKeys` (`plur tensions`, whose
 *     existing users rely on it): `OPENROUTER_API_KEY`, else `OPENAI_API_KEY`.
 *     The newer commands never pick up an API key from the environment on
 *     their own; with no explicit bridge they refuse ({@link missingLlmMessage}).
 */
import { spawn } from 'child_process'
import type { LlmFunction } from '@plur-ai/core'
import { makeHttpLlm } from '@plur-ai/gateway/harness'
import { stopProcessTree, stopTreeOnSignal } from './process-tree.js'

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

/** An OpenAI-compatible chat-completions endpoint: the one client cli and mcp share. */
export { makeHttpLlm }

/** Most a command bridge may print (stdout or stderr) before it is stopped: no model reply comes near it. */
export const MAX_LLM_OUTPUT_BYTES = 4 * 1024 * 1024

/**
 * A host model command: run `command` through the shell once per prompt,
 * write the prompt to its stdin, return its stdout. A non-zero exit, a
 * signal, the timeout, output past `maxOutputBytes` (default 4 MB) or an
 * empty answer is an error (with the command's stderr, trimmed), never an
 * empty reply. H16: on POSIX the shell is spawned detached, so a timeout or
 * the output cap stops everything the command started (the process group),
 * not only the shell; on Windows only the spawned process is stopped.
 */
export function makeCommandLlm(command: string, opts: { timeoutMs?: number; maxOutputBytes?: number } = {}): LlmFunction {
  const timeoutMs = opts.timeoutMs ?? llmTimeoutMs()
  const maxBytes = opts.maxOutputBytes ?? MAX_LLM_OUTPUT_BYTES
  return (prompt: string) => new Promise<string>((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    const removeSignalHandlers = stopTreeOnSignal(child)
    let out = ''
    let err = ''
    let outBytes = 0
    let errBytes = 0
    let settled = false
    const fail = (e: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      removeSignalHandlers()
      stopProcessTree(child)
      reject(e)
    }
    const timer = setTimeout(() => {
      fail(new Error(`The model command did not answer within ${Math.round(timeoutMs / 1000)}s (${LLM_CMD_ENV} / --llm-cmd; limit: ${LLM_TIMEOUT_ENV}).`))
    }, timeoutMs)
    const tooMuch = (stream: string) => fail(new Error(`The model command printed more than ${maxBytes} bytes on ${stream}; it was stopped.`))
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      outBytes += Buffer.byteLength(d)
      if (outBytes > maxBytes) return tooMuch('stdout')
      out += d
    })
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      errBytes += Buffer.byteLength(d)
      if (errBytes > maxBytes) return tooMuch('stderr')
      err += d
    })
    child.once('error', e => fail(new Error(`The model command could not start: ${e.message}`)))
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      removeSignalHandlers()
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
  /** `--llm-api-key` (warned: visible in shell history and the process list). */
  apiKey?: string
  /** `--llm-api-key-env`: the NAME of the environment variable holding the key. */
  apiKeyEnv?: string
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

/**
 * S13: why `url` may not carry an API key, or null when it may. https is
 * required; plain http only to a loopback host (localhost, 127.0.0.0/8, ::1),
 * where the key never leaves the machine.
 */
export function checkLlmBaseUrl(url: string): string | null {
  let u: URL
  try { u = new URL(url) } catch { return `--llm-base-url is not a valid URL: ${url}` }
  if (u.protocol === 'https:') return null
  if (u.protocol === 'http:') {
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)) return null
    return `--llm-base-url must use https (plain http is allowed only to localhost / 127.0.0.1 / ::1): the API key would be sent in clear text to ${u.host}`
  }
  return `--llm-base-url must be an https URL, got ${u.protocol}`
}

/**
 * Pick the model bridge by the precedence above. Undefined when none applies.
 * Throws (message safe to print, never a key) on an unusable endpoint: a
 * base URL that is not https or loopback http, a named key variable that is
 * unset, or both key options at once.
 */
export function resolveLlm(
  opts: LlmBridgeOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  io: { warn?: (line: string) => void } = {},
): ResolvedLlm | undefined {
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
    const bad = checkLlmBaseUrl(opts.baseUrl)
    if (bad) throw new Error(bad)
    if (opts.apiKey !== undefined && opts.apiKeyEnv !== undefined) throw new Error('Give either --llm-api-key or --llm-api-key-env, not both.')
    let apiKey = opts.apiKey ?? ''
    if (opts.apiKeyEnv !== undefined) {
      const v = env[opts.apiKeyEnv]
      if (!v) throw new Error(`--llm-api-key-env ${opts.apiKeyEnv}: that environment variable is not set (or empty).`)
      apiKey = v
    } else if (opts.apiKey) {
      (io.warn ?? (l => process.stderr.write(l + '\n')))(
        'Warning: --llm-api-key puts the key in your shell history and the process list. Use --llm-api-key-env <VAR> instead.')
    }
    const model = opts.model ?? 'gpt-4o-mini'
    return { llm: makeHttpLlm(opts.baseUrl, apiKey, model), model, via: '--llm-base-url' }
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
    '  --llm-base-url <https-url> --llm-api-key-env <VAR> [--model <name>]   an OpenAI-compatible endpoint, key read from $VAR',
  ]
  if (opts.allowEnvKeys) lines.push('  or set OPENROUTER_API_KEY / OPENAI_API_KEY')
  else lines.push('An API key in the environment (OPENROUTER_API_KEY / OPENAI_API_KEY) is not used on its own; name it with --llm-base-url and --llm-api-key-env.')
  if (opts.extra) lines.push(opts.extra)
  return lines.join('\n')
}

/** resolveLlm for a command: an unusable endpoint exits 1 with the reason. */
export function resolveLlmOrExit(opts: LlmBridgeOptions, env: NodeJS.ProcessEnv = process.env): ResolvedLlm | undefined {
  try {
    return resolveLlm(opts, env)
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    process.exit(1)
  }
}
