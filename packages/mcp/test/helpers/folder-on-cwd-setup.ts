/**
 * Every suite runs with a cwd that is a PLUR project folder.
 *
 * The MCP server resolves the folder map for the editor's workspace, which
 * includes its cwd, and since #1525 an undecided folder gets the folder
 * question instead of memory. Most suites exercise the memory tools
 * themselves, so without this their result would depend on whether some
 * folder above the checkout happens to hold a project marker (a developer's
 * machine often has one; CI has none). An empty `.plur.yaml` marks the folder
 * `on` and requests nothing, so it changes no scope or domain. Suites that
 * test the folder map itself mock process.cwd() or pass MCP roots.
 */
import { mkdtempSync, realpathSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const project = realpathSync(mkdtempSync(join(tmpdir(), 'plur-mcp-test-cwd-')))
writeFileSync(join(project, '.plur.yaml'), '# PLUR project folder for the mcp test suites\n')
process.chdir(project)
