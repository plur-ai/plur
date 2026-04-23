import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type PostinstallEnv = {
  cwd: string
  initCwd?: string
  openclawHome?: string
  ci?: boolean
  skip?: boolean
  isTTY: boolean
  home: string
}

export type PostinstallDecision =
  | { kind: 'skip'; reason: string }
  | { kind: 'already-enabled'; configPath: string; message: string }
  | { kind: 'prompt-setup'; configPath: string | null; message: string }

const PLUGIN_ID = 'plur-claw'

function isSelfInstall(env: PostinstallEnv): boolean {
  if (!env.initCwd) return false
  return env.initCwd === env.cwd
}

function resolveConfigPath(env: PostinstallEnv): string {
  const envHome = env.openclawHome
  const root = envHome && envHome.trim().length > 0 ? envHome : join(env.home, '.openclaw')
  return join(root, 'openclaw.json')
}

function isAlreadyEnabled(path: string): boolean {
  try {
    const raw = readFileSync(path, 'utf8')
    if (raw.trim().length === 0) return false
    const parsed = JSON.parse(raw)
    const entry = parsed?.plugins?.entries?.[PLUGIN_ID]
    return !!(entry && entry.enabled === true)
  } catch {
    return false
  }
}

export function decide(env: PostinstallEnv): PostinstallDecision {
  if (env.skip) return { kind: 'skip', reason: 'PLUR_SKIP_POSTINSTALL set' }
  if (env.ci) return { kind: 'skip', reason: 'CI environment detected' }
  if (isSelfInstall(env)) return { kind: 'skip', reason: 'self-install in package dir' }

  const configPath = resolveConfigPath(env)
  if (existsSync(configPath) && isAlreadyEnabled(configPath)) {
    return {
      kind: 'already-enabled',
      configPath,
      message: `PLUR: plur-claw already enabled in ${configPath}`,
    }
  }

  const msg = [
    'PLUR installed. One more step to enable it in OpenClaw:',
    '  Run: npx @plur-ai/claw setup',
    existsSync(configPath)
      ? `  (will update ${configPath})`
      : `  (will create ${configPath} when OpenClaw is set up)`,
    '  Then restart the OpenClaw gateway so the plugin loader picks it up.',
  ].join('\n')

  return { kind: 'prompt-setup', configPath: existsSync(configPath) ? configPath : null, message: msg }
}

export function readEnv(): PostinstallEnv {
  return {
    cwd: process.cwd(),
    initCwd: process.env.INIT_CWD,
    openclawHome: process.env.OPENCLAW_HOME,
    ci: process.env.CI === 'true' || process.env.CI === '1',
    skip: process.env.PLUR_SKIP_POSTINSTALL === '1' || process.env.PLUR_SKIP_POSTINSTALL === 'true',
    isTTY: !!process.stdout.isTTY,
    home: process.env.HOME ?? homedir(),
  }
}

export function runPostinstallCli(): number {
  try {
    const decision = decide(readEnv())
    if (decision.kind === 'skip') return 0
    process.stdout.write(decision.message + '\n')
    return 0
  } catch {
    return 0
  }
}
