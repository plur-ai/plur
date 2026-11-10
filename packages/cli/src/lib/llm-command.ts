/**
 * The host-model bridge for CLI commands that need judgement (the pin audit,
 * overhaul W3).
 *
 * Core never calls a model itself (no external calls in core). A command that
 * needs one takes a shell command that reads the prompt on stdin and prints
 * the answer on stdout — `--llm-cmd "<cmd>"`, or the `PLUR_LLM_CMD`
 * environment variable — so the model is whatever the host already runs (for
 * example `claude -p --model opus`), with the host's own login. Nothing here
 * holds or reads an API key.
 */
import { spawn } from 'child_process'
import type { LlmFunction } from '@plur-ai/core'

/** Environment variable naming the model command. */
export const LLM_CMD_ENV = 'PLUR_LLM_CMD'

/** Default per-call limit; override with PLUR_LLM_TIMEOUT_MS. */
export const DEFAULT_LLM_TIMEOUT_MS = 10 * 60_000

/** The model command: the flag first, then PLUR_LLM_CMD. Undefined when neither is set. */
export function resolveLlmCommand(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const cmd = (flag ?? env[LLM_CMD_ENV] ?? '').trim()
  return cmd || undefined
}

/** The refusal printed when no model command is configured. */
export function missingLlmCommandMessage(command: string): string {
  return `${command} needs a model: pass --llm-cmd "<command that reads the prompt on stdin and prints the answer>" `
    + `or set ${LLM_CMD_ENV} (for example ${LLM_CMD_ENV}="claude -p --model opus").`
}

/**
 * An {@link LlmFunction} that runs `cmd` through the shell once per prompt,
 * writing the prompt to its stdin. A non-zero exit, a timeout or an empty
 * answer is an error naming the command's stderr.
 */
export function llmFromCommand(cmd: string, opts?: { timeoutMs?: number }): LlmFunction {
  const envTimeout = parseInt(process.env.PLUR_LLM_TIMEOUT_MS ?? '', 10)
  const timeoutMs = opts?.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_LLM_TIMEOUT_MS)
  return (prompt: string) => new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`The model command did not answer within ${Math.round(timeoutMs / 1000)}s (${LLM_CMD_ENV} / --llm-cmd).`))
    }, timeoutMs)
    child.stdout.on('data', c => { stdout += c })
    child.stderr.on('data', c => { stderr += c })
    child.once('error', err => { clearTimeout(timer); reject(new Error(`The model command could not start: ${err.message}`)) })
    child.once('close', code => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`The model command exited with ${code}: ${stderr.trim().slice(0, 500) || 'no error output'}`))
      if (!stdout.trim()) return reject(new Error('The model command printed nothing.'))
      resolve(stdout)
    })
    child.stdin.on('error', () => { /* the command may exit without reading; reported by close */ })
    child.stdin.end(prompt)
  })
}
