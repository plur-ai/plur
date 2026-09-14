#!/usr/bin/env node
/**
 * Copy the repo-root `skills/` tree into `dist/skills/` after tsup runs.
 *
 * Why a build step and not a `files` entry: `files[]` in package.json is
 * PACKAGE-relative, and `skills/` lives at the repo root. Adding "skills" to
 * packages/cli/package.json ships nothing at all — npm resolves it against
 * packages/cli/, where no such directory exists. `files: ["dist"]` already
 * covers everything under dist/, so copying here needs no manifest change.
 *
 * Why after tsup: the first tsup config sets `clean: true`, which wipes dist/
 * before emitting. A copy that runs first is deleted before it ships.
 *
 * Without this, `skills/plur-create-engrams/` was version-stamped by
 * release.sh on every release and delivered to nobody (#1190).
 */
import { cp, mkdir, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const repoRoot = join(pkgRoot, '..', '..')
const src = join(repoRoot, 'skills')
const dest = join(pkgRoot, 'dist', 'skills')

if (!existsSync(src)) {
  console.error(`copy-skills: no skills/ at ${src} — nothing to ship.`)
  process.exit(1)
}

await mkdir(dest, { recursive: true })
await cp(src, dest, { recursive: true, dereference: true })

// Report what shipped, so a silently-empty copy is visible in the build log
// rather than discovered by a user who does not get the skill.
const names = []
for (const entry of await readdir(dest)) {
  const info = await stat(join(dest, entry))
  if (info.isDirectory() && existsSync(join(dest, entry, 'SKILL.md'))) names.push(entry)
}
if (names.length === 0) {
  console.error('copy-skills: copied nothing that looks like a skill (no */SKILL.md).')
  process.exit(1)
}
console.log(`copy-skills: ${names.length} skill(s) -> dist/skills: ${names.join(', ')}`)
