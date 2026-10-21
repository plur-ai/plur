import { it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, copyFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { caSha256 } from '../src/enterprise/ca.js'

it('restarts before network work with the verified CA and proxy env and preserves stdin arguments', async () => {
  const home = mkdtempSync(join(tmpdir(), 'enterprise-command-'))
  try {
    const { runEnterpriseCommand } = await import('../src/enterprise/command.js')
    const caFile = join(__dirname, 'fixtures/enterprise/test-ca.pem'), fingerprint = caSha256(readFileSync(caFile, 'utf8'))
    const argv = ['init', '--server', 'https://server.example.invalid', '--ca-file', caFile, '--ca-sha256', fingerprint, '--proxy', 'http://proxy.example.invalid:8080', '--token-stdin', '--json']
    let restarted = false
    const result = await runEnterpriseCommand(argv, {
      home, env: { HOME: home, PLUR_PATH: join(home, '.plur') }, cliEntry: '/fixture/index.js',
      fetch: async () => { throw new Error('Network must not start before restart') },
      stdout: () => { throw new Error('Parent must not print a second JSON document') }, stderr: () => {},
      restart: async (args, env) => {
        restarted = true; expect(args).toEqual(argv)
        expect(env).toMatchObject({ NODE_EXTRA_CA_CERTS: join(home, '.plur/company-ca.pem'), HTTPS_PROXY: 'http://proxy.example.invalid:8080', NODE_USE_ENV_PROXY: '1' })
        expect(caSha256(readFileSync(env.NODE_EXTRA_CA_CERTS!, 'utf8'))).toBe(fingerprint)
        return 7
      },
    })
    expect(restarted).toBe(true); expect(result).toBe(7)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

it('prints one token-free JSON failure when CA validation fails before sign-in', async () => {
  const { runEnterpriseCommand } = await import('../src/enterprise/command.js')
  const output: string[] = []
  const result = await runEnterpriseCommand(['init', '--server', 'https://server.example.invalid', '--ca-file', '/missing.pem', '--ca-sha256', '0'.repeat(64), '--json'], {
    home: tmpdir(), env: {}, cliEntry: '/fixture/index.js', stdout: line => output.push(line), stderr: () => {},
    fetch: async () => { throw new Error('No request allowed') }, restart: async () => { throw new Error('No restart allowed') },
  })
  expect(result).toBe(1); expect(output).toHaveLength(1)
  expect(JSON.parse(output[0])).toMatchObject({ ok: false, failure: { step: 'ca' } })
})

it('restarts after replacing a CA at the same environment path before any network request', async () => {
  const home = mkdtempSync(join(tmpdir(), 'enterprise-ca-replacement-'))
  try {
    const { runEnterpriseCommand } = await import('../src/enterprise/command.js')
    const plurDir = join(home, '.plur'), destination = join(plurDir, 'company-ca.pem')
    mkdirSync(plurDir)
    copyFileSync(join(__dirname, 'fixtures/enterprise/other-ca.pem'), destination)
    const caFile = join(__dirname, 'fixtures/enterprise/test-ca.pem'), fingerprint = caSha256(readFileSync(caFile, 'utf8'))
    let requests = 0, restarts = 0
    const result = await runEnterpriseCommand(['init', '--server', 'https://server.example.invalid', '--ca-file', caFile, '--ca-sha256', fingerprint, '--json'], {
      home, env: { HOME: home, PLUR_PATH: plurDir, NODE_EXTRA_CA_CERTS: destination }, cliEntry: '/fixture/index.js', stdout: () => {}, stderr: () => {},
      fetch: async () => { requests++; throw new Error('Network started with stale trust') },
      restart: async () => { restarts++; return 7 },
    })
    expect(requests).toBe(0); expect(restarts).toBe(1); expect(result).toBe(7)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

it('supports older Node 22 with one verified-file restart rather than rejecting the advertised runtime', async () => {
  const home = mkdtempSync(join(tmpdir(), 'enterprise-ca-compatibility-'))
  try {
    const { runEnterpriseCommand } = await import('../src/enterprise/command.js')
    const caFile = join(__dirname, 'fixtures/enterprise/test-ca.pem'), fingerprint = caSha256(readFileSync(caFile, 'utf8'))
    const argv = ['init', '--server', 'https://server.example.invalid', '--ca-file', caFile, '--ca-sha256', fingerprint, '--json']
    let requests = 0, restarts = 0, childEnv: NodeJS.ProcessEnv = {}
    const deps = { home, env: { HOME: home, PLUR_PATH: join(home, '.plur') }, cliEntry: '/fixture/index.js',
      startupCaCertificates: () => null, stdout: () => {}, stderr: () => {},
      fetch: async () => { requests++; throw new Error('Fixture ends at the first real network attempt') },
      restart: async (_args: string[], env: NodeJS.ProcessEnv) => { childEnv = env; restarts++; return 7 },
    }
    expect(await runEnterpriseCommand(argv, deps)).toBe(7)
    expect(restarts).toBe(1); expect(requests).toBe(0)
    expect(await runEnterpriseCommand(argv, { ...deps, env: childEnv })).toBe(1)
    expect(restarts).toBe(1); expect(requests).toBe(1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
