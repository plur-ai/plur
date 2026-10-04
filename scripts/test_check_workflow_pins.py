#!/usr/bin/env python3
"""Self-test for check-workflow-pins.py. Run: python3 scripts/test_check_workflow_pins.py"""
import importlib.util
import tempfile
import textwrap
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location('check_workflow_pins', Path(__file__).with_name('check-workflow-pins.py'))
pins = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pins)

SHA = '11d5960a326750d5838078e36cf38b85af677262'


def check(workflow: str, files: dict[str, str] | None = None) -> list[str]:
    """Run the checker on a repository holding one workflow plus `files`."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / '.github/workflows').mkdir(parents=True)
        (root / '.github/workflows/w.yml').write_text(textwrap.dedent(workflow))
        for relative, text in (files or {}).items():
            (root / relative).parent.mkdir(parents=True, exist_ok=True)
            (root / relative).write_text(textwrap.dedent(text))
        return list(pins.violations(root))


def job(steps: str) -> str:
    return 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n' + textwrap.indent(textwrap.dedent(steps), '      ')


def composite(steps: str) -> str:
    return 'runs:\n  using: composite\n  steps:\n' + textwrap.indent(textwrap.dedent(steps), '    ')


class Rejects(unittest.TestCase):
    def test_plain_tag(self):
        self.assertEqual(len(check(job('- uses: actions/checkout@v4\n'))), 1)

    def test_flow_mapping(self):
        self.assertEqual(len(check(job('- {uses: actions/checkout@v4}\n'))), 1)

    def test_quoted_key(self):
        self.assertEqual(len(check(job('- "uses": actions/checkout@v4\n'))), 1)

    def test_space_before_colon(self):
        self.assertEqual(len(check(job('- uses : actions/checkout@v4\n'))), 1)

    def test_branch_and_short_sha(self):
        self.assertEqual(len(check(job('- uses: actions/checkout@main\n- uses: actions/checkout@11d5960\n'))), 2)

    def test_forty_one_hex_digits(self):
        self.assertEqual(len(check(job(f'- uses: actions/checkout@{SHA}0\n'))), 1)

    def test_trailing_junk_after_the_sha(self):
        self.assertEqual(len(check(job(f"- uses: 'actions/checkout@{SHA} extra'\n"))), 1)

    def test_docker_reference(self):
        self.assertEqual(len(check(job('- uses: docker://alpine:3.20\n'))), 1)

    def test_list_valued_uses(self):
        self.assertIn('not a list', check(job(f'- uses: [actions/checkout@{SHA}]\n'))[0])

    def test_mapping_valued_uses(self):
        self.assertIn('not a mapping', check(job('- uses: {ref: actions/checkout@v4}\n'))[0])

    def test_parent_relative_is_not_a_local_action(self):
        # GitHub treats only `./` as local; `../x` is an unpinned reference.
        found = check(job('- uses: ../elsewhere\n'))
        self.assertEqual(len(found), 1)
        self.assertIn('full commit SHA', found[0])

    def test_local_reference_that_leaves_the_repository(self):
        self.assertIn('leaves the repository', check(job('- uses: ./../elsewhere\n'))[0])

    def test_missing_local_action(self):
        self.assertIn('no action.yml', check(job('- uses: ./tools/missing\n'))[0])

    def test_job_level_reusable_workflow(self):
        workflow = 'on: push\njobs:\n  a:\n    uses: owner/repo/.github/workflows/x.yml@v1\n'
        self.assertEqual(len(check(workflow)), 1)

    def test_unreferenced_composite_action_under_github_actions(self):
        found = check(job(f'- uses: actions/checkout@{SHA}\n'),
                      {'.github/actions/local/action.yml': composite('- uses: actions/setup-node@v4\n')})
        self.assertEqual(len(found), 1)

    def test_local_action_outside_github_actions_is_followed(self):
        found = check(job('- uses: ./tools/act\n'), {'tools/act/action.yml': composite('- uses: a/b@v1\n')})
        self.assertEqual(len(found), 1)
        self.assertIn('tools/act/action.yml', found[0])

    def test_local_reusable_workflow_is_followed(self):
        workflow = 'on: push\njobs:\n  a:\n    uses: ./tools/reusable.yml\n'
        found = check(workflow, {'tools/reusable.yml': job('- uses: a/b@v1\n')})
        self.assertEqual(len(found), 1)

    def test_merge_key_supplies_uses(self):
        workflow = ('on: push\nx-step: &step {uses: actions/checkout@v4}\n'
                    'jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - <<: *step\n        name: merged\n')
        self.assertEqual(len(check(workflow)), 1)

    def test_alias_supplies_uses(self):
        workflow = ('on: push\nx-ref: &ref actions/checkout@v4\n'
                    'jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: *ref\n')
        self.assertEqual(len(check(workflow)), 1)

    def test_unparseable_file_fails_closed(self):
        self.assertIn('cannot parse', check('jobs: [\n')[0])

    def test_recursion_fails_closed(self):
        self.assertIn('recurse too deeply', check('jobs: ' + '[' * 3000 + ']' * 3000 + '\n')[0])

    def test_self_referencing_alias_fails_closed(self):
        # The step list contains itself. It must be reported, not hang the
        # check, crash it, or pass.
        found = check('on: push\njobs:\n  a:\n    runs-on: x\n    steps: &s [*s]\n')
        self.assertEqual(len(found), 1)
        self.assertIn('cannot parse', found[0])

    def test_reports_line_number(self):
        self.assertIn('w.yml:7:', check(job(f'- uses: actions/checkout@{SHA}\n- uses: actions/checkout@v4\n'))[0])


class Accepts(unittest.TestCase):
    def test_pinned(self):
        self.assertEqual(check(job(f'- uses: actions/checkout@{SHA} # v4.4.0\n')), [])

    def test_quoted_pinned_value(self):
        self.assertEqual(check(job(f"- uses: 'actions/checkout@{SHA}'\n- uses: \"actions/checkout@{SHA}\"\n")), [])

    def test_local_action_with_pinned_steps(self):
        found = check(job('- uses: ./.github/actions/local\n'),
                      {'.github/actions/local/action.yml': composite(f'- uses: actions/setup-node@{SHA}\n')})
        self.assertEqual(found, [])

    def test_pinned_reusable_workflow(self):
        workflow = f'on: push\njobs:\n  a:\n    uses: owner/repo/.github/workflows/x.yml@{SHA}\n'
        self.assertEqual(check(workflow), [])

    def test_uses_as_an_action_input_is_not_an_action(self):
        self.assertEqual(check(job(f'- uses: actions/checkout@{SHA}\n  with: {{uses: some/thing@v1}}\n')), [])

    def test_uses_in_env_or_run_text_is_not_an_action(self):
        self.assertEqual(check(job("- run: 'echo uses: actions/checkout@v4'\n  env: {uses: a/b@v1}\n")), [])


if __name__ == '__main__':
    unittest.main()
