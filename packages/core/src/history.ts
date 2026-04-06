import * as fs from 'fs'
import { join } from 'path'

export interface HistoryEvent {
  event: 'engram_created' | 'engram_updated' | 'engram_merged' | 'feedback_received' | 'engram_retired' | 'engram_promoted'
  engram_id: string
  timestamp: string // ISO
  data: Record<string, unknown> // event-specific payload
}

/**
 * Append a history event to the JSONL file for the current month.
 * Files are stored in {root}/history/YYYY-MM.jsonl.
 * Auto-creates the history directory and file on first write.
 */
export function appendHistory(root: string, event: HistoryEvent): void {
  const historyDir = join(root, 'history')
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true })
  }

  const date = event.timestamp.slice(0, 7) // YYYY-MM
  const filePath = join(historyDir, `${date}.jsonl`)
  const line = JSON.stringify(event) + '\n'
  fs.appendFileSync(filePath, line, 'utf8')
}

/**
 * Read history events from a specific month's JSONL file.
 * Returns empty array if file doesn't exist.
 */
export function readHistory(root: string, yearMonth: string): HistoryEvent[] {
  const filePath = join(root, 'history', `${yearMonth}.jsonl`)
  if (!fs.existsSync(filePath)) return []

  const content = fs.readFileSync(filePath, 'utf8')
  const lines = content.split('\n').filter(l => l.trim().length > 0)
  const events: HistoryEvent[] = []
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as HistoryEvent)
    } catch {
      // Skip malformed lines
    }
  }
  return events
}

/**
 * List all available history months (YYYY-MM format).
 */
export function listHistoryMonths(root: string): string[] {
  const historyDir = join(root, 'history')
  if (!fs.existsSync(historyDir)) return []
  return fs.readdirSync(historyDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => f.replace('.jsonl', ''))
    .sort()
}
