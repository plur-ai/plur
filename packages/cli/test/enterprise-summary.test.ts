import { describe, it, expect } from 'vitest'
import { formatSummary, EnterpriseInitResult } from '../src/enterprise/summary.js'

const freshMachine: EnterpriseInitResult = {
  ok: true,
  signIn: { username: 'alice', keyName: 'alice — ws-0142 (Windows)', reused: false },
  hello: {
    saved: { ok: true, id: 'ENG-1' },
    perTool: [
      { tool: 'codex', recalled: true },
      { tool: 'opencode', recalled: true },
    ],
  },
  tools: [
    { tool: 'codex', status: 'wired', configPath: '/home/alice/.codex/config.toml', proven: true },
    { tool: 'opencode', status: 'wired', configPath: '/home/alice/.opencode.json', proven: true },
  ],
  writeCheck: [{ scope: 'group:acme/team', writable: true, review_held: false }],
  uploadCandidates: 17,
}

describe('formatSummary', () => {
  it('fresh machine: Codex + OpenCode, exact output', () => {
    expect(formatSummary(freshMachine)).toEqual([
      '✓ Signed in as alice · key "alice — ws-0142 (Windows)"',
      '✓ Server reachable, saves confirmed',
      '• Codex     wired — restart Codex, then run /hooks and trust PLUR',
      '• OpenCode  wired — restart OpenCode',
      '• Upload:   17 memories exist only on this laptop → run `plur upload` to review',
    ])
  })

  it('upload line is absent when uploadCandidates === 0', () => {
    const r = { ...freshMachine, uploadCandidates: 0 }
    const lines = formatSummary(r)
    expect(lines.some(l => l.startsWith('• Upload:'))).toBe(false)
  })

  it('Claude Code wired line has correct text', () => {
    const r: EnterpriseInitResult = {
      ok: true,
      signIn: { username: 'alice', keyName: 'alice — ws-0142', reused: false },
      hello: {
        saved: { ok: true, id: 'ENG-2' },
        perTool: [{ tool: 'claude-code', recalled: true }],
      },
      tools: [
        {
          tool: 'claude-code',
          status: 'wired',
          configPath: '/home/alice/.claude.json',
          proven: true,
        },
      ],
      writeCheck: [{ scope: 'user:acme:alice', writable: true, review_held: false }],
      uploadCandidates: 0,
    }
    const lines = formatSummary(r)
    // col = max(11) + 2 = 13; 'Claude Code'.padEnd(13) = 'Claude Code  '
    expect(lines).toContain('• Claude Code  wired — restart Claude Code')
  })

  it('Cursor wired line has correct text', () => {
    const r: EnterpriseInitResult = {
      ok: true,
      signIn: { username: 'alice', keyName: 'alice — ws-0142', reused: false },
      hello: {
        saved: { ok: true, id: 'ENG-3' },
        perTool: [{ tool: 'cursor', recalled: true }],
      },
      tools: [
        {
          tool: 'cursor',
          status: 'wired',
          configPath: '/home/alice/.cursor/mcp.json',
          proven: true,
        },
      ],
      writeCheck: [{ scope: 'user:acme:alice', writable: true, review_held: false }],
      uploadCandidates: 0,
    }
    const lines = formatSummary(r)
    // col = max(6) + 2 = 8; 'Cursor'.padEnd(8) = 'Cursor  '
    expect(lines).toContain('• Cursor  wired — restart Cursor')
  })

  it('re-run with reused key: first line says "existing key reused"', () => {
    const r: EnterpriseInitResult = {
      ...freshMachine,
      signIn: { username: 'alice', reused: true },
    }
    expect(formatSummary(r)[0]).toBe('✓ Signed in as alice · existing key reused')
  })

  it('not_synced: shows ✗ not-synced line, no ✓ server line', () => {
    const r: EnterpriseInitResult = {
      ok: false,
      signIn: { username: 'alice', keyName: 'alice — ws-0142 (Windows)', reused: false },
      hello: { saved: { ok: false, reason: 'not_synced' }, perTool: [] },
      tools: [
        { tool: 'codex', status: 'wired', configPath: '/home/alice/.codex/config.toml', proven: false },
      ],
      writeCheck: [],
      uploadCandidates: 0,
    }
    const lines = formatSummary(r)
    expect(lines).toContain(
      '✗ Your account is not set up on the server yet (not synced). Ask your PLUR admin, or try again in 15 minutes.',
    )
    expect(lines).not.toContain('✓ Server reachable, saves confirmed')
  })

  it('tool recall failed: shows "wired, but not proven" with reason', () => {
    const r: EnterpriseInitResult = {
      ok: false,
      signIn: { username: 'alice', keyName: 'alice — ws-0142 (Windows)', reused: true },
      hello: {
        saved: { ok: true, id: 'ENG-4' },
        perTool: [
          { tool: 'codex', recalled: true },
          {
            tool: 'opencode',
            recalled: false,
            reason: "saved, but OpenCode's environment could not recall it",
          },
        ],
      },
      tools: [
        { tool: 'codex', status: 'wired', configPath: '/home/alice/.codex/config.toml', proven: true },
        {
          tool: 'opencode',
          status: 'wired',
          configPath: '/home/alice/.opencode.json',
          proven: false,
        },
      ],
      writeCheck: [{ scope: 'user:acme:alice', writable: true, review_held: false }],
      uploadCandidates: 17,
    }
    // col = max(5, 8, 7) + 2 = 10; 'OpenCode'.padEnd(10) = 'OpenCode  '
    const lines = formatSummary(r)
    expect(lines).toContain(
      "• OpenCode  wired, but not proven: saved, but OpenCode's environment could not recall it",
    )
  })

  it('hello save failed: no ✓ server reachable line', () => {
    const r: EnterpriseInitResult = {
      ok: false,
      signIn: { username: 'alice', keyName: 'alice — ws-0142 (Windows)', reused: false },
      hello: {
        saved: { ok: false, reason: 'queued for user:acme:alice (not on the server yet)' },
        perTool: [],
      },
      tools: [],
      writeCheck: [],
      uploadCandidates: 0,
    }
    const lines = formatSummary(r)
    expect(lines).not.toContain('✓ Server reachable, saves confirmed')
  })

  it('Codex on WSL side shows "runs in WSL" line', () => {
    const r: EnterpriseInitResult = {
      ok: false,
      signIn: { username: 'alice', keyName: 'alice — ws-0142 (Windows)', reused: false },
      hello: {
        saved: { ok: true, id: 'ENG-5' },
        perTool: [{ tool: 'opencode', recalled: true }],
      },
      tools: [
        { tool: 'codex', status: 'other-side', configPath: '', proven: false },
        {
          tool: 'opencode',
          status: 'wired',
          configPath: '/home/alice/.opencode.json',
          proven: true,
        },
      ],
      writeCheck: [{ scope: 'user:acme:alice', writable: true, review_held: false }],
      uploadCandidates: 17,
    }
    // col = max(5, 8, 7) + 2 = 10; 'Codex'.padEnd(10) = 'Codex     '
    const lines = formatSummary(r)
    expect(lines).toContain('• Codex     runs in WSL — run the installer inside WSL')
  })

  it('write-check writable:false shows "!" line with reason', () => {
    const r: EnterpriseInitResult = {
      ok: true,
      signIn: { username: 'alice', keyName: 'alice — ws-0142 (Windows)', reused: false },
      hello: { saved: { ok: true, id: 'ENG-6' }, perTool: [] },
      tools: [],
      writeCheck: [
        { scope: 'group:acme/team', writable: false, review_held: false, reason: 'admin restriction' },
      ],
      uploadCandidates: 0,
    }
    const lines = formatSummary(r)
    expect(lines).toContain('! group:acme/team: not writable (admin restriction)')
  })

  it('write-check writable:false without reason omits parens', () => {
    const r: EnterpriseInitResult = {
      ok: true,
      signIn: { username: 'alice', keyName: 'alice — ws-0142', reused: false },
      hello: { saved: { ok: true, id: 'ENG-7' }, perTool: [] },
      tools: [],
      writeCheck: [{ scope: 'group:acme/team', writable: false, review_held: false }],
      uploadCandidates: 0,
    }
    const lines = formatSummary(r)
    expect(lines).toContain('! group:acme/team: not writable')
  })

  it('no team or project scopes: shows "nothing to check" line', () => {
    const r: EnterpriseInitResult = {
      ...freshMachine,
      writeCheck: [],
      uploadCandidates: 0,
    }
    const lines = formatSummary(r)
    expect(lines).toContain('• Write check: nothing to check (no team or project scopes)')
  })

  it('VS Code Remote-SSH: note appears in summary', () => {
    const r: EnterpriseInitResult = {
      ...freshMachine,
      vsCodeRemote: true,
    }
    const lines = formatSummary(r)
    expect(lines).toContain(
      '• VS Code Remote-SSH: PLUR is set up on this remote machine, where the tools in that window run',
    )
  })

  it('sign-in failure: shows failure message, no sign-in line', () => {
    const r: EnterpriseInitResult = {
      ok: false,
      signIn: { username: '', reused: false },
      hello: null,
      tools: [],
      writeCheck: [],
      uploadCandidates: 0,
      failure: {
        step: 'sign-in',
        message:
          'Could not check the existing key (server answered 503). Nothing was changed — run the installer again later.',
      },
    }
    const lines = formatSummary(r)
    expect(lines).toContain(
      '✗ Could not check the existing key (server answered 503). Nothing was changed — run the installer again later.',
    )
    expect(lines.some(l => l.startsWith('✓ Signed in'))).toBe(false)
  })

  it('all writable write-check: no write-check lines', () => {
    const r: EnterpriseInitResult = {
      ...freshMachine,
      writeCheck: [
        { scope: 'group:acme/team', writable: true, review_held: false },
        { scope: 'project:acme/backend', writable: true, review_held: false },
      ],
    }
    const lines = formatSummary(r)
    expect(lines.some(l => l.startsWith('!'))).toBe(false)
    expect(lines.some(l => l.includes('nothing to check'))).toBe(false)
  })

  it('a tool whose launch version check failed is not shown as plainly wired', () => {
    const r: EnterpriseInitResult = {
      ...freshMachine,
      ok: false,
      tools: [
        {
          tool: 'codex',
          status: 'wired',
          configPath: '/home/alice/.codex/config.toml',
          proven: true,
          version: { ok: false, reported: '0.21.5', detail: 'Codex launches PLUR 0.21.5, expected 0.22.0' },
        },
      ],
      uploadCandidates: 0,
    }
    const lines = formatSummary(r)
    expect(lines).toContain('• Codex  wired, but not proven: Codex launches PLUR 0.21.5, expected 0.22.0')
    expect(lines.some(l => l.includes('wired — restart'))).toBe(false)
  })

  it('a failed hello save is named, with its reason', () => {
    const r: EnterpriseInitResult = {
      ok: false,
      signIn: { username: 'alice', keyName: 'alice — ws-0142 (Windows)', reused: false },
      hello: { saved: { ok: false, reason: 'queued on this device, not delivered to the server' }, perTool: [] },
      tools: [],
      writeCheck: [],
      uploadCandidates: 0,
    }
    expect(formatSummary(r)).toContain('✗ Saves not confirmed: queued on this device, not delivered to the server')
  })

  it('a failed hello save is not named twice when the hello step failure says it', () => {
    const r: EnterpriseInitResult = {
      ok: false,
      signIn: { username: 'alice', keyName: 'alice — ws-0142 (Windows)', reused: false },
      hello: { saved: { ok: false, reason: 'did not start within 30000ms' }, perTool: [] },
      tools: [],
      writeCheck: [],
      uploadCandidates: 0,
      failure: { step: 'hello', message: 'The proof did not complete: did not start within 30000ms' },
    }
    const lines = formatSummary(r)
    expect(lines.filter(l => l.startsWith('✗'))).toEqual(['✗ The proof did not complete: did not start within 30000ms'])
  })
})

