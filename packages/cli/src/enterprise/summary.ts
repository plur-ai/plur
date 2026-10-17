export type ToolId = 'claude-code' | 'codex' | 'opencode' | 'cursor'

export const TOOL_LABEL: Record<ToolId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
}

export type HelloResult = {
  saved: { ok: true; id: string } | { ok: false; reason: string }
  perTool: Array<{ tool: ToolId; recalled: boolean; reason?: string }>
}

export type VersionCheckResult =
  | { ok: true }
  | { ok: false; reported: string | null; detail: string }

export type WireResult = {
  tool: ToolId
  status: 'wired' | 'refused' | 'other-side' | 'failed'
  configPath: string
  detail?: string
}

export type WiredTool = WireResult & {
  version?: VersionCheckResult
  proven: boolean
}

export type WriteCheckResult = {
  scope: string
  writable: boolean
  review_held: boolean
  reason?: string
}

export type EnterpriseInitResult = {
  ok: boolean
  signIn: { username: string; keyName?: string; reused: boolean }
  hello: HelloResult | null
  tools: WiredTool[]
  writeCheck: WriteCheckResult[]
  uploadCandidates: number
  flushed?: { flushed: number; failed: number }
  failure?: {
    step: 'ca' | 'sign-in' | 'store' | 'wire' | 'version' | 'hello'
    message: string
  }
  backupDir?: string
  vsCodeRemote?: boolean
}

const NOT_SYNCED_REASON = 'not_synced'

function labelColumnWidth(r: EnterpriseInitResult): number {
  const widths = r.tools.map(t => TOOL_LABEL[t.tool].length)
  if (r.uploadCandidates > 0) widths.push('Upload:'.length)
  return widths.length > 0 ? Math.max(...widths) + 2 : 0
}

export function formatSummary(r: EnterpriseInitResult): string[] {
  const lines: string[] = []

  // Early failures that prevent sign-in
  if (r.failure && (r.failure.step === 'ca' || r.failure.step === 'sign-in')) {
    lines.push(`✗ ${r.failure.message}`)
    return lines
  }

  // Sign-in line
  if (r.signIn.reused) {
    lines.push(`✓ Signed in as ${r.signIn.username} · existing key reused`)
  } else {
    lines.push(`✓ Signed in as ${r.signIn.username} · key "${r.signIn.keyName ?? ''}"`)
  }

  // Failures after sign-in but before hello
  if (r.failure && (r.failure.step === 'store' || r.failure.step === 'wire' || r.failure.step === 'version')) {
    lines.push(`✗ ${r.failure.message}`)
    return lines
  }

  // Hello/saves status line
  if (r.hello) {
    if (r.hello.saved.ok) {
      lines.push('✓ Server reachable, saves confirmed')
    } else if (r.hello.saved.reason === NOT_SYNCED_REASON) {
      lines.push(
        '✗ Your account is not set up on the server yet (not synced). Ask your PLUR admin, or try again in 15 minutes.',
      )
    } else if (r.failure?.step !== 'hello') {
      // Any other failed save is named, unless the hello step failure below says it.
      lines.push(`✗ Saves not confirmed: ${r.hello.saved.reason}`)
    }
  }

  if (r.failure && r.failure.step === 'hello') {
    lines.push(`✗ ${r.failure.message}`)
  }

  // VS Code Remote-SSH note
  if (r.vsCodeRemote) {
    lines.push(
      '• VS Code Remote-SSH: PLUR is set up on this remote machine, where the tools in that window run',
    )
  }

  // Tool lines with aligned label column
  const width = labelColumnWidth(r)
  for (const tool of r.tools) {
    const label = TOOL_LABEL[tool.tool]
    const padded = label.padEnd(width)
    let msg: string
    // "wired — restart" is a claim that the proof passed for this tool, so it
    // needs the evidence in this result, not only the `proven` flag: the save
    // confirmed, and this tool's own recall returned it.
    const perTool = r.hello?.perTool.find(p => p.tool === tool.tool)
    const evidenced = tool.proven && r.hello?.saved.ok === true && perTool?.recalled === true
    if (tool.status === 'wired' && tool.version && !tool.version.ok) {
      // The tool launches the wrong PLUR (or npx): not proven, whatever the recall said.
      msg = `wired, but not proven: ${tool.version.detail}`
    } else if (tool.status === 'wired' && evidenced) {
      const extra = tool.tool === 'codex' ? ', then run /hooks and trust PLUR' : ''
      msg = `wired — restart ${label}${extra}`
    } else if (tool.status === 'wired') {
      // A failed save is named on its own line above; here it is only the cause.
      const why = perTool?.reason ?? (r.hello && !r.hello.saved.ok ? 'the connection check did not save' : 'could not be verified')
      msg = `wired, but not proven: ${why}`
    } else if (tool.status === 'other-side') {
      msg = 'runs in WSL — run the installer inside WSL'
    } else if (tool.status === 'refused') {
      msg = `could not be wired${tool.detail ? ` — ${tool.detail}` : ''}`
    } else {
      msg = `failed to wire${tool.detail ? ` — ${tool.detail}` : ''}`
    }
    lines.push(`• ${padded}${msg}`)
  }

  // Upload line
  if (r.uploadCandidates > 0) {
    const padded = 'Upload:'.padEnd(width)
    lines.push(
      `• ${padded}${r.uploadCandidates} memories exist only on this laptop → run \`plur upload\` to review`,
    )
  }

  // Write-check lines
  if (r.writeCheck.length === 0) {
    lines.push('• Write check: nothing to check (no team or project scopes)')
  } else {
    for (const wc of r.writeCheck) {
      if (!wc.writable) {
        lines.push(`! ${wc.scope}: not writable${wc.reason ? ` (${wc.reason})` : ''}`)
      }
    }
  }

  return lines
}
