import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

export function computePackChecksum(packDir: string): string | null {
  const files = ['SKILL.md', 'engrams.yaml']
  const hash = crypto.createHash('sha256')
  let hasContent = false
  for (const file of files) {
    const filePath = path.join(packDir, file)
    if (fs.existsSync(filePath)) {
      hash.update(fs.readFileSync(filePath))
      hasContent = true
    }
  }
  return hasContent ? hash.digest('hex') : null
}

export function verifyPackChecksum(packDir: string, expected: string): { valid: boolean; actual: string | null } {
  const actual = computePackChecksum(packDir)
  return { valid: actual === expected, actual }
}
