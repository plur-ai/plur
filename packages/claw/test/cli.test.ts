import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runLearn, runRecall, runForget } from '../src/cli.js'

function newPlurDir(): string {
  return mkdtempSync(join(tmpdir(), 'plur-cli-test-'))
}

describe('claw CLI — learn/recall/forget subcommands (item 5)', () => {
  let plurPath: string

  beforeEach(() => {
    plurPath = newPlurDir()
  })

  afterEach(() => {
    rmSync(plurPath, { recursive: true, force: true })
  })

  describe('learn', () => {
    it('stores an engram and outputs the id', async () => {
      const lines: string[] = []
      const code = await runLearn(['The sky is blue'], {
        plurPath,
        out: (s) => lines.push(s),
      })
      expect(code).toBe(0)
      const output = lines.join('')
      expect(output).toContain('Learned:')
      expect(output).toContain('The sky is blue')
    })

    it('outputs engram id that starts with ENG-', async () => {
      const lines: string[] = []
      await runLearn(['TypeScript is used for this project'], {
        plurPath,
        out: (s) => lines.push(s),
      })
      const output = lines.join('')
      expect(output).toMatch(/ENG-\d{4}/)
    })

    it('returns exit code 1 with usage message when no text provided', async () => {
      const errLines: string[] = []
      const code = await runLearn([], {
        plurPath,
        err: (s) => errLines.push(s),
      })
      expect(code).toBe(1)
      expect(errLines.join('')).toContain('Usage: claw learn')
    })

    it('joins multi-word args into a single statement', async () => {
      const lines: string[] = []
      const code = await runLearn(['use', 'PostgreSQL', 'on', 'port', '5432'], {
        plurPath,
        out: (s) => lines.push(s),
      })
      expect(code).toBe(0)
      expect(lines.join('')).toContain('PostgreSQL')
    })
  })

  describe('recall', () => {
    it('returns matching engrams after learning', async () => {
      // Seed a known engram
      await runLearn(['Database runs on PostgreSQL port 5432'], { plurPath, out: () => {} })

      const lines: string[] = []
      const code = await runRecall(['PostgreSQL'], {
        plurPath,
        out: (s) => lines.push(s),
      })
      expect(code).toBe(0)
      const output = lines.join('')
      expect(output).toContain('PostgreSQL')
    })

    it('reports no engrams when store is empty', async () => {
      const lines: string[] = []
      const code = await runRecall(['anything'], {
        plurPath,
        out: (s) => lines.push(s),
      })
      expect(code).toBe(0)
      expect(lines.join('')).toContain('No engrams found')
    })

    it('returns exit code 1 with usage message when no query provided', async () => {
      const errLines: string[] = []
      const code = await runRecall([], {
        plurPath,
        err: (s) => errLines.push(s),
      })
      expect(code).toBe(1)
      expect(errLines.join('')).toContain('Usage: claw recall')
    })

    it('outputs lines prefixed with [engram-id]', async () => {
      await runLearn(['Redis is used for caching'], { plurPath, out: () => {} })
      const lines: string[] = []
      await runRecall(['Redis'], { plurPath, out: (s) => lines.push(s) })
      const output = lines.join('')
      expect(output).toMatch(/\[ENG-/)
    })
  })

  describe('forget', () => {
    it('retires an engram by id', async () => {
      // Learn and capture the id
      let engId = ''
      await runLearn(['Temporary fact to forget'], {
        plurPath,
        out: (s) => {
          const m = s.match(/Learned: (ENG-\S+)/)
          if (m) engId = m[1]
        },
      })
      expect(engId).toBeTruthy()

      const lines: string[] = []
      const code = await runForget([engId], {
        plurPath,
        out: (s) => lines.push(s),
      })
      expect(code).toBe(0)
      expect(lines.join('')).toContain(`Forgot: ${engId}`)
    })

    it('returns exit code 1 with usage message when no id provided', async () => {
      const errLines: string[] = []
      const code = await runForget([], {
        plurPath,
        err: (s) => errLines.push(s),
      })
      expect(code).toBe(1)
      expect(errLines.join('')).toContain('Usage: claw forget')
    })
  })
})
