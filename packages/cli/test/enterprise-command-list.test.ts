import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

it('lists init as a subcommand so documentation can verify the actual command surface', () => {
  const result = spawnSync(process.execPath, [join(__dirname, '../dist/enterprise.js'), '--help'], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^Commands:\n\s+init\s/m)
  expect(result.stdout).toContain('plur-enterprise init')
})
