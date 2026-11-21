/**
 * `plur init-remote` — hidden alias of `plur remote`. The same flags work, and
 * `--verify` is bare `plur remote`. It registers the store in the user's
 * config.yaml and maps the folder in folders.yaml; nothing is written to the
 * folder itself.
 */
export { run } from './remote.js'
