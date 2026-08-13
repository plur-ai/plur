#!/usr/bin/env bash
# smoke-release.sh — verify the PACKAGED artefacts actually work.
#
# Everything else in this repo tests the source tree. That is not the thing
# users install, and the difference has already bitten once: `pg` is an
# optionalDependency, tsup only auto-externalizes dependencies+peerDependencies,
# so the driver was inlined into core's dist and `PostgresAdapter` threw on
# first use — in the published package, while every in-repo test passed.
#
# So this packs real tarballs, installs them into a clean directory outside the
# workspace (no node_modules to fall back on, no workspace: links), and runs the
# actual public API against them.
#
# Usage:
#   scripts/smoke-release.sh                 # YAML store only
#   PLUR_SMOKE_POSTGRES_URL=postgres://...   # also exercise the Postgres store
#
# Exit non-zero on any failure. Intended for pre-release and CI.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/plur-smoke-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=$((fail+1)); }

say "1. Building and packing tarballs"
( cd "$ROOT" && pnpm build >/dev/null 2>&1 ) || { bad "build"; exit 1; }
ok "workspace build"

mkdir -p "$WORK/tarballs"
# `pnpm pack`, NOT `npm pack`. pnpm rewrites the `workspace:*` protocol to the
# real version on pack/publish; npm does not, and the resulting tarball fails to
# install with EUNSUPPORTEDPROTOCOL. Since releases go out via `pnpm publish`,
# packing with pnpm is also the faithful mirror of what users receive.
for pkg in core mcp cli claw migrate; do
  ( cd "$ROOT/packages/$pkg" && pnpm pack --pack-destination "$WORK/tarballs" >/dev/null 2>&1 ) \
    && ok "packed @plur-ai/$pkg" || bad "pack $pkg"
done
# Prove the protocol really was rewritten — this is the check that would have
# caught the tarball being uninstallable.
if tar -xzOf "$WORK"/tarballs/plur-ai-mcp-*.tgz package/package.json 2>/dev/null | grep -q '"workspace:'; then
  bad "tarball still contains a workspace: dependency — it will not install"
else
  ok "workspace: protocol rewritten in the tarballs"
fi

say "2. Installing into a clean project (no workspace, no source fallback)"
mkdir -p "$WORK/app"
cd "$WORK/app"
cat > package.json <<'JSON'
{ "name": "plur-smoke", "private": true, "type": "module", "version": "1.0.0" }
JSON
# `pg` installed explicitly: it is an optionalDependency of core, and the point
# of this check is that core RESOLVES it at runtime rather than having inlined
# a copy at build time.
npm install --silent --no-audit --no-fund \
  "$WORK"/tarballs/plur-ai-core-*.tgz \
  "$WORK"/tarballs/plur-ai-mcp-*.tgz \
  "$WORK"/tarballs/plur-ai-cli-*.tgz \
  "$WORK"/tarballs/plur-ai-migrate-*.tgz \
  pg >/dev/null 2>&1 && ok "npm install from tarballs" || { bad "npm install"; exit 1; }

say "3. Packaging invariants"
# pg must NOT be inlined into core's dist — the bug this file exists for.
if grep -qE "pg-pool|pg-protocol|pg-connection-string" node_modules/@plur-ai/core/dist/index.js 2>/dev/null; then
  bad "pg is INLINED into core's dist (the published PostgresAdapter would break)"
else
  ok "pg is external, not inlined"
fi
# The public entrypoints must actually load.
node -e "import('@plur-ai/core').then(m => { if (!m.Plur) { console.error('no Plur export'); process.exit(1) } })" \
  && ok "@plur-ai/core imports and exports Plur" || bad "core import"
node -e "import('@plur-ai/core').then(m => { if (!m.PostgresAdapter) { console.error('no PostgresAdapter'); process.exit(1) } })" \
  && ok "PostgresAdapter is exported" || bad "PostgresAdapter export"

say "4. End-to-end against the default YAML store"
cat > yaml-smoke.mjs <<'JS'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plur } from '@plur-ai/core'

const dir = mkdtempSync(join(tmpdir(), 'plur-smoke-yaml-'))
const plur = new Plur({ path: dir })
await plur.ready()
const fails = []
const check = (name, cond) => { if (!cond) fails.push(name) }

