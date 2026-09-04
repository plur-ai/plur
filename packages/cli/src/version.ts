/**
 * The CLI's own version. Kept in its own module (not index.ts's local const)
 * so mcp-config.ts can pin npx fallback entries to it without importing the
 * CLI entrypoint (#1069). Bumped by scripts/release.sh step 1;
 * test/version-parity.test.ts fails the suite if this and package.json ever
 * disagree — same guard pattern as dsh's manifest test.
 */
export const CLI_VERSION = '0.19.4'
