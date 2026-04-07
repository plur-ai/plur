import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { discover } from '../src/discover.js'

describe('knowledge discovery', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'discover-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  it('discovers PLUR engrams and suggests packs', async () => {
    const plurPath = join(dir, 'engrams.yaml')
    const engramYaml = ['engrams:']
    for (let i = 0; i < 10; i++) {
      engramYaml.push(`  - id: ENG-${i}`)
      engramYaml.push(`    statement: "Trading pattern ${i}: Wyckoff accumulation"`)
      engramYaml.push(`    domain: trading`)
      engramYaml.push(`    tags: [trading, wyckoff]`)
    }
    writeFileSync(plurPath, engramYaml.join('\n'))

    const suggestions = await discover({
      sources: [{ type: 'plur', path: plurPath }],
    })

    expect(suggestions.length).toBeGreaterThan(0)
    expect(suggestions[0].domain).toBe('trading')
    expect(suggestions[0].type).toBe('engram-pack')
    expect(suggestions[0].items).toBe(10)
  })

  it('discovers markdown directories and suggests zettel collections', async () => {
    const notesDir = join(dir, 'notes', 'health')
    mkdirSync(notesDir, { recursive: true })
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(notesDir, `note-${i}.md`), `# Longevity Protocol ${i}\n\nResearch on #health and #longevity interventions.`)
    }

    const suggestions = await discover({
      sources: [{ type: 'directory', path: join(dir, 'notes') }],
    })

    expect(suggestions.length).toBeGreaterThan(0)
    const healthSuggestion = suggestions.find(s => s.domain.includes('health'))
    expect(healthSuggestion).toBeDefined()
    expect(healthSuggestion!.type).toBe('zettel-collection')
  })

  it('skips clusters with fewer than 3 items', async () => {
    const notesDir = join(dir, 'tiny')
    mkdirSync(notesDir, { recursive: true })
    writeFileSync(join(notesDir, 'one.md'), 'Single note')

    const suggestions = await discover({
      sources: [{ type: 'directory', path: notesDir }],
    })
    expect(suggestions).toHaveLength(0)
  })

  it('handles missing paths gracefully', async () => {
    const suggestions = await discover({
      sources: [
        { type: 'plur', path: '/nonexistent/engrams.yaml' },
        { type: 'directory', path: '/nonexistent/dir' },
      ],
    })
    expect(suggestions).toHaveLength(0)
  })
})
