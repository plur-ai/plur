import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/**
 * plur audit — content-layer health check.
 *
 * Sibling to `plur doctor` (infra layer). Walks a runtime's working memory,
 * recalls related engrams for each entry, and flags conflicts, duplicates,
 * orphan claims, and stale snapshots.
 *
 * Usage:
 *   plur audit                          # claude-code (default)
 *   plur audit --source claude-code     # ~/.claude/projects/<...>/memory/
 *   plur audit --source claw            # stub — see packages/claw/src/audit-adapter.ts
 *   plur audit --source hermes          # stub — see packages/hermes/plur_hermes/audit_adapter.py
 *   plur audit --json
 *   plur audit --limit 5                # recall depth per entry
 */

interface MemoryEntry {
  source: string
  topic: string
  description: string
  body: string
  filepath: string
  ageDays: number
}

interface AuditFinding {
  entry: MemoryEntry
  classification: 'duplicate' | 'conflict' | 'orphan' | 'durable' | 'snapshot'
  matchedEngrams: Array<{ id: string; statement: string; strength: number }>
  reason: string
}

interface AuditReport {
  source: string
  scanned: number
  findings: AuditFinding[]
  counts: Record<string, number>
}

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---/

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const m = content.match(FRONTMATTER)
  if (!m) return { meta: {}, body: content }
  const meta: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return { meta, body: content.slice(m[0].length).trim() }
}

