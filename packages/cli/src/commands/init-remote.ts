/**
 * `plur init-remote` — hidden alias of `plur remote` (#1413, folder-map
 * design r3). The same flags work, and `--verify` is bare `plur remote`.
 *
 * It used to write the URL and token into the repo's `.plur.yaml` (relying on
 * .gitignore to keep the token out of git) and grant trust for the folder. It
 * now registers the store in the user's config.yaml and maps the folder in
 * folders.yaml, like `plur remote`; nothing is written to the folder.
 */
export { run } from './remote.js'
