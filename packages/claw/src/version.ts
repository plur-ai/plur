/**
 * The claw plugin's own version — the single place it is written down.
 *
 * `index.ts` (plugin object) and `context-engine.ts` (engine info) both read
 * it, and the heartbeat payload reports it, so a release bump edits one
 * constant. `test/version-parity.test.ts` fails the suite if this and
 * package.json ever disagree. Bumped by `scripts/release.sh --claw`.
 */
export const CLAW_VERSION = '0.17.1'