/** Adapter: Claude Code auto-memory. */
function loadClaudeCodeMemory(): MemoryEntry[] {
  const root = join(homedir(), '.claude', 'projects')
  const entries: MemoryEntry[] = []
  let projects: string[] = []
  try { projects = readdirSync(root) } catch { return [] }

  for (const proj of projects) {
    const memDir = join(root, proj, 'memory')
    let files: string[] = []
    try { files = readdirSync(memDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md') } catch { continue }
    for (const f of files) {
      const fp = join(memDir, f)
      const content = readFileSync(fp, 'utf8')
      const { meta, body } = parseFrontmatter(content)
      const stat = statSync(fp)
      const ageDays = (Date.now() - stat.mtimeMs) / 86400000
      entries.push({
        source: `claude-code:${proj}`,
        topic: meta.name || f.replace('.md', ''),
        description: meta.description || '',
        body: body.slice(0, 800),
        filepath: fp,
        ageDays,
      })
    }
  }
  return entries
}

/** Adapter: OpenClaw runtime (stub).
 *  Working-memory shape TBD — likely session state in ~/.openclaw/state/
 *  or context cache in claw/dist/cache/. Implement once schema stabilizes.
 */
function loadClawMemory(): MemoryEntry[] {
  return []
}

/** Adapter: Hermes runtime (stub).
 *  Hermes is Python (packages/hermes/plur_hermes/). Working memory likely
 *  in plur_hermes session store. Adapter best implemented in Python and
 *  exposed via subprocess from this CLI, OR rewrite Hermes adapter in TS.
 */
function loadHermesMemory(): MemoryEntry[] {
  return []
}

function classify(
  entry: MemoryEntry,
  recallResults: Array<{ id: string; statement: string; activation: { retrieval_strength: number } }>
): AuditFinding {
  const matched = recallResults.slice(0, 3).map(e => ({
    id: e.id,
    statement: e.statement,
    strength: e.activation.retrieval_strength,
  }))

  const top = recallResults[0]
  const topStrength = top?.activation.retrieval_strength ?? 0
  const memText = `${entry.description} ${entry.body}`

  // Snapshot detection runs first — applies regardless of engram match.
  // Volatile facts (PR status, version numbers, test counts) belong in the
  // dynamic source (git/gh/package.json), not in memory.
  if (/\b(PR #\d|v?\d+\.\d+\.\d+|\d+ tests? (?:across|passing|files)|currently (?:\d+|open|merged|closed)|status:\s*(?:open|merged|in-progress))\b/i.test(entry.body)) {
    return {
      entry,
      classification: 'snapshot',
      matchedEngrams: matched,
      reason: 'Contains volatile snapshot facts (PR/version/test count) — verify or move to dynamic source',
    }
  }

  // Conflict detection: requires (a) high similarity match, (b) shared
  // entity (proper noun, identifier, IP, path), AND (c) a negation phrase
  // in the engram targeting that shared entity. All three must hold —
  // regex on negation alone fires on every engram mentioning "not".
  if (top && topStrength > 0.7) {
    const sharedEntities = sharedEntityNames(memText, top.statement)
    if (sharedEntities.length > 0) {
      const conflict = detectEntityConflict(top.statement, sharedEntities)
      if (conflict) {
        return {
          entry,
          classification: 'conflict',
          matchedEngrams: matched,
          reason: `Engram negates shared entity "${conflict.entity}" via "${conflict.phrase}" (strength ${topStrength.toFixed(2)})`,
        }
      }
    }
  }

  // Duplicate detection: high similarity + meaningful term overlap, but no
  // entity-conflict (we already returned above if there was one).
  if (top && topStrength > 0.75) {
    const sharedTokens = sharedKeyTerms(memText, top.statement)
    if (sharedTokens >= 4) {
      return {
        entry,
        classification: 'duplicate',
        matchedEngrams: matched,
        reason: `Strong overlap with engram (strength ${topStrength.toFixed(2)}, ${sharedTokens} shared key terms, no contradiction)`,
      }
    }
  }

  // Orphan: aged with no engram coverage.
  if (entry.ageDays > 60 && matched.length === 0) {
    return {
      entry,
      classification: 'orphan',
      matchedEngrams: [],
      reason: `${entry.ageDays.toFixed(0)} days old, no engram coverage — verify still relevant`,
    }
  }

  return {
    entry,
    classification: 'durable',
    matchedEngrams: matched,
    reason: matched.length > 0
      ? `Engram coverage exists (top strength ${topStrength.toFixed(2)}, no contradiction or duplication signal)`
      : 'No engram match — likely unique to auto-memory',
  }
}

/** Extract entity-like tokens: capitalized multi-word phrases, identifiers
 *  with mixed case or underscores, IPs, dotted paths, URLs, version-prefixed
 *  IDs. These are the high-information atoms that drive conflict detection. */
function extractEntities(s: string): Set<string> {
  const out = new Set<string>()
  // Capitalized words and CamelCase/snake_case identifiers
  const re = /\b(?:[A-Z][a-zA-Z0-9]+(?:[-_/.][A-Za-z0-9]+)*|[a-z0-9]+(?:_[a-z0-9]+)+|ENG-\d{4}-\d{4}-\d+|\d+\.\d+\.\d+\.\d+|[a-z0-9-]+\.(?:org|com|local|io|ai|md|py|ts|js|json|yaml))\b/g
  let m
  while ((m = re.exec(s)) !== null) {
    const tok = m[0]
    // Drop very short, all-lowercase common words
    if (tok.length >= 4) out.add(tok)
  }
  return out
}

function sharedEntityNames(a: string, b: string): string[] {
  const ea = extractEntities(a)
  const eb = extractEntities(b)
  const shared: string[] = []
  for (const e of ea) if (eb.has(e)) shared.push(e)
  return shared
}

/** Look for negation phrases near any of the shared entities in the engram.
 *  Negation must be within ~80 chars of the entity, not anywhere in the
 *  statement — this rejects the false positive where "not" lives in an
 *  unrelated clause. */
function detectEntityConflict(engram: string, entities: string[]): { entity: string; phrase: string } | null {
  const NEG = /(no longer|not (?:running|on|the|a)|never (?:ran|was|had)|removed|decommissioned|repurposed|deprecated|stale|wrong|outdated|replaced(?: by| with)?|migrated (?:to|away)|moved (?:to|away)|retired)/i
  for (const e of entities) {
    const idx = engram.indexOf(e)
    if (idx === -1) continue
    const start = Math.max(0, idx - 80)
    const end = Math.min(engram.length, idx + e.length + 80)
    const window = engram.slice(start, end)
    const m = window.match(NEG)
    if (m) return { entity: e, phrase: m[0] }
  }
  return null
}

function sharedKeyTerms(a: string, b: string): number {
  const stopwords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'as', 'be', 'this', 'that', 'they', 'them', 'their', 'from', 'will', 'have', 'has', 'was', 'were', 'should', 'would', 'could'])
  const tokens = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter(t => t.length > 3 && !stopwords.has(t)))
  const ta = tokens(a)
  const tb = tokens(b)
  let count = 0
  for (const t of ta) if (tb.has(t)) count++
  return count
}

