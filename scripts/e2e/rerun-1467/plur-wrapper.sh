#!/bin/sh
# The `plur` the model runs through Bash. Claude Code itself runs with the real
# HOME (for the existing login), so this wrapper forces the temp HOME, PLUR_PATH
# and TMPDIR before the installed CLI starts. Nothing reaches the real ~/.plur.
E=/private/var/folders/t7/yl6m_hl11nvcsrkf4d426k1r0000gn/T/pe2e3.0xtj
export HOME=$E/home USERPROFILE=$E/home PLUR_PATH=$E/plur TMPDIR=$E/tmp
exec $E/prefix/bin/plur "$@"
