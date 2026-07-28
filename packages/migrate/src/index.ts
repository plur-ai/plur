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
const PREFILTER = new RegExp(String.raw`\.(?:${NEWLY_ASYNC.join('|')})\s*\(`)

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
      const { src: next, applied } = applyFixes(src, findings)
      if (applied > 0) {
        writeFileSync(f, next)
        changed++
      }
    }
  }

  if (all.length === 0) {
    process.stdout.write('plur-migrate: no un-awaited PLUR calls found.\n')
    return 0
  }

  const fixable = all.filter(f => f.fixable)
  const manual = all.filter(f => !f.fixable)

  for (const f of all) {
    const mark = f.fixable ? (write ? 'fixed  ' : 'fixable') : 'MANUAL '
    process.stdout.write(`${mark} ${f.file}:${f.line}:${f.column}  .${f.method}()\n         ${f.text}\n`)
    if (f.reason) process.stdout.write(`         ^ ${f.reason}\n`)
  }

  process.stdout.write('\n')
  if (write) {
    process.stdout.write(`plur-migrate: applied ${fixable.length} fix(es) across ${changed} file(s).\n`)
  } else {
    process.stdout.write(`plur-migrate: ${fixable.length} fixable, ${manual.length} need a human. Re-run with --write to apply the fixable ones.\n`)
  }
  if (manual.length > 0) {
    process.stdout.write(
      `\n${manual.length} site(s) are NOT rewritten on purpose. Inserting \`await\` there changes\n` +
      `program meaning rather than just adding a wait — the notes above say how.\n`,
    )
  }
  // Non-zero when anything still needs a human, so this composes in CI.
  return manual.length > 0 ? 2 : 0
}

export { scanSource, applyFixes, NEWLY_ASYNC }

const invokedDirectly = process.argv[1] && /plur-migrate|migrate[/\\]dist[/\\]index\.js$/.test(process.argv[1])
if (invokedDirectly) process.exit(run(process.argv.slice(2)))
