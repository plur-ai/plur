// Proxy and the environment a tool's MCP launch gets (#1638). The env is
// written into editor configs, so it carries only the CA path and the proxy
// settings: never a token, never a proxy password, never a switch that turns
// TLS verification off.
import { describe, it, expect } from 'vitest'
import {
  resolveProxy,
  buildToolMcpEnv,
  envProxySupported,
  TOOL_ENV_KEYS,
  LaunchEnvError,
} from '../src/enterprise/launch-env.js'

describe('resolveProxy', () => {
  it('reads HTTPS_PROXY, HTTP_PROXY and NO_PROXY', () => {
    expect(resolveProxy({ env: { HTTPS_PROXY: 'http://p.example.com:3128', HTTP_PROXY: 'http://q.example.com:3128', NO_PROXY: 'localhost' } }))
      .toEqual({ https: 'http://p.example.com:3128', http: 'http://q.example.com:3128', noProxy: 'localhost' })
  })

  it('falls back to the lower-case names', () => {
    expect(resolveProxy({ env: { https_proxy: 'http://p.example.com:3128', http_proxy: 'http://q.example.com:3128', no_proxy: '.corp' } }))
      .toEqual({ https: 'http://p.example.com:3128', http: 'http://q.example.com:3128', noProxy: '.corp' })
  })

  it('--proxy wins over the environment for https', () => {
    expect(resolveProxy({ flag: 'http://flag.example.com:8080', env: { HTTPS_PROXY: 'http://p.example.com:3128' } }))
      .toEqual({ https: 'http://flag.example.com:8080' })
  })

  it('empty values are absent', () => {
    expect(resolveProxy({ env: { HTTPS_PROXY: '', https_proxy: '', NO_PROXY: '' } })).toEqual({})
  })
})

describe('buildToolMcpEnv', () => {
  it('CA and proxy: the plan example', () => {
    expect(buildToolMcpEnv({ caPath: '/h/.plur/company-ca.pem', proxy: { https: 'http://proxy.example.com:3128', noProxy: 'localhost' } }))
      .toEqual({ NODE_EXTRA_CA_CERTS: '/h/.plur/company-ca.pem', HTTPS_PROXY: 'http://proxy.example.com:3128', NO_PROXY: 'localhost', NODE_USE_ENV_PROXY: '1' })
  })

  it('nothing given → nothing written', () => {
    expect(buildToolMcpEnv({ proxy: {} })).toEqual({})
  })

  it('CA only: no proxy switch', () => {
    expect(buildToolMcpEnv({ caPath: 'C:\\Users\\alice\\.plur\\company-ca.pem', proxy: {} }))
      .toEqual({ NODE_EXTRA_CA_CERTS: 'C:\\Users\\alice\\.plur\\company-ca.pem' })
  })

  it('NO_PROXY alone does not turn proxy use on', () => {
    expect(buildToolMcpEnv({ proxy: { noProxy: 'localhost' } })).toEqual({ NO_PROXY: 'localhost' })
  })

  it('every key it can write is in the allowlist, and the allowlist has no TLS switch and no token', () => {
    const env = buildToolMcpEnv({ caPath: '/c.pem', proxy: { https: 'http://p:1', http: 'http://p:2', noProxy: 'x' } })
    for (const k of Object.keys(env)) expect(TOOL_ENV_KEYS).toContain(k)
    expect([...TOOL_ENV_KEYS].sort()).toEqual(['HTTPS_PROXY', 'HTTP_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY', 'NO_PROXY'])
    for (const k of TOOL_ENV_KEYS) {
      expect(k).not.toMatch(/REJECT_UNAUTHORIZED|TOKEN|KEY|SECRET|PASSWORD/i)
    }
  })

  it('the CA is added (NODE_EXTRA_CA_CERTS), never a replacement trust file', () => {
    const env = buildToolMcpEnv({ caPath: '/c.pem', proxy: {} })
    for (const replacing of ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
      expect(env).not.toHaveProperty(replacing)
    }
  })

  it('a proxy address with a user name or password is refused, and the error does not echo it', () => {
    for (const proxy of [{ https: 'http://alice:s3cret@proxy.example.com:3128' }, { http: 'http://tok3n@proxy.example.com:3128' }, { https: 'alice:s3cret@proxy.example.com:3128' }]) {
      let err: unknown
      try { buildToolMcpEnv({ proxy }) } catch (e) { err = e }
      expect(err).toBeInstanceOf(LaunchEnvError)
      expect(String((err as Error).message)).not.toContain('s3cret')
      expect(String((err as Error).message)).not.toContain('tok3n')
    }
  })

  it('credentials hidden from a naive authority split are still refused (whitespace, tabs, extra slashes)', () => {
    for (const https of [
      ' http://alice:s3cret@proxy.example.com:3128',
      'http://alice:s3cret@proxy.example.com:3128 ',
      'http://ali\tce:s3cret@proxy.example.com:3128',
      'http:///alice:s3cret@proxy.example.com:3128',
      'http:\\\\alice:s3cret@proxy.example.com:3128',
      'http://proxy.example.com:3128/@x',
      'HTTP://alice:s3cret@proxy.example.com',
    ]) {
      let err: unknown
      try { buildToolMcpEnv({ proxy: { https } }) } catch (e) { err = e }
      expect(err, https).toBeInstanceOf(LaunchEnvError)
      expect(String((err as Error).message)).not.toContain('s3cret')
    }
  })

  it('a plain proxy address is written as given', () => {
    expect(buildToolMcpEnv({ proxy: { https: 'http://proxy.example.com:3128', http: 'proxy.example.com:8080' } }))
      .toEqual({ HTTPS_PROXY: 'http://proxy.example.com:3128', HTTP_PROXY: 'proxy.example.com:8080', NODE_USE_ENV_PROXY: '1' })
  })

  it('a value with a line break is refused (it would inject a second setting into a config file)', () => {
    expect(() => buildToolMcpEnv({ caPath: '/c.pem\nNODE_TLS_REJECT_UNAUTHORIZED=0', proxy: {} })).toThrow(LaunchEnvError)
    expect(() => buildToolMcpEnv({ proxy: { noProxy: 'a\r\nb' } })).toThrow(LaunchEnvError)
    expect(() => buildToolMcpEnv({ proxy: { https: 'http://proxy.example.com:3128\0x' } })).toThrow(LaunchEnvError)
  })
})

describe('envProxySupported', () => {
  it('Node reads the proxy variables with NODE_USE_ENV_PROXY=1 from 22.21 and 24.0', () => {
    expect(envProxySupported('22.20.0')).toBe(false)
    expect(envProxySupported('22.21.0')).toBe(true)
    expect(envProxySupported('22.22.2')).toBe(true)
    expect(envProxySupported('23.11.0')).toBe(false)
    expect(envProxySupported('24.0.0')).toBe(true)
    expect(envProxySupported('26.10.0')).toBe(true)
    expect(envProxySupported('20.20.2')).toBe(false)
    expect(envProxySupported('v24.1.0')).toBe(true)
  })
})
