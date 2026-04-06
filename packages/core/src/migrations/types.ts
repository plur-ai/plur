import type { Engram } from '../schemas/engram.js'

export interface Migration {
  id: string         // timestamp-based, e.g. '20260406-001-add-commitment'
  description: string
  up(engrams: Engram[]): Engram[]
  down(engrams: Engram[]): Engram[]
}
