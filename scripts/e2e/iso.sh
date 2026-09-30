#!/bin/bash
# Run a command with the e2e isolation environment: temp HOME, PLUR_PATH, TMPDIR,
# and the temp npm prefix first on PATH. Never touches the real ~/.plur or ~/.claude.
E=/private/tmp/pe2e.LXlt
export HOME=$E/home PLUR_PATH=$E/plur TMPDIR=$E/tmp
export PATH=$E/prefix/bin:$PATH
export npm_config_cache=$E/home/.npm
unset ANTHROPIC_API_KEY PLUR_REMOTE_TEST_TOKEN CLAUDE_SESSION_ID CLAUDECODE CLAUDE_CODE_ENTRYPOINT
exec "$@"
