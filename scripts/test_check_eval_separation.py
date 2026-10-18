"""check-eval-separation.py: an eval and the code it judges never change in one pull request."""
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("sep", Path(__file__).with_name("check-eval-separation.py"))
sep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sep)


def test_eval_and_source_together_are_caught():
    judge, code = sep.classify(["evals/recall/test_promise_REC4_x.test.ts", "packages/core/src/index.ts"])
    assert judge and code


def test_mutants_gold_promises_baseline_and_tools_are_judge_files():
    for p in ["evals/mutants/REC-4-1.patch", "evals/gold/recall-v1/corpus.yaml", "evals/promises.yaml",
              "evals/baseline.json", ".evals/run.py"]:
        assert sep.classify([p])[0] == [p], p


def test_helpers_config_and_shared_fixtures_are_judge_files():
    # audit E-03: these were outside the judge and could change with the source they judge
    for p in ["evals/helpers/quality.ts", "evals/vitest.config.ts", "evals/evals.yaml", "evals/README.md",
              "packages/core/test/helpers/stub-server.ts", ".github/workflows/evals.yml", ".github/CODEOWNERS",
              "scripts/check-eval-separation.py"]:
        assert sep.classify([p])[0] == [p], p
    judge, code = sep.classify(["evals/evals.yaml", "packages/core/src/index.ts"])
    assert judge and code


def test_root_package_json_is_a_judge_file():
    # second audit R-02: `pnpm evals:gate` was whatever package.json said it was
    judge, code = sep.classify(["package.json", "packages/core/src/index.ts"])
    assert judge == ["package.json"] and code, (judge, code)
    # a package's own manifest is not the root one
    assert sep.classify(["packages/core/package.json"])[0] == []


def _owned(path: str, patterns: list[str]) -> bool:
    import re
    for pat in patterns:
        rx = re.escape(pat.lstrip("/")).replace(r"\*", "[^/]*")
        if re.match(rx + ("" if pat.endswith("/") else "$"), path):
            return True
    return False


def test_codeowners_covers_every_kind_of_judge_file():
    lines = (Path(__file__).resolve().parent.parent / ".github" / "CODEOWNERS").read_text().splitlines()
    patterns = [ln.split()[0] for ln in lines if ln.strip() and not ln.startswith("#")]
    for p in ["package.json", "evals/promises.yaml", ".evals/gate.py", "scripts/check-eval-separation.py",
              "scripts/test_check_eval_separation.py", "scripts/test_evals_harness.py", "scripts/evals-local.sh",
              "packages/core/test/helpers/stub-server.ts", ".github/workflows/evals.yml", ".github/CODEOWNERS"]:
        assert sep.classify([p])[0] == [p], p
        assert _owned(p, patterns), f"{p} is a judge file but no CODEOWNERS line covers it"


def test_source_alone_and_tests_alone_pass():
    assert sep.classify(["packages/core/src/index.ts", "packages/core/test/x.test.ts"])[0] == []
    assert sep.classify(["evals/README.md", "packages/core/test/x.test.ts"])[1] == []


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
