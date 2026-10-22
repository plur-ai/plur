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
        # a retired promise leaves the active list (R-05: active and retired at once is invalid)
        doc["capabilities"][0]["promises"] = [p for p in doc["capabilities"][0]["promises"] if p["id"] != "AB-2"]
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
    assert not bite._not_behaviour("x.test.ts: t: failure (AssertionError): expected the memory to stay local")


# --- real vitest runs (second audit, R-04 and R-06): the fake runner hid both holes ---------

VITEST = ROOT / "node_modules" / ".bin" / "vitest"


def _vitest_cmd() -> list[str]:
    # Skipped means red: without vitest these tests fail and say why.
    assert VITEST.exists(), f"the real-runner tests need vitest at {VITEST}: run pnpm install first"
    # The same reporters as evals/evals.yaml: JUnit only.
    return [str(VITEST), "run", "--config", "evals/vitest.config.mjs", "--reporter=junit", "--outputFile={junit}"]


def _vitest_repo(tmp: Path, files: dict, teardown_throws: bool = False) -> Path:
    """A throwaway repo whose evals run under real vitest, with a global setup module."""
    ev = tmp / "evals"
    (ev / "b").mkdir(parents=True, exist_ok=True)
    (ev / "vitest.config.mjs").write_text(
        "export default { test: { root: process.cwd(), include: ['evals/**/test_promise_*.test.ts'], "
        "globals: true, fileParallelism: false, globalSetup: ['evals/global.mjs'] } }\n")
    (ev / "global.mjs").write_text(
        "export function setup() {}\nexport function teardown() {"
        + (" throw new Error('global teardown failed after the files ran') " if teardown_throws else "") + "}\n")
    for rel, body in files.items():
        p = tmp / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)
    return ev


PASS_TS = "it('keeps the memory', () => { expect(1).toBe(1) })\n"
FAIL_TS = "it('keeps the memory', () => { expect('lost').toBe('kept') })\n"


def _real_chunk(tmp: Path, files: dict, teardown_throws: bool = False):
    ev = _vitest_repo(tmp, files, teardown_throws)
    return run.run_vitest_chunk(tmp, sorted((ev / "b").glob("*.test.ts")), {}, 600, _vitest_cmd())


def test_real_global_teardown_error_alone_leaves_no_file_green():
    # R-06: vitest exits 0 and writes a passing report; only its log says "error during close".
    with tempfile.TemporaryDirectory() as d:
        res = _real_chunk(Path(d), {"evals/b/test_promise_AB1_x.test.ts": PASS_TS}, teardown_throws=True)
        assert res and all(not ok for ok, _ in res.values()), res
        assert all("outside any test case" in why for _, why in res.values()), res


def test_real_global_teardown_error_with_an_assertion_failure_leaves_no_file_green():
    with tempfile.TemporaryDirectory() as d:
        res = _real_chunk(Path(d), {"evals/b/test_promise_AB1_x.test.ts": PASS_TS,
                                    "evals/b/test_promise_AB2_x.test.ts": FAIL_TS}, teardown_throws=True)
        assert len(res) == 2 and all(not ok for ok, _ in res.values()), res
        assert "outside any test case" in res["test_promise_AB1_x.test.ts"][1], res
        assert "kept" in res["test_promise_AB2_x.test.ts"][1], res     # its own failure is kept


def test_real_clean_run_stays_green_and_an_assertion_reds_only_its_file():
    # controls: the teardown check does not red healthy runs
    with tempfile.TemporaryDirectory() as d:
        res = _real_chunk(Path(d), {"evals/b/test_promise_AB1_x.test.ts": PASS_TS,
                                    "evals/b/test_promise_AB2_x.test.ts": FAIL_TS})
        assert res["test_promise_AB1_x.test.ts"] == (True, ""), res
        assert not res["test_promise_AB2_x.test.ts"][0], res