function printText(report: AuditReport): void {
  outputText(`plur audit — content-layer health for ${report.source}`)
  outputText('')
  outputText(`Scanned: ${report.scanned} entries`)
  for (const [k, v] of Object.entries(report.counts)) {
    outputText(`  ${k}: ${v}`)
  }
  outputText('')
  const order: AuditFinding['classification'][] = ['conflict', 'duplicate', 'snapshot', 'orphan', 'durable']
  for (const cls of order) {
    const items = report.findings.filter(f => f.classification === cls)
    if (items.length === 0) continue
    outputText(`── ${cls.toUpperCase()} (${items.length}) ──`)
    for (const f of items) {
      outputText(`• ${f.entry.topic}  (${f.entry.filepath.split('/').slice(-2).join('/')})`)
      outputText(`    ${f.reason}`)
      for (const m of f.matchedEngrams.slice(0, 2)) {
        outputText(`    ↳ [${m.id}] ${m.statement.slice(0, 120)}${m.statement.length > 120 ? '…' : ''}`)
      }
    }
    outputText('')
  }
  outputText('Next steps:')
  outputText('  CONFLICT  → resolve (which is true now?), update or retire engram, fix auto-memory')
  outputText('  DUPLICATE → delete auto-memory file (engram covers it)')
  outputText('  SNAPSHOT  → verify against live source (git/gh/package.json), retire if stale')
  outputText('  ORPHAN    → confirm still relevant, migrate durable rules to engram')
  outputText('  DURABLE   → leave alone (active project state OR unique to auto-memory)')
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  let source = 'claude-code'
  let limit = 5
  let fromJson: string | undefined
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--source' && i + 1 < args.length) { source = args[++i]; i++ }
    else if (arg === '--limit' && i + 1 < args.length) { limit = parseInt(args[++i], 10); i++ }
    else if (arg === '--from-json' && i + 1 < args.length) { fromJson = args[++i]; i++ }
    else { i++ }
  }

  let entries: MemoryEntry[]
  if (fromJson) {
    // Cross-language bridge: Python/Ruby/etc. adapters write their working
    // memory as JSON, audit consumes it. See packages/hermes/plur_hermes/audit_adapter.py.
    try {
      const raw = readFileSync(fromJson, 'utf8')
      const parsed = JSON.parse(raw)
      entries = Array.isArray(parsed) ? parsed : parsed.entries
      if (!Array.isArray(entries)) throw new Error('JSON must be an array of MemoryEntry or {"entries": [...]}')
      source = (entries[0]?.source?.split(':')[0]) ?? 'external'
    } catch (err) {
      exit(1, `--from-json: ${(err as Error).message}`); return
    }
  } else {
    switch (source) {
      case 'claude-code': entries = loadClaudeCodeMemory(); break
      case 'claw':        entries = loadClawMemory(); break
      case 'hermes':      entries = loadHermesMemory(); break
      default: exit(1, `Unknown --source: ${source}. Use claude-code | claw | hermes, or --from-json <path>.`); return
    }
  }

  if (entries.length === 0) {
    if (source !== 'claude-code' && !fromJson) {
      outputText(`Adapter for "${source}" is a stub. Either implement loadClawMemory()/loadHermesMemory() in audit.ts, or use --from-json <path> with output from that runtime's audit_adapter.`)
    } else {
      outputText('No memory entries found.')
    }
    return
  }

  const plur = createPlur(flags)
  const findings: AuditFinding[] = []
  for (const entry of entries) {
    const query = `${entry.topic} ${entry.description}`.slice(0, 200)
    const recall = await plur.recallHybrid(query, { limit })
    findings.push(classify(entry, recall as any))
  }

  const counts: Record<string, number> = {}
  for (const f of findings) counts[f.classification] = (counts[f.classification] ?? 0) + 1

  const report: AuditReport = { source, scanned: entries.length, findings, counts }

  if (shouldOutputJson(flags)) outputJson(report)
  else printText(report)
}
