"""Drive ONE real Claude Code process through several user turns
(--input-format stream-json), so no SessionEnd fires between turns, the way an
interactive session behaves. Same isolation as step-claude-fb.sh.

usage: drive.py <folder> <outfile> <prompt1> [<prompt2> ...]
A prompt may be '@nonces' to snapshot the temp folder-nonces dir instead.
"""
import json, os, subprocess, sys, time

S = '/private/tmp/claude-501/-Users-gregor-Data-5-plur-2-projects-plur/94b9039f-8597-4b45-a441-739ebf4b79cc/scratchpad/e2e'
R = '/private/tmp/pe2e.LXlt'
folder, outfile, prompts = sys.argv[1], sys.argv[2], sys.argv[3:]

env = dict(os.environ)
for k in ('ANTHROPIC_API_KEY', 'CLAUDE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'):
    env.pop(k, None)
env.update(PLUR_PATH=f'{R}/plur', TMPDIR=f'{R}/tmp', PATH=f'{R}/prefix/bin:' + env['PATH'])
args = ['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--include-hook-events', '--setting-sources', 'project', '--settings', f'{S}/fallback-settings.json',
        '--strict-mcp-config', '--mcp-config', f'{S}/fallback-mcp.json',
        '--allowedTools', 'Bash(plur:*)', 'mcp__plur__*']
with open(outfile + '.cmd', 'w') as f:
    f.write(f'$ cd {folder} && PLUR_PATH={R}/plur TMPDIR={R}/tmp ' + ' '.join(
        a if not a.startswith(S) else os.path.basename(a) for a in args) + '\n')
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
rc = proc.wait(timeout=120)
time.sleep(2)  # let SessionEnd's detached work settle
out.write(json.dumps({'type': 'e2e_note', 'exit': rc, 'folder_nonces_after_exit': nonces()}) + '\n')
out.close()
with open(outfile + '.cmd', 'a') as f:
    f.write(f'exit={rc}\n')