# Each promise has one planted bug. AB-1..AB-5 break the run, not a behaviour: an import
# error, a syntax error, a TypeError before any assertion, a timeout and a global-teardown
# error. AB-6 and AB-7 are caught by an assertion -- AB-7 by asserting the memory is there
# at all, which must stay distinct from AB-3, a crash on dereferencing that same absence.
BITE_SRC = {
    "AB-1": ("export const v = 'kept'\n", "import './gone.js'\nexport const v = 'kept'\n",
             "import { v } from '../../src/ab1'\nit('keeps', () => { expect(v).toBe('kept') })\n"),
    "AB-2": ("export const v = 'kept'\n", "export const = 'kept'\n",
             "import { v } from '../../src/ab2'\nit('keeps', () => { expect(v).toBe('kept') })\n"),
    "AB-3": ("export function find(k: string): any { return { name: k } }\n",
             "export function find(k: string): any { return null }\n",
             "import { find } from '../../src/ab3'\nit('finds', () => { expect(find('x').name).toBe('x') })\n"),
    "AB-4": ("export async function load(): Promise<string> { return 'done' }\n",
             "export async function load(): Promise<string> { return new Promise(() => {}) }\n",
             "import { load } from '../../src/ab4'\n"
             "it('loads', async () => { expect(await load()).toBe('done') }, 1500)\n"),
    "AB-5": (None, None, "it('keeps', () => { expect(1).toBe(1) })\n"),
    "AB-6": ("export const v = 'kept'\n", "export const v = 'lost'\n",
             "import { v } from '../../src/ab6'\nit('keeps', () => { expect(v).toBe('kept') })\n"),
    "AB-7": ("export function find(k: string): any { return { name: k } }\n",
             "export function find(k: string): any { return undefined }\n",
             "import { find } from '../../src/ab7'\n"
             "it('finds', () => { const f = find('x'); expect(f).toBeDefined(); expect(f.name).toBe('x') })\n"),
}


def _git(tmp: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=tmp, check=True, capture_output=True, text=True).stdout


def test_bite_tells_a_crash_from_a_kill_on_real_vitest_reports():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        files = {}
        for pid, (src, _, test) in BITE_SRC.items():
            n = pid.split("-")[1]
            files[f"evals/b/test_promise_AB{n}_x.test.ts"] = test
            if src:
                files[f"src/ab{n}.ts"] = src
        ev = _vitest_repo(tmp, files)
        ps = [{"id": pid, "promise": f"promise {pid}", "kind": "deterministic"} for pid in BITE_SRC]
        (ev / "promises.yaml").write_text(yaml.safe_dump({"promises": ps}))
        (ev / "evals.yaml").write_text(yaml.safe_dump({
            "root": "..", "promises": ["evals/promises.yaml"], "baseline": "evals/baseline.json",
            "mutants": "evals/mutants", "chunk_files": 10, "timeout_s": 600,
            "suites": [{"name": "evals", "cwd": ".", "tests": "evals", "runner": "vitest", "recursive": True,
                        "command": _vitest_cmd()}]}))
        _git(tmp, "init", "-q")
        _git(tmp, "add", "-A")
        _git(tmp, "-c", "user.email=e@x", "-c", "user.name=e", "commit", "-qm", "base")
        (ev / "mutants").mkdir()
        for pid, (src, bad, _) in BITE_SRC.items():
            n = pid.split("-")[1]
            target = ev / "global.mjs" if pid == "AB-5" else tmp / "src" / f"ab{n}.ts"
            original = target.read_text()
            target.write_text(original.replace("teardown() {", "teardown() { throw new Error('teardown broke') ")
                              if pid == "AB-5" else bad)
            (ev / "mutants" / f"{pid}-1.patch").write_text(_git(tmp, "diff", "--", str(target.relative_to(tmp))))
            target.write_text(original)
        results = {r.promise: (r.verdict, r.note) for r in bite.check(run.config.load(ev / "evals.yaml"))}
        verdicts = {p: v for p, (v, _) in results.items()}
        assert verdicts == {"AB-1": "could-not-tell", "AB-2": "could-not-tell", "AB-3": "could-not-tell",
                            "AB-4": "could-not-tell", "AB-5": "could-not-tell",
                            "AB-6": "killed", "AB-7": "killed"}, results
        assert not _git(tmp, "status", "--porcelain", "--untracked-files=no"), "bite left a patch applied"


# --- R-05: a retirement must be valid, and a baseline is never rebuilt from a broken one -----

