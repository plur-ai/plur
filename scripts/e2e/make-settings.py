"""Derive the --settings file for the real-HOME fallback from the settings `plur init`
wrote in the temp HOME. Only change: every hook command is prefixed with the temp
HOME/PLUR_PATH/TMPDIR, so no hook can reach the real ~/.plur. The hook binary and
arguments are exactly what init wrote. Also writes the --mcp-config file for the
plur MCP server init registered, with the same temp environment."""
import json
R = '/private/tmp/pe2e.LXlt'
S = '/private/tmp/claude-501/-Users-gregor-Data-5-plur-2-projects-plur/94b9039f-8597-4b45-a441-739ebf4b79cc/scratchpad/e2e'
ENV = f'HOME={R}/home PLUR_PATH={R}/plur TMPDIR={R}/tmp'
src = json.load(open(f'{R}/home/.claude/settings.json'))
out = {'hooks': {}}
for ev, entries in src['hooks'].items():
    out['hooks'][ev] = []
    for e in entries:
        e2 = dict(e)
        e2['hooks'] = [dict(h, command=f"env {ENV} {h['command']}") for h in e['hooks']]
        out['hooks'][ev].append(e2)
json.dump(out, open(f'{S}/fallback-settings.json', 'w'), indent=2)
mcp = src['mcpServers']['plur']
env = {'HOME': f'{R}/home', 'PLUR_PATH': f'{R}/plur', 'TMPDIR': f'{R}/tmp'}
json.dump({'mcpServers': {'plur': {'command': mcp['command'], 'args': mcp.get('args', []), 'env': env}}},
          open(f'{S}/fallback-mcp.json', 'w'), indent=2)
print('ok')
