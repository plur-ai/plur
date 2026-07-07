#!/usr/bin/env node
// Guard: reject a valueless benchmark `--rerank` flag in docs & scripts
// (#341 follow-up). "Valueless" = the flag with no `on`/`off` after it.
//
// Why: the benchmark harness treats a missing/RRF-only reranker very differently
// from an active cross-encoder. `run.ts --rerank on` is the cadence standard;
// `--rerank off` is the explicit comparison. A BARE `--rerank` (no `on`/`off`)
// reads as "reranker on" to a human copying the command, but historically parsed
// as reranker-OFF — producing RRF-only numbers mislabeled as "reranker-on"
// cadence results. Commit 6de5fa5 fixed one such doc drift; this guard stops the
// class from recurring.
//
// Pattern (per the tracking task): `run.ts --rerank(?! on| off)`. We anchor on
// the literal invocation `run.ts ... --rerank` so we do NOT false-positive on:
//   - the parser source in benchmark/run.ts (`a === '--rerank'`)
//   - legit prose like "re-run without --rerank to get RRF-only numbers"
//
// Portable Node check (no `grep -P` — macOS grep lacks it; mirrors the
// KNOWN_ISSUES sentinel in ci.yml / release.sh).
//
// Usage:
//   node scripts/check-rerank-flag.mjs           # scan tracked docs & scripts
//   node scripts/check-rerank-flag.mjs FILE...    # scan explicit files (git hook)

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

// A line is a violation when it invokes run.ts and carries a `--rerank` token
// that is NOT immediately followed by ` on` or ` off`. Intermediate tokens
// between `run.ts` and the bad `--rerank` must be flag-shaped (`--flag [val]`),
// so this matches `run.ts --category x --rerank` but NOT a legit
// `run.ts --rerank on` that merely shares a line with prose like
// "...or re-run without --rerank" (the flag-shape gate can't cross plain words,
// and it can't skip a valid `--rerank on` to reach a later bare one).
const VIOLATION = /run\.ts(?: +--[\w-]+(?:[= ]\S+)?)*? +--rerank(?! on| off)\b/

// Only docs & scripts carry copy-pasteable invocations. Source (.ts) legitimately
// contains the string '--rerank' in the arg parser, so it is out of scope.
const SCANNABLE = /\.(md|sh|ya?ml)$|(^|\/)CLAUDE\.md$/

function targetFiles(argv) {
  if (argv.length) return argv
  const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean)
  return tracked.filter((f) => SCANNABLE.test(f))
}

const files = targetFiles(process.argv.slice(2))
const hits = []

for (const file of files) {
  if (!SCANNABLE.test(file)) continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue // deleted/renamed staged path — nothing to scan
  }
  text.split('\n').forEach((line, i) => {
    if (VIOLATION.test(line)) hits.push({ file, line: i + 1, text: line.trim() })
  })
}

if (hits.length) {
  console.error('\n✗ Bare `run.ts --rerank` found — it parses as reranker-OFF and')
  console.error('  mislabels RRF-only numbers as "reranker-on" cadence results (#341).')
  console.error('  Write `--rerank on` (cadence baseline) or `--rerank off` (comparison).\n')
  for (const h of hits) console.error(`  ${h.file}:${h.line}: ${h.text}`)
  console.error('')
  process.exit(1)
}

console.log(`✓ rerank-flag guard: no bare \`run.ts --rerank\` in ${files.length} docs/scripts.`)
