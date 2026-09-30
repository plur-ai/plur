#!/bin/bash
# Steps of the 2026-09-30 re-run (#1467 + #1418 resume). Every plur command
# runs through iso.sh (temp HOME, PLUR_PATH, TMPDIR).
set -u
R=/private/var/folders/t7/yl6m_hl11nvcsrkf4d426k1r0000gn/T/pe2e3.0xtj
EV=$R/ev
ISO=$R/iso.sh
INIT_FLAGS="--no-desktop --no-prompt"

case "$1" in
  install)
    cd $R && $ISO npm install -g --prefix $R/prefix $R/pack/plur-ai-core-0.20.1.tgz $R/pack/plur-ai-mcp-0.20.1.tgz $R/pack/plur-ai-cli-0.20.1.tgz > $EV/npm-install.log 2>&1; echo "rc=$?"
    ls $R/prefix/bin; shasum -a 256 $R/pack/*.tgz | cut -c1-12 ;;
  seed-repo)
    python3 - <<'PY'
import json
R = '/private/var/folders/t7/yl6m_hl11nvcsrkf4d426k1r0000gn/T/pe2e3.0xtj'
p = f'{R}/work/repo/.claude/settings.json'
s = json.load(open(p))
s['permissions'] = {'allow': ['Bash(ls:*)']}
s['hooks'].setdefault('Stop', []).insert(0, {'matcher': '*', 'hooks': [{'type': 'command', 'command': 'echo user-own-stop-hook'}]})
json.dump(s, open(p, 'w'), indent=2)
PY
    cp $R/work/repo/.claude/settings.json $EV/repo-settings-before-migration.json ;;
  show)
    cat $R/plur/folders.yaml
    python3 - <<'PY'
import json
R = '/private/var/folders/t7/yl6m_hl11nvcsrkf4d426k1r0000gn/T/pe2e3.0xtj'
for p in ['work/repo/.claude/settings.json', 'home/.claude/settings.json']:
    s = json.load(open(f'{R}/{p}'))
    print(p, 'keys', list(s), 'mcp plur:', 'plur' in s.get('mcpServers', {}))
    for ev, es in s.get('hooks', {}).items():
        print('  ', ev, [(e.get('matcher', ''), [h['command'].split('/')[-1] for h in e['hooks']]) for e in es])
PY
    ;;
  snap)
    cp $R/home/.claude/settings.json $EV/user-settings-$2.json
    cp $R/work/repo/.claude/settings.json $EV/repo-settings-$2.json
    cp $R/plur/folders.yaml $EV/folders-$2.yaml ;;
  repo-marker)
    mkdir -p $R/work/repo/.git ;;
  init-project)
    cd $R/work/repo && $ISO plur init --project $INIT_FLAGS > $EV/01-init-project.txt 2>&1; echo "rc=$?" ;;
  init-default)
    cd $R/work/repo && $ISO plur init $INIT_FLAGS > $EV/02-init-default.txt 2>&1; echo "rc=$?" ;;
  init-again)
    cd $R/work/repo && $ISO plur init $INIT_FLAGS > $EV/03-init-again.txt 2>&1; echo "rc=$?" ;;
  plur)
    shift; $ISO plur "$@" ;;
  *) echo "unknown step $1"; exit 2 ;;
esac
