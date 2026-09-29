import { join } from 'path'

/**
 * Environment for a spawned `plur init` / `plur doctor` whose config and
 * store locations all point into a temp HOME. The rest of the parent
 * environment (PATH, and anything a test does not name here) is inherited.
 *
 * Overriding HOME/USERPROFILE is not enough: the opencode leg resolves its
 * config directory from OPENCODE_CONFIG_DIR, then `$XDG_CONFIG_HOME/opencode`,
 * and only then `~/.config/opencode` (`opencodeConfigDir` in
 * src/opencode-config.ts). An inherited XDG_CONFIG_HOME (CI runners set one,
 * as do many desktops) sends `init` to write a real opencode.json outside the
 * temp HOME, and sends `doctor` to read a directory the test never wrote.
 * An empty OPENCODE_CONFIG_DIR is treated as unset by `opencodeConfigDir`.
 *
 * The same holds for CODEX_HOME (init writes Codex's hooks.json there) and
 * PLUR_PATH (init creates packs/ in that store, doctor reads it), so both are
 * pinned inside the temp HOME. PLUR_BACKEND, PLUR_POSTGRES_URL and
 * PLUR_TELEMETRY are blanked (an empty value is treated as unset) so a
 * developer shell that exports them does not change what the child does
 * (#1399). A test that needs one of them sets it after spreading this.
 */
export function isolatedHomeEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    OPENCODE_CONFIG_DIR: '',
    CODEX_HOME: join(home, '.codex'),
    PLUR_PATH: join(home, '.plur'),
    PLUR_BACKEND: '',
    PLUR_POSTGRES_URL: '',
    PLUR_TELEMETRY: '',
  }
}
