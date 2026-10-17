"""The eval harness itself: each test is a hole the independent audit (2026-10-17) found.

Run: python3 scripts/test_evals_harness.py   (prints ok; any failure raises)
"""
import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent


def _load(name):
    key = f"evals_{name}"
    if key not in sys.modules:
        spec = importlib.util.spec_from_file_location(key, ROOT / ".evals" / f"{name}.py")
        sys.modules[key] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules[key])
    return sys.modules[key]


run, gate, bite = _load("run"), _load("gate"), _load("bite")

FAKE_VITEST = """import sys, pathlib
junit, mode = sys.argv[1], sys.argv[2]
files = sys.argv[3:]
cases = "".join(
    f'<testcase name="t" classname="{f}" file="{f}">'
    + ('<failure message="expected x, saw y"/>' if mode == "assert" and i == 0 else "")
    + "</testcase>" for i, f in enumerate(files))
pathlib.Path(junit).write_text(f'<testsuites><testsuite name="s">{cases}</testsuite></testsuites>')
if mode == "unhandled":
    print("Unhandled Rejection: save failed after the test ended")
    sys.exit(1)
if mode == "unhandled-named":
    print("Unhandled Rejection\\nThis error originated in \\"evals/b/" + pathlib.Path(files[1]).name + "\\" test file.")
    sys.exit(1)
if mode == "teardown":
    print("Error: teardown failed")
    sys.exit(1)
sys.exit(1 if mode == "assert" else 0)
"""


def _repo(tmp: Path, baseline=None, retired=None, kinds=None):
    (tmp / "evals" / "b").mkdir(parents=True)
    ps = [{"id": i, "promise": f"promise {i}", "kind": (kinds or {}).get(i, "deterministic")}
          for i in ("AB-1", "AB-2", "AB-3")]
    doc = {"capabilities": [{"key": "b", "promises": ps}]}
    if retired:
        doc["retired"] = [{"id": r, "replaced_by": "AB-3", "reason": "meaning changed"} for r in retired]
    (tmp / "evals" / "promises.yaml").write_text(yaml.safe_dump(doc))
    for i in (1, 2, 3):
        (tmp / "evals" / "b" / f"test_promise_AB{i}_x.test.ts").write_text("// stub\n")
    fake = tmp / "fake_vitest.py"
    fake.write_text(FAKE_VITEST)
    cfg = {"root": "..", "promises": ["evals/promises.yaml"], "baseline": "evals/baseline.json",
           "suites": [{"name": "evals", "cwd": ".", "tests": "evals", "runner": "vitest", "recursive": True,
                       "command": [sys.executable, str(fake), "{junit}", "pass"]}]}
    (tmp / "evals" / "evals.yaml").write_text(yaml.safe_dump(cfg))
    if baseline is not None:
        (tmp / "evals" / "baseline.json").write_text(baseline)
    return tmp / "evals" / "evals.yaml"


def _chunk(tmp: Path, mode: str):
    cfg_path = _repo(tmp)
    files = sorted((tmp / "evals" / "b").glob("*.test.ts"))
    cmd = [sys.executable, str(tmp / "fake_vitest.py"), "{junit}", mode]
    return run.run_vitest_chunk(tmp, files, {}, 60, cmd)


# --- E-01: a failed process is never green -------------------------------------------------

def test_passing_report_with_failed_exit_is_red():
    for mode in ("unhandled", "teardown"):
        with tempfile.TemporaryDirectory() as d:
            res = _chunk(Path(d), mode)
            assert res and all(not ok for ok, _ in res.values()), (mode, res)
            assert all("exited 1" in why for _, why in res.values()), res


def test_unhandled_error_named_by_vitest_reds_only_that_file():
    with tempfile.TemporaryDirectory() as d:
        res = _chunk(Path(d), "unhandled-named")
        red = sorted(n for n, (ok, _) in res.items() if not ok)
        assert red == ["test_promise_AB2_x.test.ts"], res


def test_attributed_assertion_failure_keeps_its_attribution():
    with tempfile.TemporaryDirectory() as d:
        res = _chunk(Path(d), "assert")
        red = sorted(n for n, (ok, _) in res.items() if not ok)
        assert red == ["test_promise_AB1_x.test.ts"], res
        assert "expected x, saw y" in res["test_promise_AB1_x.test.ts"][1]


def test_clean_run_is_green():
    with tempfile.TemporaryDirectory() as d:
        res = _chunk(Path(d), "pass")
        assert len(res) == 3 and all(ok for ok, _ in res.values()), res


# --- E-03: a lost baseline fails closed; greens leave only by retirement -------------------

def _gate(cfg_path, *extra):
    return gate.main(["--config", str(cfg_path), *extra])


def test_missing_or_malformed_baseline_fails_the_gate():
    for content in (None, "{not json", '{"red": []}'):
        with tempfile.TemporaryDirectory() as d:
            assert _gate(_repo(Path(d), baseline=content)) == 1, content


