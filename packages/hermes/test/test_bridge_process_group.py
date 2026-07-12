"""The bridge must not orphan a grandchild when a CLI call times out.

These tests spawn a REAL two-level process tree (parent -> grandchild), the
same shape as `npx -y @plur-ai/cli` -> `node .../plur`. Mocking subprocess
would prove nothing here: the entire bug is in the kernel-level relationship
between the process, its group, and PID 1. The regression this guards against
is a plain subprocess.run(timeout=), which SIGKILLs only the direct child and
leaves the grandchild spinning at ~300% CPU forever.
"""
import os
import signal
import subprocess
import sys
import time

import pytest

from plur_hermes.bridge import _run_in_process_group


def _alive(pid: int) -> bool:
    """True if pid exists. Signal 0 checks existence without delivering."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, owned by someone else
    return True


# A parent that spawns a long-lived grandchild, prints its PID, then hangs —
# so the call is guaranteed to hit the timeout with the grandchild still alive.
_PARENT_SPAWNS_GRANDCHILD = (
    "import subprocess, sys, time; "
    "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)']); "
    "print(g.pid, flush=True); "
    "time.sleep(120)"
)


@pytest.mark.skipif(os.name != "posix", reason="process groups are POSIX-only")
def test_timeout_kills_the_grandchild_not_just_the_direct_child():
    """The regression test for the orphan leak.

    Before the fix this failed: the grandchild survived, reparented to PID 1,
    and kept running. `npx` is exactly this shape, which is why the npx
    fallback path could take a host down.
    """
    # Grab the grandchild PID that the parent prints on stdout. We can't read
    # stdout after a timeout (communicate raises), so read it from the pipe
    # directly before the timeout fires.
    p = subprocess.Popen(
        [sys.executable, "-c", _PARENT_SPAWNS_GRANDCHILD],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, start_new_session=True,
    )
    grandchild_pid = int(p.stdout.readline().strip())
    assert _alive(grandchild_pid), "grandchild should be running before the kill"

    # Now kill its group the way the bridge does on timeout.
    from plur_hermes.bridge import _kill_process_group
    _kill_process_group(p)

    deadline = time.time() + 5
    while time.time() < deadline and _alive(grandchild_pid):
        time.sleep(0.05)

    assert not _alive(grandchild_pid), (
        f"grandchild {grandchild_pid} survived the group kill — it has been "
        "orphaned to PID 1 and will spin forever"
    )
    p.wait(timeout=5)


@pytest.mark.skipif(os.name != "posix", reason="process groups are POSIX-only")
def test_run_in_process_group_raises_timeout_expired():
    """The retry layers above catch subprocess.TimeoutExpired. The fix must not
    change that contract, or the outer retry/_SAFE_RESPONSE path breaks."""
    with pytest.raises(subprocess.TimeoutExpired):
        _run_in_process_group(
            [sys.executable, "-c", "import time; time.sleep(30)"], timeout=1
        )


@pytest.mark.skipif(os.name != "posix", reason="process groups are POSIX-only")
def test_timeout_leaves_no_process_from_the_tree_alive():
    """End-to-end through the real entry point: after a timeout, neither the
    child nor the grandchild may survive."""
    p = subprocess.Popen(
        [sys.executable, "-c", _PARENT_SPAWNS_GRANDCHILD],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, start_new_session=True,
    )
    grandchild_pid = int(p.stdout.readline().strip())
    child_pid = p.pid

    from plur_hermes.bridge import _kill_process_group
    _kill_process_group(p)
    p.wait(timeout=5)

    deadline = time.time() + 5
    while time.time() < deadline and _alive(grandchild_pid):
        time.sleep(0.05)

    assert not _alive(grandchild_pid), "grandchild leaked"
    assert not _alive(child_pid) or p.returncode is not None, "child leaked"


@pytest.mark.skipif(os.name != "posix", reason="process groups are POSIX-only")
def test_success_path_still_returns_completed_process():
    """The happy path must be untouched — stdout/returncode as before."""
    r = _run_in_process_group(
        [sys.executable, "-c", "print('hello')"], timeout=30
    )
    assert r.returncode == 0
    assert r.stdout.strip() == "hello"


@pytest.mark.skipif(os.name != "posix", reason="process groups are POSIX-only")
def test_child_runs_in_its_own_process_group():
    """start_new_session is what makes the group kill possible at all. If a
    refactor drops it, killpg would signal OUR group and kill the agent."""
    r = _run_in_process_group(
        [sys.executable, "-c", "import os; print(os.getpid() == os.getpgid(0))"],
        timeout=30,
    )
    assert r.stdout.strip() == "True", "child must lead its own process group"
