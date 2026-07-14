"""Real-process orphan/leak test for the plur-ai bridge timeout path.

MISSING coverage (PROVEN class): ``bridge.run_json`` calls
``subprocess.run(cmd, timeout=...)`` with an ``npx`` fallback and NO
``start_new_session=True`` / ``os.killpg``. When the call times out,
``subprocess.run`` SIGKILLs only the *direct* child (e.g. ``npx``); any
grandchild it spawned (e.g. the ``node`` CLI process) is orphaned and reparented
to PID 1 instead of being reaped. It keeps running, holding memory, forever.

This test spawns a genuine parent→grandchild process tree (a real Python parent
that spawns a long-sleeping grandchild and records its PID) and drives the
bridge's actual timeout path. A MOCKED subprocess CANNOT detect this bug — only
a real process tree can — which is why this test exists alongside the mocked
timeout tests. The bridge now runs the CLI via ``_run_in_process_group``
(``start_new_session=True`` + ``os.killpg`` on timeout), mirroring the Hermes
fix, so the whole process group is reaped and the grandchild no longer orphans
to PID 1 — this test is green (#495).
"""
from __future__ import annotations

import os
import shlex
import signal
import sys
import time

import pytest

from plur_ai.bridge import PlurError, run_json

# A real parent that spawns a detached, long-lived grandchild and writes the
# grandchild PID to a file, then blocks so the bridge's timeout fires while the
# parent is still alive. stdio is sent to /dev/null so the grandchild never
# holds the bridge's captured stdout pipe (which would otherwise stall
# subprocess.run's post-kill communicate()).
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
        # Exists but not ours — treat as alive (not reaped).
        return False


def _force_kill(pid: int) -> None:
    try:
        os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group semantics")
def test_timeout_reaps_grandchild(tmp_path, monkeypatch):
    script = tmp_path / "parent.py"
    pidfile = tmp_path / "gc.pid"
    script.write_text(_PARENT_SRC)

    # Point the bridge at our real parent process via PLUR_CLI (shell-split);
    # run_json appends its own args + "--json", which the parent ignores.
    monkeypatch.setenv(
        "PLUR_CLI",
        f"{shlex.quote(sys.executable)} {shlex.quote(str(script))} {shlex.quote(str(pidfile))}",
    )

    # Drive the real timeout path — this must raise (hung CLI).
    with pytest.raises(PlurError):
        run_json(["status"], timeout=2)

    # The parent wrote the grandchild PID before blocking.
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