def _retire(cfg_path: Path, entries: list) -> None:
    p = cfg_path.parent / "promises.yaml"
    doc = yaml.safe_load(p.read_text())
    doc["retired"] = entries
    p.write_text(yaml.safe_dump(doc))


def _quiet(fn, *a, **kw):
    import contextlib
    import io
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        code = fn(*a, **kw)
    return code, buf.getvalue()


BAD_RETIREMENTS = {
    "still active": {"id": "AB-1", "replaced_by": "AB-3", "reason": "meaning changed"},
    "no reason": {"id": "AB-9", "replaced_by": "AB-3"},
    "no replacement": {"id": "AB-9", "reason": "meaning changed"},
    "replacement unknown": {"id": "AB-9", "replaced_by": "ZZ-1", "reason": "meaning changed"},
    "moved nowhere": {"id": "AB-9", "moved_to": " ", "reason": "moved with its code"},
    "moved to no repository": {"id": "AB-9", "moved_to": "elsewhere", "reason": "moved with its code"},
    "moved and replaced": {"id": "AB-9", "moved_to": "acme/private", "replaced_by": "AB-3", "reason": "both"},
}


def test_invalid_retirement_fails_the_gate_and_the_scoreboard():
    for why, entry in BAD_RETIREMENTS.items():
        with tempfile.TemporaryDirectory() as d:
            cfg = _repo(Path(d), baseline='{"green": ["AB-1", "AB-2"]}')
            _retire(cfg, [entry])
            code, out = _quiet(_gate, cfg)
            assert code == 1 and "could not tell" in out, (why, code, out)
            code, out = _quiet(run.main, ["--config", str(cfg)])
            assert code == 1 and "could not tell" in out, (why, code, out)


def test_promise_moved_to_another_repository_may_leave_the_baseline():
    # A promise whose code moved to another repository has no replacement here;
    # it leaves this gate by naming where it went (owner/repo), with a reason.
    with tempfile.TemporaryDirectory() as d:
        cfg = _repo(Path(d), baseline='{"green": ["AB-1"]}')
        _retire(cfg, [{"id": "AB-7", "moved_to": "acme/private", "reason": "the setup code moved there"}])
        assert run.retirement_problems(run.config.load(str(cfg))) == []
        assert "AB7" in run.retired(run.config.load(str(cfg)))


def test_retirement_replaced_by_a_retired_promise_fails():
    with tempfile.TemporaryDirectory() as d:
        cfg = _repo(Path(d), baseline='{"green": ["AB-1"]}')
        _retire(cfg, [{"id": "AB-8", "replaced_by": "AB-9", "reason": "r"},
                      {"id": "AB-9", "replaced_by": "AB-3", "reason": "r"}])
        code, out = _quiet(_gate, cfg)
        assert code == 1 and "AB-8" in out, out


def test_write_baseline_refuses_an_unreadable_earlier_baseline():
    for content in ("{malformed", '{"red": []}', '["AB-1"]'):
        with tempfile.TemporaryDirectory() as d:
            cfg_path = _repo(Path(d), baseline=content)
            code, out = _quiet(run.main, ["--config", str(cfg_path), "--write-baseline"])
            assert code == 1 and "baseline" in out and "could not tell" in out, (content, out)
            assert (cfg_path.parent / "baseline.json").read_text() == content   # untouched


def test_write_baseline_initialises_when_there_is_no_baseline_yet():
    with tempfile.TemporaryDirectory() as d:
        cfg_path = _repo(Path(d))
        code, _ = _quiet(run.main, ["--config", str(cfg_path), "--write-baseline"])
        assert code == 0
        assert json.loads((cfg_path.parent / "baseline.json").read_text())["green"] == ["AB1", "AB2", "AB3"]


def _repo_on_bare_base(tmp: Path) -> Path:
    """Base commit with no evals at all; the evals arrive in the working tree (the first PR)."""
    (tmp / "README.md").write_text("before the evals\n")
    for c in (["init", "-q"], ["add", "-A"], ["-c", "user.email=e@x", "-c", "user.name=e", "commit", "-qm", "base"]):
        subprocess.run(["git", *c], cwd=tmp, check=True, capture_output=True)
    return _repo(tmp, baseline='{"green": ["AB-1"]}')


