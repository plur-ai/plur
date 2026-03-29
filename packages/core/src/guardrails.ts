/**
 * Generate CLAUDE.md guardrails markdown for PLUR install.
 * Appended to project CLAUDE.md (or equivalent instruction file) during setup.
 */
export function generateGuardrails(): string {
  return `## PLUR Memory Guardrails

### Verification Protocol
When recalling facts that will drive actions (server IPs, file paths, API endpoints, credential locations):
1. State the recalled fact explicitly before acting on it
2. Include the engram ID or search that produced it
3. If no engram matches, say "No engram found — verifying from filesystem" and check directly
4. Never interpolate between two engrams to produce a "probably correct" composite

When the user corrects a recalled fact: call plur.learn immediately, then plur.feedback with negative signal on the wrong engram, before continuing the task.

### Over-engineering Check
Before proposing any new system, module, or architectural change:
1. What is the simplest version that solves the actual problem?
2. Is there an existing tool/pattern that already covers 80% of this?
3. Will this create maintenance burden disproportionate to its value?

If a task can be done in <20 lines of shell script, do that first.

### Tool Selection Discipline
Before invoking any external tool, apply the locality test:
1. Is the answer already in engrams? → plur.recall
2. Is the answer in the local filesystem? → Read/Grep/Glob
3. Is the answer derivable from context already loaded? → Just answer
4. Only if 1-3 fail → Use external tools

Meta-engrams flagged as "[structural transfer — untested in current domain]" are hypotheses, not rules. Test before applying.`
}
