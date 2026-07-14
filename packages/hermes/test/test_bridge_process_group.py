"""Real-process orphan/leak test for the Hermes bridge timeout path.

MISSING coverage (PROVEN class): ``PlurBridge._invoke_cli`` calls
``subprocess.run(cmd, timeout=...)`` with an ``npx`` fallback and NO
``start_new_session=True`` / ``os.killpg``. On timeout, ``subprocess.run``
SIGKILLs only the *direct* child (e.g. ``npx``); any grandchild (e.g. the
``node`` CLI process) is orphaned and reparented to PID 1 instead of being
reaped. It keeps running forever.

The four mocked timeout tests in ``test_bridge.py``
(``test_call_timeout_returns_safe_fallback``,
``test_call_timeout_retries_then_falls_back``,
``test_inject_graceful_fallback_on_timeout``,
``test_timeout_triggers_outer_retry_not_lock_retry``) patch ``subprocess.run``,
so they verify the return-value / retry contract but CANNOT observe the orphan —
a mock never spawns a real grandchild. This test spawns a genuine
parent→grandchild tree and drives the real timeout path to detect the leak.

The fix (process-group teardown, PR #535) is now ported to ``main``: the
bridge kills the whole process group on timeout, so the grandchild is reaped
with its parent and this test passes.
"""
import os
import signal
import subprocess
import sys
import time

import pytest

from plur_hermes.bridge import PlurBridge

# Real parent: spawns a detached, long-lived grandchild, records its PID, then
# blocks so the bridge's timeout fires while the parent is alive. Grandchild
# stdio → /dev/null so it never holds the bridge's captured stdout pipe (which
# would stall subprocess.run's post-kill communicate()).
_PARENT_SRC = (
    "import os, subprocess, sys, time\n"
    "pidfile = sys.argv[1]\n"
    "child = subprocess.Popen(\n"
    "    [sys.executable, '-c', 'import time; time.sleep(600)'],\n"
    "    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,\n"
    ")\n"
    "with open(pidfile, 'w') as f:\n"
    "    f.write(str(child.pid)); f.flush(); os.fsync(f.fileno())\n"
    "time.sleep(600)\n"
)


def _is_reaped(pid: int) -> bool:
    """True if pid is gone (killed with its group); False if it survived."""
    try:
        os.kill(pid, 0)
        return False
    except ProcessLookupError:
        return True
    except PermissionError:
        return False


def _force_kill(pid: int) -> None:
    try:
        os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group semantics")
def test_timeout_reaps_grandchild(tmp_path):
    script = tmp_path / "parent.py"
    pidfile = tmp_path / "gc.pid"
    script.write_text(_PARENT_SRC)

    bridge = PlurBridge()
    # Build the command directly so _invoke_cli runs our real parent tree. This
    # exercises the exact subprocess.run(timeout=) that leaks the grandchild.
    cmd = [sys.executable, str(script), str(pidfile)]

    with pytest.raises(subprocess.TimeoutExpired):
        bridge._invoke_cli(cmd, "status", timeout=2)

    for _ in range(60):
        if pidfile.exists():
            break
        time.sleep(0.05)
    gc_pid = int(pidfile.read_text().strip())

    try:
        time.sleep(0.5)  # allow any process-group teardown to settle
        assert _is_reaped(gc_pid), (
            f"grandchild PID {gc_pid} survived the bridge timeout — it was "
            f"orphaned/reparented to PID 1 instead of being killed with its "
            f"process group (no start_new_session=True + os.killpg)"
        )
    finally:
        _force_kill(gc_pid)  # never leak a real 600s sleeper