def test_base_without_evals_says_so_and_needs_an_explicit_bootstrap():
    with tempfile.TemporaryDirectory() as d:
        cfg = _repo_on_bare_base(Path(d))
        code, out = _quiet(_gate, cfg, "--base", "HEAD")
        assert code == 1 and "no evals config" in out and "--bootstrap" in out, out
        code, out = _quiet(_gate, cfg, "--base", "HEAD", "--bootstrap")
        assert code == 0 and "bootstrap" in out.lower() and "own baseline" in out, out


def test_bootstrap_does_not_weaken_a_base_that_has_evals():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        cfg = _git_repo(tmp, '{"green": ["AB-1", "AB-2"]}')
        (tmp / "evals" / "baseline.json").write_text('{"green": ["AB-1"]}')
        code, out = _quiet(_gate, cfg, "--base", "HEAD", "--bootstrap")
        assert code == 1 and "REGRESSED AB2" in out, out


# --- workflow: the gate's route, the model cache, the holdout --------------------------------

def _workflow():
    return yaml.safe_load((ROOT / ".github" / "workflows" / "evals.yml").read_text())


def test_ci_calls_the_harness_directly_never_through_package_scripts():
    # R-02: a PR's package.json could turn `pnpm evals:gate` into a no-op
    wf = _workflow()
    runs = [s.get("run", "") for j in wf["jobs"].values() for s in j["steps"]]
    assert not [r for r in runs if "pnpm evals" in r or "pnpm -s evals" in r], runs
    gate_runs = " ".join(s.get("run", "") for s in wf["jobs"]["gate"]["steps"])
    assert "python3 .evals/gate.py --config evals/evals.yaml" in gate_runs, gate_runs


def _step_index(steps, needle):
    return next((i for i, s in enumerate(steps) if needle in (s.get("run") or "")), None)


def test_model_is_provisioned_before_any_eval_runs():
    # R-07: a cold cache under the network guard cannot download the model
    wf = _workflow()
    for job in ("nightly", "agents"):
        steps = wf["jobs"][job]["steps"]
        cache = next((i for i, s in enumerate(steps) if "actions/cache" in s.get("uses", "")
                      and "PLUR_MODEL_CACHE_DIR" in str((s.get("with") or {}).get("path"))), None)
        prov = _step_index(steps, "evals/helpers/provision-model.mjs")
        evals_at = [i for i in (_step_index(steps, ".evals/run.py"), _step_index(steps, ".evals/bite.py"))
                    if i is not None]
        assert cache is not None and prov is not None and evals_at, (job, cache, prov, evals_at)
        assert cache < prov < min(evals_at), (job, cache, prov, evals_at)
        assert "verify" in steps[prov]["run"], steps[prov]


def test_nightly_never_scores_after_a_failed_holdout_check():
    steps = _workflow()["jobs"]["nightly"]["steps"]
    holdout = next((i for i, s in enumerate(steps) if s.get("id") == "holdout"), None)
    assert holdout is not None and "hash_set.py" in steps[holdout]["run"]
    for needle in (".evals/run.py", ".evals/bite.py"):
        i = _step_index(steps, needle)
        assert i is not None and i > holdout, needle
        cond = str(steps[i].get("if", ""))
        assert "always()" not in cond and "steps.holdout.outcome == 'success'" in cond, (needle, cond)


# --- local first (owner, 2026-10-18): GitHub runs only the merge gate --------------------------

def test_github_runs_evals_only_for_pull_requests_into_development_and_main_and_has_no_schedule():
    # Owner 2026-10-18: work merges into development (the eval branch goes there first),
    # and development goes to main; stacked branches are proven locally.
    on = _workflow().get(True) or _workflow().get("on")   # yaml reads a bare `on:` as True
    assert "schedule" not in on, on
    assert on["pull_request"] == {"branches": ["development", "main"]}, on["pull_request"]
    assert on["push"] == {"branches": ["development", "main"]}, on["push"]
    jobs = _workflow()["jobs"]
    assert "schedule" not in str(jobs["nightly"]["if"]) and "workflow_dispatch" in str(jobs["nightly"]["if"])
    assert "schedule" not in str(jobs["agents"]["if"]) and "inputs.agents" in str(jobs["agents"]["if"])


