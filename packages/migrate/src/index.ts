/**
 * plur-migrate — find PLUR calls left un-awaited by the 0.16 async migration.
 *
 * Reports by default. `--write` applies only the rewrites that are
 * unambiguous; everything structural is listed for a human, because the
 * codemods that did this migration inside PLUR itself were wrong in ways no
 * test caught before they were right. See `scan.ts` for the specific hazards.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { scanSource, applyFixes, NEWLY_ASYNC, type Finding } from './scan.js'

const HELP = `plur-migrate — find PLUR calls left un-awaited by the 0.16 async migration

USAGE
  npx @plur-ai/migrate [path]           report un-awaited calls (default: .)
  npx @plur-ai/migrate [path] --write   also apply the unambiguous fixes

EXIT CODES
  0  clean, or every finding fixed by --write
  2  un-awaited calls remain: sites that need a human, or (without --write)
     fixable sites not yet written

WHY
  As of 0.16 the PLUR engine's read and write methods return promises, so a
  store can live across a network. A call left un-awaited does not throw — it
  yields a Promise, and most property reads on a Promise succeed:

      plur.recall(q).length        -> undefined, not an error
      {...plur.status()}           -> {}

  TypeScript catches all of it. JavaScript does not, which is what this is for.

OPTIONS
  --write        apply fixes (default: report only)
  --ext .ts,.js  file extensions to scan (default: .ts,.tsx,.js,.mjs,.cjs)
  --help         this
`

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.next'])

/**
 * Does this file mention ANY of the methods we care about? Purely an
 * optimisation — the scanner is authoritative. Built from `NEWLY_ASYNC` so it
 * cannot fall behind it.
 */
// `\s*` after the dot mirrors the scanner: `plur.\n  recall(q)` is a chain
// the scanner resolves, so the pre-filter must not skip the file it sits in.
const PREFILTER = new RegExp(String.raw`\.\s*(?:${NEWLY_ASYNC.join('|')})\s*\(`)

function walk(dir: string, exts: Set<string>, out: string[] = []): string[] {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(p, exts, out)
    } else if (exts.has(extname(e.name))) {
      out.push(p)
    }
  }
  return out
}

export function run(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP)
    return 0
  }
  const write = argv.includes('--write')
  const extIdx = argv.indexOf('--ext')
  const exts = new Set(
    extIdx >= 0 && argv[extIdx + 1]
      ? argv[extIdx + 1].split(',').map(s => (s.startsWith('.') ? s : `.${s}`))
      : ['.ts', '.tsx', '.js', '.mjs', '.cjs'],
  )
  const root = argv.find((a, i) => !a.startsWith('-') && argv[i - 1] !== '--ext') ?? '.'

  let files: string[]
  try {
    files = statSync(root).isDirectory() ? walk(root, exts) : [root]
  } catch {
    process.stderr.write(`plur-migrate: cannot read ${root}\n`)
    return 1
  }

  const all: Finding[] = []
  let changed = 0
  // Counted from what applyFixes actually did (formal R2, mcp#8): the summary
  // used to report every fixable site as fixed, including ones it skipped.
  let appliedTotal = 0
  const notApplied = new Set<Finding>()
  for (const f of files) {
    let src: string
    try { src = readFileSync(f, 'utf8') } catch { continue }
    // Cheap pre-filter, DERIVED from the method table rather than hand-written.
    //
    // It used to list ten names while `NEWLY_ASYNC` held twenty-eight, so a file
    // whose only calls were `setPinned`, `receipt` or `installPack` was skipped
    // outright — and the run then printed "no un-awaited PLUR calls found" and
    // exited 0. Telling someone their migration is clean when it is not is the
    // worst thing this tool can do; it is the one output they will act on
    // without checking.
    if (!PREFILTER.test(src)) continue

    const findings = scanSource(relative(process.cwd(), f) || f, src)
    if (findings.length === 0) continue
    all.push(...findings)

    if (write) {
      const { src: next, applied, skipped } = applyFixes(src, findings)
      for (const s of skipped) notApplied.add(s)
      if (applied > 0) {
        writeFileSync(f, next)
        changed++
        appliedTotal += applied
      }
    }
  }

  if (all.length === 0) {
    process.stdout.write('plur-migrate: no un-awaited PLUR calls found.\n')
    return 0
  }

  // A fixable site the rewrite could not apply is a site for a human.
  const isManual = (f: Finding) => !f.fixable || notApplied.has(f)
  const fixable = all.filter(f => !isManual(f))
  const manual = all.filter(isManual)

  for (const f of all) {
    const mark = isManual(f) ? 'MANUAL ' : (write ? 'fixed  ' : 'fixable')
    const reason = notApplied.has(f) ? 'the rewrite could not be applied safely here — add `await` by hand' : f.reason
    process.stdout.write(`${mark} ${f.file}:${f.line}:${f.column}  .${f.method}()\n         ${f.text}\n`)
    if (reason) process.stdout.write(`         ^ ${reason}\n`)
  }

  process.stdout.write('\n')
  if (write) {
    process.stdout.write(`plur-migrate: applied ${appliedTotal} fix(es) across ${changed} file(s).\n`)
  } else {
    process.stdout.write(`plur-migrate: ${fixable.length} fixable, ${manual.length} need a human. Re-run with --write to apply the fixable ones.\n`)
  }
  if (manual.length > 0) {
    process.stdout.write(
      `\n${manual.length} site(s) are NOT rewritten on purpose. Inserting \`await\` there changes\n` +
      `program meaning rather than just adding a wait — the notes above say how.\n`,
    )
  }
  // Non-zero whenever un-awaited calls remain, so this composes in CI: sites
  // that need a human, and — in report-only mode — fixable sites not yet
  // written (formal R2, mcp#8: report-only used to exit 0 with work
  // outstanding, which a CI gate reads as "migration done").
  return manual.length > 0 || (!write && fixable.length > 0) ? 2 : 0
}

export { scanSource, applyFixes, NEWLY_ASYNC }

const invokedDirectly = process.argv[1] && /plur-migrate|migrate[/\\]dist[/\\]index\.js$/.test(process.argv[1])
if (invokedDirectly) process.exit(run(process.argv.slice(2)))
