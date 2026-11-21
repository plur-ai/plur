import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, parse } from 'path'
import { createFolderGate } from '../src/folder-gate.js'

type Mode = 'on' | 'off' | 'ask' | 'remote-only'
const policy = (mode: Mode) => ({ mode, remoteAllowed: false, source: mode === 'ask' ? 'default' : 'map' })

/** A Plur stand-in that records every property the gate touches. */
function recordingPlur(root: string, resolve: (dir: string) => ReturnType<typeof policy>) {
  const touched: string[] = []
  const target: Record<string, unknown> = { storageRoot: root, resolveFolderPolicy: resolve }
  const plur = new Proxy(target, {
    get(t, k) {
      touched.push(String(k))
      return t[k as string]
    },
  })
  return { plur: plur as never, touched }
}

describe('folder gate: off, undecided and roots (formal folder-rules)', () => {
  it('an off decision read while checking the folders turns memory off, even when the earlier off check saw on', () => {
    const root = mkdtempSync(join(tmpdir(), 'plur-fr-gate-'))
    const A = join(root, 'proj')
    mkdirSync(A)
    // The first read (the off check) sees on; the user then sets the folder
    // off before the per-folder read.
    let n = 0
    const { plur } = recordingPlur(root, () => policy(n++ === 0 ? 'on' : 'off'))
    const gate = createFolderGate(plur, { hosts: () => [] })
    const r = gate.check({ roots: [A], cwd: A }) as { plur: string }
    expect(r.plur).toBe('off')
  })

  it('a filesystem root is never asked about, and no nonce is issued for it', () => {
    const root = mkdtempSync(join(tmpdir(), 'plur-fr-gate-'))
    const fsRoot = parse(root).root
    const { plur } = recordingPlur(root, () => policy('ask'))
    const gate = createFolderGate(plur, { hosts: () => [] })
    const r = gate.check({ roots: [fsRoot], cwd: fsRoot }) as { plur: string }
    expect(r.plur).not.toBe('ask')
    expect(existsSync(join(root, 'folder-nonces'))).toBe(false)
  })

  it('with a filesystem root among the roots, only the project folder is asked about', () => {
    const root = mkdtempSync(join(tmpdir(), 'plur-fr-gate-'))
    const A = join(root, 'proj')
    mkdirSync(A)
    const { plur } = recordingPlur(root, () => policy('ask'))
    const gate = createFolderGate(plur, { hosts: () => [] })
    const r = gate.check({ roots: [parse(root).root, A], cwd: A }) as { plur: string; folder?: string }
    expect(r.plur).toBe('ask')
    expect(r.folder).toContain('proj')
    gate.end()
  })

  it('a decided folder: the gate reads the decision only, and never sets the process-wide scope slot', () => {
    const root = mkdtempSync(join(tmpdir(), 'plur-fr-gate-'))
    const A = join(root, 'proj')
    mkdirSync(A)
    const { plur, touched } = recordingPlur(root, () => ({ ...policy('on'), scope: 'group:acme/eng' }))
    const gate = createFolderGate(plur, { hosts: () => [] })
    const r = gate.check({ roots: [A], cwd: A }) as { plur: string; scope?: string }
    expect(r).toEqual({ plur: 'on', scope: 'group:acme/eng' })
    expect([...new Set(touched)].sort()).toEqual(['resolveFolderPolicy', 'storageRoot'])
  })
})
