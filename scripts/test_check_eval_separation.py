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


def test_source_alone_and_tests_alone_pass():
    assert sep.classify(["packages/core/src/index.ts", "packages/core/test/x.test.ts"])[0] == []
    assert sep.classify(["evals/README.md", "packages/core/test/x.test.ts"])[1] == []


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
