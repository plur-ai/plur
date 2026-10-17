export type InitOptions = {
  server: string
  expectVersion?: string
  caFile?: string
  caSha256?: string
  proxy?: string
  mode: 'full'
  tokenStdin: boolean
  json: boolean
  noBrowser: boolean
}

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

export function parseInitArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
): InitOptions | { error: string } {
  const args = argv.slice(1)

  let server: string | undefined
  let expectVersion: string | undefined
  let caFile: string | undefined
  let caSha256: string | undefined
  let proxy: string | undefined
  let tokenStdin = false
  let json = false
  let noBrowser = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--server' && i + 1 < args.length) {
      server = args[++i]
    } else if (arg === '--expect-version' && i + 1 < args.length) {
      expectVersion = args[++i]
    } else if (arg === '--ca-file' && i + 1 < args.length) {
      caFile = args[++i]
    } else if (arg === '--ca-sha256' && i + 1 < args.length) {
      caSha256 = args[++i]
    } else if (arg === '--proxy' && i + 1 < args.length) {
      proxy = args[++i]
    } else if (arg === '--token-stdin') {
      tokenStdin = true
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--no-browser') {
      noBrowser = true
    } else if (arg === '--mode' && i + 1 < args.length) {
      const mode = args[++i]
      if (mode === 'remote-only') {
        return {
          error: 'remote-only mode is set up by the install script, not by plur-enterprise',
        }
      }
    }
  }

  if (!server) {
    server = env['PLUR_SERVER']
  }

  if (!server) {
    return {
      error:
        'No server given. Run: plur-enterprise init --server https://<your PLUR server>',
    }
  }

  let parsed: URL
  try {
    parsed = new URL(server)
  } catch {
    return { error: `Invalid server URL: ${server}` }
  }

  if (parsed.protocol === 'http:') {
    if (!LOCALHOST_HOSTNAMES.has(parsed.hostname)) {
      return {
        error: `Insecure server URL ${parsed.origin} — use https:// (http:// is only allowed for localhost).`,
      }
    }
  }

  if (caSha256 !== undefined) {
    if (!/^[0-9a-fA-F]{64}$/.test(caSha256)) {
      return { error: '--ca-sha256 must be 64 hex characters' }
    }
    caSha256 = caSha256.toLowerCase()
  }

  return {
    server: parsed.origin,
    expectVersion,
    caFile,
    caSha256,
    proxy,
    mode: 'full',
    tokenStdin,
    json,
    noBrowser,
  }
}
