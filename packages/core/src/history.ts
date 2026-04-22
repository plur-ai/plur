import * as fs from 'fs'
import { join } from 'path'

export interface HistoryEvent {
  event: 'engram_created' | 'engram_updated' | 'engram_merged' | 'feedback_received' | 'engram_retired' | 'engram_promoted' | 'failure_reported' | 'procedure_evolved' | 'recurrence_detected' | 'contradiction_detected' | 'scope_promoted' | 'buffer_pruned' | 'weekly_review'
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

/**
 * Read all history events for a specific engram, across all months.
 * Returns events sorted chronologically.
 */
export function readHistoryForEngram(root: string, engramId: string): HistoryEvent[] {
  const months = listHistoryMonths(root)
  const events: HistoryEvent[] = []
  for (const month of months) {
    const monthEvents = readHistory(root, month)
    for (const event of monthEvents) {
      if (event.engram_id === engramId) {
        events.push(event)
      }
    }
  }
  return events
}

/**
 * Generate a unique event ID for history entries.
 */
export function generateEventId(): string {
  const ts = Date.now()
  const rand = Math.random().toString(36).slice(2, 6)
  return `EVT-${ts}-${rand}`
}
