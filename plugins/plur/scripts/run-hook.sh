#!/bin/sh
# Runs one PLUR hook at the version this plugin release pins.
# Does nothing when the automatic_memory setting is off, or when `plur init`
# has already installed PLUR's own hooks, so memory is never injected twice.

[ "${CLAUDE_PLUGIN_OPTION_AUTOMATIC_MEMORY:-true}" = "false" ] && exit 0
[ -f "$HOME/.plur/bin/plur-hook.meta.json" ] && exit 0

# Keeps each project's notes to that project, matching the server's setting.
export PLUR_FOLDER_SCOPE=project

exec npx -y @plur-ai/cli@0.23.0 "$@"
