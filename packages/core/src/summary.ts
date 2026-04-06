const SUMMARY_MAX_LENGTH = 60
const STATEMENT_THRESHOLD = 200

export function needsSummary(statement: string, cognitiveLevel?: string): boolean {
  if (statement.length <= STATEMENT_THRESHOLD) return false
  if (cognitiveLevel && !['remember', 'understand'].includes(cognitiveLevel)) return false
  return true
}

export function generateSummary(statement: string): string {
  const sentenceEnd = statement.search(/[.!?]\s/)
  if (sentenceEnd > 0 && sentenceEnd <= SUMMARY_MAX_LENGTH) {
    return statement.slice(0, sentenceEnd + 1)
  }
  if (statement.length <= SUMMARY_MAX_LENGTH) return statement
  const truncated = statement.slice(0, SUMMARY_MAX_LENGTH)
  const lastSpace = truncated.lastIndexOf(' ')
  if (lastSpace > SUMMARY_MAX_LENGTH * 0.5) {
    return truncated.slice(0, lastSpace) + '...'
  }
  return truncated + '...'
}

export function autoSummary(statement: string, cognitiveLevel?: string): string | undefined {
  if (!needsSummary(statement, cognitiveLevel)) return undefined
  return generateSummary(statement)
}
