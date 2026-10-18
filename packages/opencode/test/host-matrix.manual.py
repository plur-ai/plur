"""Run the same packed-artifact lifecycle gate on native macOS, Linux and Windows."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(os.environ['RUNNER_TEMP'])
adapter = os.environ['ADAPTER']
package = 'opencode-ai' if adapter == 'v1' else '@opencode/cli'
host_package = root / 'host/node_modules' / package
manifest = json.loads((host_package / 'package.json').read_text(encoding='utf-8'))
# Execute the native binary, not npm's POSIX/.cmd shim (shell=False on Windows).
host = host_package / manifest['bin']['opencode']
node = shutil.which('node')
assert node and host.is_file(), (node, host)
base = [sys.executable, str(Path(__file__).with_name('host.manual.py')),
        '--packed', str(root / 'packed'), '--host', str(host), '--node', node]
if adapter == 'v1':
    base.append('--v1')
env = dict(os.environ, PYTHONUTF8='1')
for mode in ('on', 'off', 'ask'):
    subprocess.run(base + ['--mode', mode], env=env, check=True)
if adapter == 'v2':
    subprocess.run(base + ['--mode', 'ask', '--accept-consent', '--mcp'], env=env, check=True)
