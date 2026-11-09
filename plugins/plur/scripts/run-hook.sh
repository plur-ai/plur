#!/bin/sh
# Runs one PLUR hook at the version this plugin release pins.
# Does nothing when the automatic_memory setting is off, or when the settings
# Claude Code reads here already run PLUR's own hooks (`plur init` puts them
# there), so memory is never injected twice.

[ "${CLAUDE_PLUGIN_OPTION_AUTOMATIC_MEMORY:-true}" = "false" ] && exit 0

config="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
project="${CLAUDE_PROJECT_DIR:-$PWD}/.claude"
grep -qs hook-inject "$config/settings.json" "$project/settings.json" "$project/settings.local.json" && exit 0

# Keeps each project's notes to that project, matching the server's setting.
export PLUR_FOLDER_SCOPE=project

exec npx -y @plur-ai/cli@0.23.0 "$@"
