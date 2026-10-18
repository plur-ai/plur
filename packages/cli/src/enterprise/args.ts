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

// WHATWG URL keeps the brackets on an IPv6 hostname.
const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

const VALUE_FLAGS = new Set(['--server', '--expect-version', '--ca-file', '--ca-sha256', '--proxy', '--mode'])

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
    if (VALUE_FLAGS.has(arg)) {
      // A flag without its value is an error: silently dropping e.g.
      // --ca-sha256 would skip the CA check the caller asked for. An empty
      // value (`--server "$UNSET"`) is a missing value too: `--server ""`
      // would otherwise fall back to PLUR_SERVER without a word.
      const value = args[i + 1]
      if (value === undefined || value === '' || value.startsWith('--')) {
        return { error: `${arg} needs a value` }
      }
      i++
      if (arg === '--server') server = value
      else if (arg === '--expect-version') expectVersion = value
      else if (arg === '--ca-file') caFile = value
      else if (arg === '--ca-sha256') caSha256 = value
      else if (arg === '--proxy') proxy = value
      else if (arg === '--mode') {
        if (value === 'remote-only') {
          return {
            error: 'remote-only mode is set up by the install script, not by plur-enterprise',
          }
        }
        if (value !== 'full') return { error: `Unknown mode: ${value}` }
      }
    } else if (arg === '--token-stdin') {
      tokenStdin = true
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--no-browser') {
      noBrowser = true
    } else {
      return { error: `Unknown option: ${arg}` }
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
    // Not echoed: the raw value may carry credentials.
    return { error: 'Invalid server URL — give the full address, e.g. https://plur.example.com' }
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: `Unsupported server URL scheme ${parsed.protocol} — use https://` }
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
