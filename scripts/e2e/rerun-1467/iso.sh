#!/bin/bash
# Run a command with the e2e isolation environment: temp HOME, PLUR_PATH, TMPDIR,
# and the temp npm prefix first on PATH. Never touches the real ~/.plur or ~/.claude.
E=/private/var/folders/t7/yl6m_hl11nvcsrkf4d426k1r0000gn/T/pe2e3.0xtj
export HOME=$E/home PLUR_PATH=$E/plur TMPDIR=$E/tmp USERPROFILE=$E/home
export PATH=$E/prefix/bin:$PATH
export npm_config_cache=$E/home/.npm
unset ANTHROPIC_API_KEY PLUR_REMOTE_TEST_TOKEN CLAUDE_SESSION_ID CLAUDECODE CLAUDE_CODE_ENTRYPOINT
exec "$@"