const e = await plur.learn('the deploy pipeline runs migrations before the health check', { scope: 'global' })
check('learn returns an id', typeof e?.id === 'string' && e.id.length > 0)

const byId = await plur.getById(e.id)
check('getById round-trips', byId?.statement?.includes('migrations before the health check'))

const hits = await plur.recall('deploy pipeline migrations')
check('recall is an array', Array.isArray(hits))
check('recall finds the engram', hits.some(h => h.id === e.id))

const inj = await plur.inject('how do we deploy')
check('inject returns a count', typeof inj?.count === 'number')
check('inject reports tokens', typeof inj?.tokens_used === 'number')

await plur.feedback(e.id, 'positive')
check('feedback persists', (await plur.getById(e.id))?.feedback_signals?.positive === 1)

// Survives a restart — the store is really on disk, not in memory.
const plur2 = new Plur({ path: dir })
await plur2.ready()
check('persists across a new instance', (await plur2.getById(e.id))?.id === e.id)

// The authorization filter, on the packaged build.
//
// `every()` ALONE is vacuous: it returns true for an empty array, so a filter
// that wrongly returns nothing scores identical to one that works. Both
// directions have to be asserted — the permitted engram is present, and the
// unpermitted one is not.
const alpha = await plur.learn('alpha-only secret plan', { scope: 'project:alpha' })
await plur.learn('beta-only secret plan', { scope: 'project:beta' })
const scoped = await plur.recall('plan', { scopes: ['project:alpha'] })
check('allow-list returns the permitted engram', scoped.some(h => h.id === alpha.id))
check('allow-list excludes every other scope', scoped.length > 0 && scoped.every(h => h.scope === 'project:alpha'))
const none = await plur.recall('plan', { scopes: [] })
check('empty allow-list returns nothing', Array.isArray(none) && none.length === 0)
const unrestricted = await plur.recall('plan')
check('an absent allow-list is unrestricted', unrestricted.length > scoped.length)

rmSync(dir, { recursive: true, force: true })
if (fails.length) { console.error('FAILED: ' + fails.join(', ')); process.exit(1) }
console.log('yaml-ok')
JS
if node yaml-smoke.mjs 2>&1 | tail -1 | grep -q '^yaml-ok$'; then
  ok "learn / getById / recall / inject / feedback / persistence / allow-list"
else
  bad "YAML end-to-end"; node yaml-smoke.mjs 2>&1 | tail -3
fi

say "5. CLI binary"
if node node_modules/@plur-ai/cli/dist/index.js --help >/dev/null 2>&1; then
  ok "plur --help runs from the packaged CLI"
else
  bad "packaged CLI failed to run"
fi
if node node_modules/@plur-ai/cli/dist/index.js --help 2>&1 | grep -q 'hook-await'; then
  bad "CLI help still contains the codemod-corrupted 'hook-await' string"
else
  ok "CLI help text is clean"
fi

say "6. MCP server"
if node -e "import('@plur-ai/mcp/tools').then(m => { const t = m.getToolDefinitions('lean'); if (!Array.isArray(t) || t.length === 0) process.exit(1) })" 2>/dev/null; then
  ok "@plur-ai/mcp exposes tool definitions"
else
  # Not every version ships the ./tools subpath; fall back to the main entry.
  node -e "import('@plur-ai/mcp').then(() => {})" 2>/dev/null \
    && ok "@plur-ai/mcp main entry imports" || bad "MCP import"
fi

say "6b. Migration tool (the CHANGELOG tells every user to run this)"
# A breaking release that advertises `npx @plur-ai/migrate` and does not publish
# it sends everyone to a 404. Packing and running it here is the check that the
# advice is real.
cat > mig-target.mjs <<'JS'
async function ok(plur) {
  plur.learn('should gain an await')
}
function notAsync(plur) {
  plur.learn('must NOT gain one — await here does not parse')
}
export { ok, notAsync }
JS
if node node_modules/@plur-ai/migrate/dist/index.js mig-target.mjs --write >/dev/null 2>&1 || [ $? -eq 2 ]; then
  ok "plur-migrate runs from the packaged tarball"
else
  bad "packaged plur-migrate failed to run"
fi
if node --check mig-target.mjs 2>/dev/null; then
  ok "its output is valid syntax"