def test_local_script_keeps_the_workflow_refusals():
    sh = (ROOT / "scripts" / "evals-local.sh").read_text()
    nightly = sh[sh.index("  nightly)"):sh.index("  agents)")]
    # the model is verified offline, and the holdout checked, before anything is scored
    order = [nightly.index(n) for n in ("provision_model", "hash_set.py", "gold/check.py",
                                        ".evals/run.py", ".evals/bite.py")]
    assert order == sorted(order), order
    fn = sh[sh.index("provision_model() {"):sh.index("}", sh.index("provision_model() {"))]
    assert fn.index("provision-model.mjs fetch") < fn.index("provision-model.mjs verify"), fn
    assert "--exclude-kind agent" in nightly
    # every holdout check the workflow's nightly makes, the local nightly makes too
    wf_checks = [ln.strip() for s in _workflow()["jobs"]["nightly"]["steps"] if s.get("id") == "holdout"
                 for ln in s["run"].splitlines() if "evals/gold/" in ln]
    assert wf_checks and all(c in nightly for c in wf_checks), [c for c in wf_checks if c not in nightly]
    assert max(nightly.index(c) for c in wf_checks) < nightly.index(".evals/run.py")
    gate = sh[sh.index("  gate)"):sh.index("  nightly)")]
    for needle in ("test_check_eval_separation.py", "check-eval-separation.py", "test_evals_harness.py",
                   "scripts/judge-intact.sh", "python3 .evals/gate.py --config evals/evals.yaml --base"):
        assert needle in gate, needle
    # a stacked base gets the strict separation check (fourth audit A4-01)
    assert 'integration/*) STRICT=--strict' in gate and 'check-eval-separation.py "origin/$BASE" $STRICT' in gate
    assert "pnpm evals" not in sh and "pnpm -s evals" not in sh
    agents = sh[sh.index("  agents)"):]
    assert "unset ANTHROPIC_API_KEY" in agents and "--agents" in agents
    # A configured holdout is validated before any agent eval reads it (fourth audit A4-06):
    # the same hash and label checks as the nightly, before run.py.
    assert wf_checks and all(c in agents for c in wf_checks), [c for c in wf_checks if c not in agents]
    assert max(agents.index(c) for c in wf_checks) < agents.index(".evals/run.py")
    assert 'PLUR_EVAL_HOLDOUT_DIR:-' in agents[:agents.index(wf_checks[0])]


def test_the_agents_job_on_github_reads_no_holdout():
    # The manual agents job scores the public dev set only; were it ever given a holdout
    # it would need the nightly's validation first (fourth audit A4-06).
    job = _workflow()["jobs"]["agents"]
    assert "PLUR_EVAL_HOLDOUT_DIR" not in json.dumps(job) and "holdout" not in json.dumps(job).lower(), job


def _check_dedup(pairs_yaml: str, same_as: bool = False):
    with tempfile.TemporaryDirectory() as d:
        Path(d, "dedup_pairs.yaml").write_text(pairs_yaml)
        cmd = [sys.executable, str(ROOT / "evals/gold/check.py"), "--dedup", d]
        if same_as:
            cmd += ["--same-pairs-as", str(ROOT / "evals/gold/recall-v1")]
        return subprocess.run(cmd, capture_output=True, text=True)


