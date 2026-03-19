import { existsSync, readFileSync } from 'fs'
import yaml from 'js-yaml'
import { PlurConfigSchema, type PlurConfig } from './schemas/config.js'

export function loadConfig(configPath: string): PlurConfig {
  if (!existsSync(configPath)) return PlurConfigSchema.parse({})
  try {
    const raw = yaml.load(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    return PlurConfigSchema.parse(raw ?? {})
  } catch {
    return PlurConfigSchema.parse({})
  }
}