else
  bad "plur-migrate produced source that does not parse"
fi
if grep -q "await plur.learn('should gain an await')" mig-target.mjs \
   && ! grep -q "await plur.learn('must NOT" mig-target.mjs; then
  ok "fixed the async call, left the non-async one alone"
else
  bad "plur-migrate rewrote the wrong sites"
fi

if [ -n "${PLUR_SMOKE_POSTGRES_URL:-}" ]; then
  say "7. End-to-end against a Postgres primary store"
  cat > pg-smoke.mjs <<'JS'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plur, PostgresAdapter } from '@plur-ai/core'

const url = process.env.PLUR_SMOKE_POSTGRES_URL
const schema = 'plur_smoke_' + Math.floor(Date.now() / 1000)
const adapter = new PostgresAdapter({ connectionString: url, schema, vectorIndex: 'exact' })
const fails = []
const check = (name, cond) => { if (!cond) fails.push(name) }

try {
  await adapter.save([])
  const dir = mkdtempSync(join(tmpdir(), 'plur-smoke-pg-'))
  const plur = new Plur({ path: dir, store: adapter })
  await plur.ready()

  check('engine adopted the Postgres store', plur.primaryStore.kind === 'postgres')
  check('engine uses THIS adapter', plur.primaryStore === adapter)

  const e = await plur.learn('postgres smoke: the deploy pipeline runs migrations', { scope: 'global' })
  check('learn through Postgres', typeof e?.id === 'string')
  check('getById through Postgres', (await plur.getById(e.id))?.id === e.id)

  const hits = await plur.recall('deploy pipeline migrations')
  check('recall through Postgres finds it', hits.some(h => h.id === e.id))

  // Visible to a second engine over the same schema — the multi-process property.
  const dir2 = mkdtempSync(join(tmpdir(), 'plur-smoke-pg2-'))
  const other = new PostgresAdapter({ connectionString: url, schema, vectorIndex: 'exact' })
  const plur2 = new Plur({ path: dir2, store: other })
  await plur2.ready()
  check('a second engine sees the write', (await plur2.getById(e.id))?.id === e.id)

  // Concurrent writers must not destroy each other.
  const [a, b] = await Promise.all([
    plur.learn('written concurrently by engine one', { scope: 'global' }),
    plur2.learn('written concurrently by engine two', { scope: 'global' }),
  ])
  const ids = (await adapter.load()).map(r => r.id)
  check('concurrent write A survived', ids.includes(a.id))
  check('concurrent write B survived', ids.includes(b.id))

  // Authorization filter, pushed into SQL. Same vacuity trap as the YAML block
  // above: assert presence as well as absence.
  const alphaPg = await plur.learn('alpha tenant only', { scope: 'project:alpha' })
  await plur.learn('beta tenant only', { scope: 'project:beta' })
  const scoped = await plur.recall('tenant', { scopes: ['project:alpha'] })
  check('allow-list returns the permitted engram', scoped.some(h => h.id === alphaPg.id))
  check('allow-list enforced in Postgres', scoped.length > 0 && scoped.every(h => h.scope === 'project:alpha'))
  check('empty allow-list returns nothing', (await plur.recall('tenant', { scopes: [] })).length === 0)
  check('an absent allow-list is unrestricted', (await plur.recall('tenant')).length > scoped.length)

  await other.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir2, { recursive: true, force: true })
} finally {
  await adapter.dropSchema().catch(() => {})
  await adapter.close().catch(() => {})
}
if (fails.length) { console.error('FAILED: ' + fails.join(', ')); process.exit(1) }
console.log('pg-ok')
JS
  if PLUR_SMOKE_POSTGRES_URL="$PLUR_SMOKE_POSTGRES_URL" node pg-smoke.mjs 2>&1 | tail -1 | grep -q '^pg-ok$'; then
    ok "Postgres store: adopt / learn / recall / cross-engine visibility / concurrent writes / allow-list"
  else
    bad "Postgres end-to-end"
    PLUR_SMOKE_POSTGRES_URL="$PLUR_SMOKE_POSTGRES_URL" node pg-smoke.mjs 2>&1 | tail -3
  fi
else
  say "7. Postgres store — SKIPPED (set PLUR_SMOKE_POSTGRES_URL to include it)"
fi

say "Result"
printf '  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
