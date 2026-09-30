"""Drive ONE real Claude Code process through several user turns
(--input-format stream-json), so no SessionEnd fires between turns.

usage: drive.py <folder> <outfile> [--resume <session-id>] <prompt1> [<prompt2> ...]
A prompt may be '@nonces' to snapshot the temp folder-nonces dir instead.
Claude Code runs with the real HOME only for the existing login (no API key);
it loads no user settings (--setting-sources project) and no real MCP servers
(--strict-mcp-config). The hooks and MCP entry are init's, with the temp env.
The `plur` on PATH is a wrapper that forces the temp HOME/PLUR_PATH/TMPDIR.
"""
import json, os, subprocess, sys, time

R = '/private/var/folders/t7/yl6m_hl11nvcsrkf4d426k1r0000gn/T/pe2e3.0xtj'
argv = sys.argv[1:]
folder, outfile = argv[0], argv[1]
rest = argv[2:]
resume = None
if rest[:1] == ['--resume']:
    resume, rest = rest[1], rest[2:]
prompts = rest

env = dict(os.environ)
for k in ('ANTHROPIC_API_KEY', 'CLAUDE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'PLUR_REMOTE_TEST_TOKEN'):
    env.pop(k, None)
env.update(PLUR_PATH=f'{R}/plur', TMPDIR=f'{R}/tmp', PATH=f'{R}/bin:{R}/prefix/bin:' + env['PATH'])
args = ['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--include-hook-events', '--setting-sources', 'project', '--settings', f'{R}/fallback-settings.json',
        '--strict-mcp-config', '--mcp-config', f'{R}/fallback-mcp.json',
        '--allowedTools', 'Bash(plur:*)', 'mcp__plur__*']
if resume:
    args += ['--resume', resume]
with open(outfile + '.cmd', 'w') as f:
    f.write(f'$ cd {folder} && ' + ' '.join(a.replace(R, '$R') for a in args) + '\n')
    for p in prompts:
        f.write(f'turn: {p}\n')

out = open(outfile, 'w')
proc = subprocess.Popen(args, cwd=folder, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=open(outfile + '.stderr', 'w'), text=True, bufsize=1)

def nonces():
    d = f'{R}/plur/folder-nonces'
    try:
        return sorted(os.listdir(d))
    except FileNotFoundError:
        return None

def read_until_result():
    for line in proc.stdout:
        out.write(line); out.flush()
        try:
            if json.loads(line).get('type') == 'result':
                return
        except Exception:
            pass

for p in prompts:
    if p == '@nonces':
        out.write(json.dumps({'type': 'e2e_note', 'folder_nonces': nonces(), 'at': time.time()}) + '\n'); out.flush()
        continue
    out.write(json.dumps({'type': 'e2e_turn', 'prompt': p}) + '\n'); out.flush()
    proc.stdin.write(json.dumps({'type': 'user', 'message': {'role': 'user', 'content': p}}) + '\n')
    proc.stdin.flush()
    read_until_result()

proc.stdin.close()
for line in proc.stdout:
    out.write(line)
rc = proc.wait(timeout=180)
time.sleep(2)  # let SessionEnd settle
out.write(json.dumps({'type': 'e2e_note', 'exit': rc, 'folder_nonces_after_exit': nonces()}) + '\n')
out.close()
with open(outfile + '.cmd', 'a') as f:
    f.write(f'exit={rc}\n')
