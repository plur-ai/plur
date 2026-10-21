import { parseInitArgs } from './args.js'
import { prepareInitEnvironment, runEnterpriseInit, type InitDeps } from './init.js'
import { formatSummary, type EnterpriseInitResult } from './summary.js'
import * as tls from 'tls'
import { caSha256 } from './ca.js'
import { readFileSync } from 'fs'

const CA_RESTART = 'PLUR_INIT_CA_RESTART'

export async function runEnterpriseCommand(argv: string[], deps: InitDeps & {
  stdout: (text: string) => void
  stderr: (text: string) => void
  restart: (argv: string[], env: NodeJS.ProcessEnv) => Promise<number>
  startupCaCertificates?: () => string[] | null
}): Promise<number> {
  const opts = parseInitArgs(argv, deps.env ?? process.env)
  if ('error' in opts) { deps.stderr(opts.error + '\n'); return 1 }
  const render = (result: EnterpriseInitResult): number => {
    deps.stdout((opts.json ? JSON.stringify(result) : formatSummary(result).join('\n')) + '\n')
    return result.ok ? 0 : 1
  }
  const env = deps.env ?? process.env
  let previousCa: string | undefined
  try { if (env.NODE_EXTRA_CA_CERTS) previousCa = caSha256(readFileSync(env.NODE_EXTRA_CA_CERTS, 'utf8')) } catch { /* missing or invalid: restart after installation */ }
  let mcpEnv: Record<string, string>
  try { mcpEnv = prepareInitEnvironment(opts, deps) } catch {
    return render({ ok: false, signIn: { username: '', reused: false }, hello: null, tools: [], writeCheck: [], uploadCandidates: 0,
      failure: { step: 'ca', message: 'Could not prepare the verified CA or proxy. Check the fingerprint, certificate file and proxy settings.' } })
  }
  // Inspect Node's loaded certificates, not the file just overwritten above.
  // A same-path certificate rotation still needs a fresh process.
  const certificates = (deps.startupCaCertificates ?? (() => typeof tls.getCACertificates === 'function' ? tls.getCACertificates('extra') : null))()
  // Node 22 before 22.15 cannot inspect loaded extra roots. Force one restart
  // after installing the pinned file, with a retry marker and matching on-disk
  // fingerprint to bound that restart. The marker grants no access: the child
  // still verifies the certificate and must complete the real TLS/MCP proof.
  const trusted = !opts.caSha256 || (certificates === null
    ? env[CA_RESTART] === opts.caSha256 && previousCa === opts.caSha256
    : certificates.some(pem => caSha256(pem) === opts.caSha256))
  if (!trusted || Object.entries(mcpEnv).some(([key, value]) => env[key] !== value)) {
    // Keep stdin inherited by the child. The parent never consumes the key or
    // emits a second result; Node reads CA/proxy settings at process startup.
    return deps.restart(argv, { ...env, ...mcpEnv, ...(certificates === null && opts.caSha256 ? { [CA_RESTART]: opts.caSha256 } : {}) })
  }
  const runEnv = { ...env }; delete runEnv[CA_RESTART]
  return render(await runEnterpriseInit(opts, { ...deps, env: runEnv, print: line => deps.stderr(line + '\n') }))
}
