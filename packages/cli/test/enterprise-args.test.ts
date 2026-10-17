import { describe, it, expect } from 'vitest'
import { parseInitArgs } from '../src/enterprise/args.js'

describe('parseInitArgs', () => {
  it('accepts --server, strips trailing slash', () => {
    expect(parseInitArgs(['init', '--server', 'https://plur.example.com/'], {})).toMatchObject({
      server: 'https://plur.example.com',
      mode: 'full',
      tokenStdin: false,
    })
  })

  it('falls back to PLUR_SERVER env', () => {
    expect(parseInitArgs(['init'], { PLUR_SERVER: 'https://plur.example.com' })).toMatchObject({
      server: 'https://plur.example.com',
    })
  })

  it('rejects insecure http:// on non-localhost', () => {
    expect(parseInitArgs(['init', '--server', 'http://plur.example.com'], {})).toEqual({
      error: 'Insecure server URL http://plur.example.com — use https:// (http:// is only allowed for localhost).',
    })
  })

  it('allows http:// on 127.0.0.1 loopback', () => {
    expect(parseInitArgs(['init', '--server', 'http://127.0.0.1:59998'], {})).toMatchObject({
      server: 'http://127.0.0.1:59998',
    })
  })

  it('errors when no server given', () => {
    expect(parseInitArgs(['init'], {})).toEqual({
      error: 'No server given. Run: plur-enterprise init --server https://<your PLUR server>',
    })
  })

  it('rejects non-64-hex --ca-sha256', () => {
    expect(
      parseInitArgs(['init', '--server', 'https://plur.example.com', '--ca-sha256', 'xyz'], {}),
    ).toEqual({ error: '--ca-sha256 must be 64 hex characters' })
  })

  it('accepts --expect-version and normalises --ca-sha256 to lowercase', () => {
    expect(
      parseInitArgs(
        [
          'init',
          '--server',
          'https://plur.example.com',
          '--expect-version',
          '0.22.0',
          '--ca-sha256',
          'A'.repeat(64),
        ],
        {},
      ),
    ).toMatchObject({ expectVersion: '0.22.0', caSha256: 'a'.repeat(64) })
  })

  it('allows http:// on [::1] and localhost', () => {
    expect(parseInitArgs(['init', '--server', 'http://[::1]:59998'], {})).toMatchObject({
      server: 'http://[::1]:59998',
    })
    expect(parseInitArgs(['init', '--server', 'http://localhost:59998/'], {})).toMatchObject({
      server: 'http://localhost:59998',
    })
  })

  it('rejects schemes other than https and loopback http', () => {
    for (const url of ['ftp://plur.example.com', 'file:///etc/passwd', 'ws://plur.example.com']) {
      expect(parseInitArgs(['init', '--server', url], {})).toHaveProperty('error')
    }
  })

  it('strips userinfo and never echoes it in an error', () => {
    expect(
      parseInitArgs(['init', '--server', 'https://alice:s3cret@plur.example.com/x'], {}),
    ).toMatchObject({ server: 'https://plur.example.com' })
    const r = parseInitArgs(['init', '--server', 'http://alice:s3cret@plur.example.com'], {})
    expect(JSON.stringify(r)).not.toContain('s3cret')
    const bad = parseInitArgs(['init', '--server', 'alice:s3cret@not a url'], {})
    expect(bad).toHaveProperty('error')
    expect(JSON.stringify(bad)).not.toContain('s3cret')
  })

  it('a flag missing its value is an error, never silently dropped', () => {
    expect(
      parseInitArgs(['init', '--server', 'https://plur.example.com', '--ca-sha256'], {}),
    ).toEqual({ error: '--ca-sha256 needs a value' })
    expect(parseInitArgs(['init', '--server'], { PLUR_SERVER: 'https://plur.example.com' })).toEqual({
      error: '--server needs a value',
    })
    expect(
      parseInitArgs(['init', '--server', 'https://plur.example.com', '--ca-file', '--json'], {}),
    ).toEqual({ error: '--ca-file needs a value' })
  })

  it('an unknown option is an error', () => {
    expect(
      parseInitArgs(['init', '--server', 'https://plur.example.com', '--ca-sha', 'a'.repeat(64)], {}),
    ).toEqual({ error: 'Unknown option: --ca-sha' })
  })

  it('--mode full is accepted; any other mode is an error', () => {
    expect(
      parseInitArgs(['init', '--server', 'https://plur.example.com', '--mode', 'full'], {}),
    ).toMatchObject({ mode: 'full' })
    expect(
      parseInitArgs(['init', '--server', 'https://plur.example.com', '--mode', 'remote-only'], {}),
    ).toEqual({ error: 'remote-only mode is set up by the install script, not by plur-enterprise' })
    expect(
      parseInitArgs(['init', '--server', 'https://plur.example.com', '--mode', 'bogus'], {}),
    ).toEqual({ error: 'Unknown mode: bogus' })
  })
})
