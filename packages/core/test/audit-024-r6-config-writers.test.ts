/**
 * 0.24 review round 6: config.yaml's stores list is written only by the two
 * guarded writers (persistStores, _updateRawStores), which apply the one
 * store-registration rule. Every other config.yaml writer is listed here by
 * name and does not assign the stores list; the one that edits it
 * (removePrimaryStoreEntries) only removes entries.
 *
 * What must break for this to fail: a new call of writeConfigFile in another
 * function, or a `.stores =` assignment in a config writer other than the two
 * guarded ones.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, relative } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import ts from 'typescript'
import { removePrimaryStoreEntries } from '../src/store-duplicates.js'
import { storeAdditions } from '../src/store-additions.js'

const SRC = join(__dirname, '..', 'src')
const GUARDED = new Set(['persistStores', '_updateRawStores'])
/** Writers of config.yaml that do not write the stores list, by file and function. */
const OTHER_WRITERS = new Set([
  'store-duplicates.ts#removePrimaryStoreEntries',
  'migrations/runner.ts#setSchemaVersion',
  'plur/provenance-identity.ts#setIdentity',
  'plur/discovery.ts#persistDismissedScopes',
])

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name)
    return e.isDirectory() ? sources(p) : p.endsWith('.ts') && !p.endsWith('.d.ts') ? [p] : []
  })
}

/** `file#function` for every call matching `callee` and every `.stores =` assignment. */
function scan(): { writers: string[]; storesAssignments: string[] } {
  const writers: string[] = []
  const storesAssignments: string[] = []
  for (const path of sources(SRC)) {
    const rel = relative(SRC, path).split('\\').join('/')
    if (rel === 'config-file.ts') continue
    const sf = ts.createSourceFile(rel, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (n: ts.Node, fn: string) => {
      let name = fn
      if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isPropertyAssignment(n)) && n.name) name = n.name.getText(sf)
      if (ts.isCallExpression(n) && /(^|\.)writeConfigFile$/.test(n.expression.getText(sf))) writers.push(`${rel}#${name}`)
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(n.left) && n.left.name.getText(sf) === 'stores'
        && !/^this\.config/.test(n.left.expression.getText(sf))) storesAssignments.push(`${rel}#${name}`)
      ts.forEachChild(n, ch => visit(ch, name))
    }
    visit(sf, '')
  }
  return { writers, storesAssignments }
}

/**
 * Direct writes of PLUR's config.yaml in another package: a write call
 * (writeConfigFile, atomicWrite, writeFileSync, appendFileSync) whose target
 * names config.yaml, `.config` of the storage paths, or a variable set from
 * one of those. Those packages go through core's methods instead.
 */
function directConfigWrites(dir: string): string[] {
  const found: string[] = []
  const names = /config\.yaml|paths\.config\b|\)\.config\b/
  for (const path of sources(dir)) {
    const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const configVars = new Set<string>()
    const collect = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name) && names.test(n.initializer.getText(sf))) configVars.add(n.name.text)
      ts.forEachChild(n, collect)
    }
    collect(sf)
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(sf)
        const target = n.arguments[0]?.getText(sf) ?? ''
        if (/(^|\.)writeConfigFile$/.test(callee)) found.push(`${relative(dir, path)}: ${callee}`)
        else if (/(^|\.)(atomicWrite|writeFileSync|appendFileSync)$/.test(callee) && (names.test(target) || configVars.has(target))) {
          found.push(`${relative(dir, path)}: ${callee}(${target})`)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return found
}

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('round 6: only the guarded writers write the stores list', () => {
  it('every config.yaml writer is a guarded writer or a known writer that leaves the stores list alone', () => {
    const { writers } = scan()
    const unknown = writers.filter(w => !GUARDED.has(w.split('#')[1]!) && !OTHER_WRITERS.has(w))
    expect(unknown).toEqual([])
    for (const w of OTHER_WRITERS) expect(writers, w).toContain(w)
  })

  it('no config.yaml writer outside the two guarded writers assigns a stores list', () => {
    const { writers, storesAssignments } = scan()
    const writing = new Set(writers)
    expect(storesAssignments.filter(a => writing.has(a) && !GUARDED.has(a.split('#')[1]!))).toEqual([])
    // The guarded writers do assign it: the scan sees them.
    expect(storesAssignments.some(a => a.endsWith('#persistStores'))).toBe(true)
    expect(storesAssignments.some(a => a.endsWith('#_updateRawStores'))).toBe(true)
  })

  it('the CLI and the MCP server never write config.yaml themselves', () => {
    for (const pkg of ['cli', 'mcp']) {
      expect(directConfigWrites(join(__dirname, '..', '..', pkg, 'src')), pkg).toEqual([])
    }
    // The scan sees a direct write.
    const probe = mkdtempSync(join(tmpdir(), 'plur-r7-writers-probe-'))
    dirs.push(probe)
    writeFileSync(join(probe, 'x.ts'), "import { writeFileSync } from 'fs'\nconst cfg = join(root, 'config.yaml')\nwriteFileSync(cfg, 'stores: []')\n")
    expect(directConfigWrites(probe)).toHaveLength(1)
  })

  it('removing the entries that name the primary store adds nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-r6-writers-'))
    dirs.push(dir)
    const primary = join(dir, 'engrams.yaml')
    writeFileSync(primary, 'engrams: []\n')
    const stores = [{ path: primary, scope: 'global' }, { url: 'https://a.example.test', token: 't', scope: 'group:x/team' }]
    const file = join(dir, 'config.yaml')
    writeFileSync(file, yaml.dump({ stores }))
    removePrimaryStoreEntries(file, primary)
    const after = (yaml.load(readFileSync(file, 'utf8')) as { stores: unknown[] }).stores
    expect(after).toHaveLength(1)
    expect(storeAdditions(stores, after)).toEqual({ newSources: [], newScopes: [], newServerEntries: [] })
  })
})
