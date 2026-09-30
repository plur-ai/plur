"""Derive the --settings file for the real-HOME fallback from the settings `plur init`
wrote in the temp HOME. Only change: every hook command is prefixed with the temp
HOME/PLUR_PATH/TMPDIR, so no hook can reach the real ~/.plur. Matchers, hook binary
and arguments are exactly what init wrote. Also writes the --mcp-config file for the
plur MCP server init registered, with the same temp environment."""
import json
R = '/private/var/folders/t7/yl6m_hl11nvcsrkf4d426k1r0000gn/T/pe2e3.0xtj'
ENV = f'HOME={R}/home USERPROFILE={R}/home PLUR_PATH={R}/plur TMPDIR={R}/tmp'
src = json.load(open(f'{R}/home/.claude/settings.json'))
out = {'hooks': {}}
for ev, entries in src['hooks'].items():
    out['hooks'][ev] = [dict(e, hooks=[dict(h, command=f"env {ENV} {h['command']}") for h in e['hooks']]) for e in entries]
json.dump(out, open(f'{R}/fallback-settings.json', 'w'), indent=2)
mcp = src['mcpServers']['plur']
env = {'HOME': f'{R}/home', 'USERPROFILE': f'{R}/home', 'PLUR_PATH': f'{R}/plur', 'TMPDIR': f'{R}/tmp'}
json.dump({'mcpServers': {'plur': {'command': mcp['command'], 'args': mcp.get('args', []), 'env': env}}},
          open(f'{R}/fallback-mcp.json', 'w'), indent=2)
print('ok', sorted(out['hooks']))