def test_empty_valid_baseline_has_nothing_to_gate():
    with tempfile.TemporaryDirectory() as d:
        assert _gate(_repo(Path(d), baseline='{"green": []}')) == 0


def test_green_promises_are_gated():
    with tempfile.TemporaryDirectory() as d:
        assert _gate(_repo(Path(d), baseline='{"green": ["AB-1", "AB-2"]}')) == 0


def _git_repo(tmp: Path, baseline: str, retired=None):
    cfg = _repo(tmp, baseline=baseline, retired=retired)
    for c in (["init", "-q"], ["add", "-A"], ["-c", "user.email=e@x", "-c", "user.name=e", "commit", "-qm", "base"]):
        subprocess.run(["git", *c], cwd=tmp, check=True, capture_output=True)
    return cfg


def test_pull_request_cannot_drop_a_base_green_without_retiring_it():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        cfg = _git_repo(tmp, '{"green": ["AB-1", "AB-2"]}')
        (tmp / "evals" / "baseline.json").write_text('{"green": ["AB-1"]}')
        assert _gate(cfg, "--base", "HEAD") == 1
        # pointing the config at another (missing) baseline does not help either
        doc = yaml.safe_load(cfg.read_text())
        doc["baseline"] = "evals/elsewhere.json"
        cfg.write_text(yaml.safe_dump(doc))
        assert _gate(cfg, "--base", "HEAD") == 1


def test_retired_promise_may_leave_the_baseline():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        cfg = _git_repo(tmp, '{"green": ["AB-1", "AB-2"]}')
        (tmp / "evals" / "baseline.json").write_text('{"green": ["AB-1"]}')
        doc = yaml.safe_load((tmp / "evals" / "promises.yaml").read_text())
        doc["retired"] = [{"id": "AB-2", "replaced_by": "AB-3", "reason": "meaning changed"}]
        (tmp / "evals" / "promises.yaml").write_text(yaml.safe_dump(doc))
        assert _gate(cfg, "--base", "HEAD") == 0


def test_write_baseline_refuses_to_drop_an_earlier_green():
    with tempfile.TemporaryDirectory() as d:
        cfg = run.config.load(str(_repo(Path(d), baseline='{"green": ["AB-1", "AB-2"]}')))
        board = run.Board(status={"AB-1": "green", "AB-2": "red", "AB-3": "green"}, text={})
        lost = run.write_baseline(cfg, board, set())
        assert lost == ["AB2"], lost
        assert json.loads(cfg.baseline.read_text())["green"] == ["AB-1", "AB-2"]   # untouched
        assert run.write_baseline(cfg, board, set(), allow_drop=True) == ["AB2"]
        assert json.loads(cfg.baseline.read_text())["green"] == ["AB1", "AB3"]


# --- E-05: nightly can be green without the paid agent evals --------------------------------

def test_excluded_kind_is_not_run_and_does_not_fail():
    with tempfile.TemporaryDirectory() as d:
        cfg = run.config.load(str(_repo(Path(d), kinds={"AB-3": "agent"})))
        board = run.score(cfg, exclude_kinds=["agent"])
        assert board.status == {"AB-1": "green", "AB-2": "green", "AB-3": "not-run"}, board.status
        assert board.counts().get("red", 0) == 0


def test_nightly_scoreboard_excludes_agent_evals_and_weekly_runs_them():
    wf = yaml.safe_load((ROOT / ".github" / "workflows" / "evals.yml").read_text())
    nightly = " ".join(s.get("run", "") for s in wf["jobs"]["nightly"]["steps"])
    agents = " ".join(s.get("run", "") for s in wf["jobs"]["agents"]["steps"])
    assert "--exclude-kind agent" in nightly, nightly
    assert "--agents" in agents and "--exclude-kind" not in agents


# --- E-02: every pnpm setup knows its version ------------------------------------------------

def test_every_pnpm_setup_has_a_version():
    wf = yaml.safe_load((ROOT / ".github" / "workflows" / "evals.yml").read_text())
    has_pm = "packageManager" in json.loads((ROOT / "package.json").read_text())
    steps = [s for j in wf["jobs"].values() for s in j["steps"] if "pnpm/action-setup" in s.get("uses", "")]
    assert steps, "no pnpm setup step found"
    for s in steps:
        assert has_pm or (s.get("with") or {}).get("version"), s


# --- bite: a planted bug that breaks the build is not a kill ---------------------------------

def test_crash_or_timeout_is_not_a_kill():
    assert bite._not_behaviour("x.test.ts: could not tell: vitest never reported this file")
    assert bite._not_behaviour("x.test.ts: timeout after 900s (the chunk hung)")
    assert not bite._not_behaviour("x.test.ts: t: failure: expected the memory to stay local; it was sent")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
