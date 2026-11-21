/**
 * #1824 — on a clean Windows, the onnxruntime binding fails to load with
 * "The specified module could not be found." because the Microsoft Visual C++
 * runtime is not installed, and nothing in `plur doctor` pointed at that.
 *
 * On win32 the files decide (vcruntime140.dll, vcruntime140_1.dll and
 * msvcp140.dll in <SystemRoot>\System32), not the error text, which Windows
 * translates. The English text is used only when SystemRoot cannot be
 * verified — the same rule as plur-ai/enterprise#2347. Every case runs on any
 * platform: the platform, the environment and the folder are parameters.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  VC_RUNTIME_DLLS,
  vcRuntimeMissing,
  vcRuntimeFolder,
  vcRuntimeDiagnosis,
  embedderWithVcRuntime,
  printText,
} from '../src/commands/doctor.js'

const WINGET = 'winget install --id Microsoft.VCRedist.2015+.x64'
const DOWNLOAD = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
const LOAD_ERROR = 'The specified module could not be found.\r\n\\\\?\\C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@plur-ai\\cli\\node_modules\\onnxruntime-node\\bin\\napi-v6\\win32\\x64\\onnxruntime_binding.node'

const failed = (lastError: string | null = LOAD_ERROR) =>
  ({ available: true, loaded: false, lastError, modelLoaded: false, disabled: false, disabledReason: null })

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-vcredist-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function withDlls(names: readonly string[]): string {
  for (const n of names) writeFileSync(join(dir, n), '')
  return dir
}

describe('vcRuntimeMissing (#1824)', () => {
  it('lists nothing when all three runtime files are present', () => {
    expect(vcRuntimeMissing({}, withDlls(VC_RUNTIME_DLLS))).toEqual([])
  })

  it('names each missing runtime file', () => {
    expect(vcRuntimeMissing({}, withDlls(['vcruntime140.dll']))).toEqual(['vcruntime140_1.dll', 'msvcp140.dll'])
  })

  it('is null when no folder is given and SystemRoot is not <drive>:\\Windows', () => {
    expect(vcRuntimeMissing({})).toBeNull()
    expect(vcRuntimeMissing({ SystemRoot: 'D:\\Users\\x' })).toBeNull()
    expect(vcRuntimeMissing({ SystemRoot: '\\\\server\\share\\Windows' })).toBeNull()
    expect(vcRuntimeMissing({ SystemRoot: 'C:\\Windows\\..\\Temp' })).toBeNull()
  })

  it('checks <SystemRoot>\\System32 by absolute path for a verified SystemRoot', () => {
    // The resolved folder, not file existence, so the case holds on any host.
    expect(vcRuntimeFolder({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32')
    expect(vcRuntimeFolder({ SystemRoot: 'd:\\windows' })).toBe('d:\\windows\\System32')
    expect(vcRuntimeFolder({ SystemRoot: '\\\\server\\share\\Windows' })).toBeNull()
    expect(vcRuntimeFolder({ SystemRoot: 'C:\\Windows' }, dir)).toBe(dir)
  })
})

describe('vcRuntimeDiagnosis (#1824)', () => {
  it('names the Visual C++ Redistributable and the fix on Windows with a runtime file missing', () => {
    const d = vcRuntimeDiagnosis(failed(), { platform: 'win32', env: {}, folder: withDlls(['msvcp140.dll']) })
    expect(d).not.toBeNull()
    expect(d!.missing).toEqual(['vcruntime140.dll', 'vcruntime140_1.dll'])
    expect(d!.fix).toContain('Visual C++ Redistributable')
    expect(d!.fix).toContain(WINGET)
    expect(d!.fix).toContain(DOWNLOAD)
  })

  it('decides by the files, not the (translated) error text', () => {
    const d = vcRuntimeDiagnosis(failed('Das angegebene Modul wurde nicht gefunden.'), { platform: 'win32', env: {}, folder: withDlls([]) })
    expect(d).not.toBeNull()
  })

  it('is null on Windows when every runtime file is present, even with the English text', () => {
    expect(vcRuntimeDiagnosis(failed(), { platform: 'win32', env: {}, folder: withDlls(VC_RUNTIME_DLLS) })).toBeNull()
  })

  it('is null on other platforms', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(vcRuntimeDiagnosis(failed(), { platform, env: {}, folder: withDlls([]) })).toBeNull()
    }
  })

  it('is null when the model loaded or embeddings are turned off', () => {
    const folder = withDlls([])
    expect(vcRuntimeDiagnosis({ ...failed(null), modelLoaded: true, loaded: true }, { platform: 'win32', env: {}, folder })).toBeNull()
    expect(vcRuntimeDiagnosis({ ...failed(null), disabled: true, disabledReason: 'PLUR_DISABLE_EMBEDDINGS=1' }, { platform: 'win32', env: {}, folder })).toBeNull()
  })

  it('falls back to the English error text only when SystemRoot cannot be verified', () => {
    const d = vcRuntimeDiagnosis(failed(), { platform: 'win32', env: { SystemRoot: '\\\\server\\share\\Windows' } })
    expect(d).not.toBeNull()
    expect(d!.missing).toBeNull()
    expect(d!.fix).toContain(WINGET)
    expect(vcRuntimeDiagnosis(failed('fetch failed'), { platform: 'win32', env: {} })).toBeNull()
  })
})

describe('embedderWithVcRuntime — the --json embedder object (#1824)', () => {
  it('adds vcRuntime and keeps the original error when the runtime is missing', () => {
    const e = embedderWithVcRuntime(failed(), { platform: 'win32', env: {}, folder: withDlls([]) })
    expect(e.lastError).toBe(LOAD_ERROR)
    expect(e.vcRuntime?.fix).toContain(WINGET)
    expect(e.vcRuntime?.fix).toContain(DOWNLOAD)
    expect(JSON.parse(JSON.stringify(e)).vcRuntime.missing).toEqual([...VC_RUNTIME_DLLS])
  })

  it('returns the embedder unchanged, with no vcRuntime key, when the runtime is present or off Windows', () => {
    const present = embedderWithVcRuntime(failed(), { platform: 'win32', env: {}, folder: withDlls(VC_RUNTIME_DLLS) })
    expect(present).toEqual(failed())
    expect('vcRuntime' in present).toBe(false)
    const mac = embedderWithVcRuntime(failed(), { platform: 'darwin', env: {}, folder: dir })
    expect('vcRuntime' in mac).toBe(false)
  })
})

describe('printText names the Visual C++ runtime (#1824)', () => {
  let out: string[]
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    out = []
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      out.push(String(chunk))
      return true
    }) as never)
  })
  afterEach(() => stdoutSpy.mockRestore())

  function report(embedder: Parameters<typeof printText>[0]['embedder']): Parameters<typeof printText>[0] {
    return {
      configs: [],
      hooksInstalled: true,
      mcpRegistered: true,
      claudeCodeMcp: { registered: true, scope: 'user', path: '/tmp/.claude.json', legacySettingsEntry: false },
      datacoreCollision: false,
      staleNpxHooks: false,
      staleNpxMcp: false,
      brokenNodeMcp: [],
      hookShim: { valid: true, shimPath: '/tmp/shim' },
      mcpShim: { valid: true, shimPath: '/tmp/mcp-shim' },
      handshake: { ok: true, toolCount: 10 },
      cursorHandshake: null,
      embedder,
      cursorProjectDetected: false,
      cursorWired: false,
      codexDetected: false,
      codexWired: false,
      codexCmdShimMcp: false,
      windowsHookFallback: [],
      agyDetected: false,
      agyWired: false,
      pgliteGemmaReembedNeeded: false,
      pgliteOrphan: null,
      staleContentHashes: 0,
      ignoredDuplicateStores: [],
      skippedProjectStores: [],
      tokenEnvUnset: [],
      tokenEnvFound: [],
      opencode: null,
      overall: 'fail',
    }
  }

  it('prints the missing runtime, the winget command and the download link, and keeps the error', () => {
    printText(report(embedderWithVcRuntime(failed(), { platform: 'win32', env: {}, folder: withDlls(['vcruntime140.dll']) })), { quiet: true })
    const text = out.join('')
    expect(text).toContain(`Last error: ${LOAD_ERROR}`)
    expect(text).toContain('Microsoft Visual C++ Redistributable')
    expect(text).toContain('vcruntime140_1.dll, msvcp140.dll')
    expect(text).toContain(WINGET)
    expect(text).toContain(DOWNLOAD)
    // The closing Fix names the runtime, not the model download.
    expect(text).toMatch(/Fix: .*Visual C\+\+ Redistributable/)
    expect(text).not.toContain('BGE-small-en-v1.5 download')
    // The generic causes would contradict the diagnosis; the opt-out stays.
    expect(text).not.toContain('Likely causes:')
    expect(text).not.toContain('First-run download not completed')
    expect(text).not.toContain('pnpm hoisting')
    expect(text).toContain('PLUR_DISABLE_EMBEDDINGS=1')
  })

  it('prints the same report as before when the runtime is present', () => {
    printText(report(embedderWithVcRuntime(failed(), { platform: 'win32', env: {}, folder: withDlls(VC_RUNTIME_DLLS) })), { quiet: true })
    const withCheck = out.join('')
    out.length = 0
    printText(report(failed()), { quiet: true })
    expect(withCheck).toBe(out.join(''))
    expect(withCheck).not.toContain('Visual C++')
    expect(withCheck).toContain('BGE-small-en-v1.5 download')
    expect(withCheck).toContain('Likely causes:')
  })
})
