import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface PlurPaths {
  root: string
  engrams: string
  episodes: string
  candidates: string
  packs: string
  exchange: string
  config: string
}

export function detectPlurStorage(explicitPath?: string): PlurPaths {
  const root = explicitPath
    || process.env.PLUR_PATH
    || join(homedir(), '.plur')

  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  const packsDir = join(root, 'packs')
  if (!existsSync(packsDir)) mkdirSync(packsDir, { recursive: true })

  return {
    root,
    engrams: join(root, 'engrams.yaml'),
    episodes: join(root, 'episodes.yaml'),
    candidates: join(root, 'candidates.yaml'),
    packs: packsDir,
    exchange: join(root, 'exchange'),
    config: join(root, 'config.yaml'),
  }
}