def test_dedup_v2_labels_are_valid_and_keep_the_frozen_texts():
    r = subprocess.run([sys.executable, str(ROOT / "evals/gold/check.py"), "--dedup", str(ROOT / "evals/gold/dedup-v2"),
                        "--same-pairs-as", str(ROOT / "evals/gold/recall-v1")], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    # 3 distinct pairs relabelled from the frozen 60, plus 17 written by an independent
    # labeller (owner, 2026-10-18): the false-merge rate is measurable.
    assert "warning" not in r.stdout, r.stdout
    pairs = yaml.safe_load((ROOT / "evals/gold/dedup-v2/dedup_pairs.yaml").read_text())["pairs"]
    assert sum(p["label"] == "distinct" for p in pairs) >= 20


def test_dedup_check_keeps_the_frozen_60_and_holds_added_pairs_to_the_overlap_rule():
    base = (ROOT / "evals/gold/dedup-v2/dedup_pairs.yaml").read_text()
    pairs = yaml.safe_load(base)["pairs"]
    frozen = [p for p in pairs if int(p["id"][1:]) <= 60]
    added = [p for p in pairs if int(p["id"][1:]) > 60]
    assert len(frozen) == 60 and added, (len(frozen), len(added))
    # a frozen pair may not be dropped
    r = _check_dedup(yaml.safe_dump({"pairs": pairs[1:]}), same_as=True)
    assert r.returncode == 1 and "missing" in r.stdout and "P001" in r.stdout, r.stdout
    # an added pair must be hard: high word overlap, or it tests nothing
    easy = dict(added[0], incoming="Bake sourdough at dawn with rye flour and sea salt.")
    r = _check_dedup(yaml.safe_dump({"pairs": frozen + [easy] + added[1:]}))
    assert r.returncode == 1 and "overlap" in r.stdout and added[0]["id"] in r.stdout, r.stdout


def test_dedup_check_rejects_an_unknown_label_and_a_changed_text():
    base = (ROOT / "evals/gold/dedup-v2/dedup_pairs.yaml").read_text()
    r = _check_dedup(base.replace('"label": "supersede"', '"label": "maybe"', 1))
    assert r.returncode == 1 and "unknown labels ['maybe']" in r.stdout, r.stdout
    r = _check_dedup(base.replace("five bullets", "six bullets", 1), same_as=True)
    assert r.returncode == 1 and "texts differ" in r.stdout and "P002" in r.stdout, r.stdout
    r = _check_dedup(base.replace('"label": "distinct"', '"label": "supersede"'))
    assert r.returncode == 1 and "0 distinct" in r.stdout, r.stdout




def test_judge_integrity_covers_every_judge_path_and_untracked_files():
    # Fourth audit A4-01: after install and build ran the change's package scripts,
    # every judge file must be as committed, the shared helpers and harness tests
    # included, and no new file may have appeared among them.
    sh = (ROOT / "scripts" / "judge-intact.sh").read_text()
    assert "--untracked-files=all" in sh and "git status --porcelain" in sh
    for path in (".evals", "evals", "scripts", "package.json", ".github", "packages/*/test/helpers"):
        assert path in sh, path
    steps = [st.get("run", "") for st in _workflow()["jobs"]["gate"]["steps"]]
    build = next(i for i, r in enumerate(steps) if "pnpm -r build" in r)
    intact = next(i for i, r in enumerate(steps) if "scripts/judge-intact.sh" in r)
    gate = next(i for i, r in enumerate(steps) if ".evals/gate.py" in r)
    assert build < intact < gate, (build, intact, gate)


def test_judge_integrity_refuses_a_rewritten_helper_and_a_new_file():
    with tempfile.TemporaryDirectory() as d:
        subprocess.run(["git", "init", "-q", d], check=True)
        helper = Path(d, "packages/core/test/helpers/stub-server.ts")
        helper.parent.mkdir(parents=True)
        helper.write_text("export const ok = true\n")
        subprocess.run(["git", "-C", d, "add", "."], check=True)
        subprocess.run(["git", "-C", d, "-c", "user.email=e@x", "-c", "user.name=e", "commit", "-qm", "base"], check=True)
        run = lambda: subprocess.run(["bash", str(ROOT / "scripts" / "judge-intact.sh")], cwd=d, capture_output=True, text=True)
        assert run().returncode == 0, run().stdout
        helper.write_text("export const ok = false\n")
        r = run()
        assert r.returncode == 1 and "stub-server.ts" in r.stdout, r.stdout
        subprocess.run(["git", "-C", d, "checkout", "-q", "--", "."], check=True)
        Path(d, "evals").mkdir()
        Path(d, "evals/shadow.ts").write_text("x\n")
        r = run()
        assert r.returncode == 1 and "evals/shadow.ts" in r.stdout, r.stdout
if __name__ == "__main__":
    import traceback
    failed = []
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
            except Exception:   # noqa: BLE001 - report every failing test, not only the first
                failed.append(name)
                print(f"FAIL {name}\n{traceback.format_exc()}", file=sys.stderr)
    if failed:
        print(f"{len(failed)} failed: {', '.join(failed)}", file=sys.stderr)
        sys.exit(1)
    print("ok")
