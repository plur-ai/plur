#!/usr/bin/env python3
"""Self-test for check-guarantees.mjs. Run: python3 scripts/test_check_guarantees.py

Needs `pnpm install` first: the checker parses TypeScript with the repository's
own typescript package."""
import json
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

CHECKER = Path(__file__).with_name('check-guarantees.mjs')

SOURCE = '''\
/** Saves the store. A crash never leaves a half-written file. */
export function save() {}

/** Formats a line for display. */
export function show() {}

export class Store {
  /** Two writers never lose an update. */
  write() {}
}
'''

LEAN = '''\
namespace M
theorem save_atomic : True := trivial
end M
'''

PROMISES = '''\
capabilities:
- id: DUR
  promises:
  - id: DUR-1
    text: saves persist
  - id: DUR-2
    text: crashes do not corrupt
'''

INVENTORY = '''\
promises:
  DUR-1: {lean: []}
  DUR-2: {lean: ["PlurSpec/M.lean:save_atomic"]}
anchors:
  "packages/x/src/a.ts#save":
    kind: guarantee
    rule: a crash never leaves a half-written file
    lean: ["PlurSpec/M.lean:save_atomic"]
    promises: [DUR-2]
  "packages/x/src/a.ts#Store.write":
    kind: guarantee
    rule: two writers never lose an update
    tests: [packages/x/test/a.test.ts]
'''


def run(inventory: str = INVENTORY, source: str = SOURCE, extra: dict[str, str] | None = None,
        args: tuple[str, ...] = ()) -> tuple[int, dict]:
    """Run the checker on a small repository; return its exit code and JSON report."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        files = {
            'packages/x/src/a.ts': source,
            'packages/x/test/a.test.ts': 'test("a", () => {})\n',
            'spec/formal/PlurSpec/M.lean': LEAN,
            'evals/promises.yaml': PROMISES,
            'spec/guarantees/x.yaml': inventory,
            **(extra or {}),
        }
        for relative, text in files.items():
            (root / relative).parent.mkdir(parents=True, exist_ok=True)
            (root / relative).write_text(textwrap.dedent(text))
        subprocess.run(['git', 'init', '-q'], cwd=root, check=True)
        subprocess.run(['git', 'add', '-A'], cwd=root, check=True)
        p = subprocess.run(['node', str(CHECKER), '--root', str(root), '--json', *args],
                           capture_output=True, text=True)
        try:
            report = json.loads(p.stdout)
        except json.JSONDecodeError:
            raise AssertionError(f'no JSON report (exit {p.returncode}): {p.stdout}\n{p.stderr}')
        if '--write-skeleton' in args:
            report['written'] = (root / 'spec/guarantees/x.yaml').read_text()
        return p.returncode, report


def problems(report: dict) -> str:
    return '\n'.join(report['problems'])


class Passes(unittest.TestCase):
    def test_complete_inventory(self):
        code, report = run()
        self.assertEqual(report['problems'], [])
        self.assertEqual(code, 0)

    def test_coverage_counts(self):
        _, report = run()
        c = report['coverage']
        self.assertEqual(c['anchors'], 2)
        self.assertEqual(c['guarantees'], 2)
        self.assertEqual(c['proved'], 1)
        self.assertEqual(c['tested_only'], 1)
        self.assertEqual(c['unbacked'], 0)
        self.assertEqual(c['promises'], 2)
        self.assertEqual(c['promises_proved'], 1)

    def test_comment_without_a_hard_rule_needs_no_entry(self):
        # show() has a doc comment, but it states no rule.
        _, report = run()
        self.assertNotIn('show', problems(report))

    def test_named_test_that_exists(self):
        code, report = run(INVENTORY.replace('tests: [packages/x/test/a.test.ts]', 'tests: ["packages/x/test/a.test.ts::a"]'))
        self.assertEqual((code, report['problems']), (0, []))

    def test_named_test_with_an_escaped_quote_in_its_title(self):
        extra = {'packages/x/test/a.test.ts': "it('keeps the writer\\'s update', () => {})\n"}
        code, report = run(INVENTORY.replace('tests: [packages/x/test/a.test.ts]', 'tests: ["packages/x/test/a.test.ts::keeps the writer\'s update"]'), extra=extra)
        self.assertEqual((code, report['problems']), (0, []))

    def test_note_needs_no_backing(self):
        inv = INVENTORY.replace(
            '    kind: guarantee\n    rule: two writers never lose an update\n    tests: [packages/x/test/a.test.ts]\n',
            '    kind: note\n    why: describes the lock, which save() relies on\n')
        code, report = run(inv)
        self.assertEqual((code, report['problems']), (0, []))


class Fails(unittest.TestCase):
    def assertFails(self, inventory=INVENTORY, needle='', **kw):
        code, report = run(inventory, **kw)
        self.assertNotEqual(code, 0, 'expected a failure')
        self.assertIn(needle, problems(report))

    def test_hard_rule_missing_from_inventory(self):
        src = SOURCE + '\n/** Retries at most once. */\nexport function retry() {}\n'
        self.assertFails(needle='packages/x/src/a.ts#retry', source=src)

    def test_entry_for_a_symbol_that_no_longer_exists(self):
        src = SOURCE.replace('export class Store {\n  /** Two writers never lose an update. */\n  write() {}\n}\n', '')
        self.assertFails(needle='packages/x/src/a.ts#Store.write', source=src)

    def test_unknown_lean_theorem(self):
        self.assertFails(INVENTORY.replace('lean: ["PlurSpec/M.lean:save_atomic"]\n    promises',
                                           'lean: ["PlurSpec/M.lean:save_missing"]\n    promises'),
                         needle='save_missing')

    def test_unknown_lean_file(self):
        self.assertFails(INVENTORY.replace('lean: ["PlurSpec/M.lean:save_atomic"]\n    promises',
                                           'lean: ["PlurSpec/Gone.lean:save_atomic"]\n    promises'),
                         needle='PlurSpec/Gone.lean')

    def test_missing_test_file(self):
        self.assertFails(INVENTORY.replace('packages/x/test/a.test.ts', 'packages/x/test/gone.test.ts'),
                         needle='packages/x/test/gone.test.ts')

    def test_named_test_that_does_not_exist(self):
        self.assertFails(INVENTORY.replace('tests: [packages/x/test/a.test.ts]', 'tests: ["packages/x/test/a.test.ts::no such test"]'),
                         needle='no such test')

    def test_unknown_promise(self):
        self.assertFails(INVENTORY.replace('promises: [DUR-2]', 'promises: [DUR-9]'), needle='DUR-9')

    def test_guarantee_without_backing_or_reason(self):
        inv = INVENTORY.replace('    tests: [packages/x/test/a.test.ts]\n', '')
        self.assertFails(inv, needle='packages/x/src/a.ts#Store.write')

    def test_guarantee_with_reason_but_no_backing_passes_and_counts_unbacked(self):
        inv = INVENTORY.replace('    tests: [packages/x/test/a.test.ts]\n',
                                '    none: no test yet; the lock is covered only by review\n')
        code, report = run(inv)
        self.assertEqual((code, report['problems']), (0, []))
        self.assertEqual(report['coverage']['unbacked'], 1)

    def test_promise_missing_from_inventory(self):
        self.assertFails(INVENTORY.replace('  DUR-1: {lean: []}\n', ''), needle='DUR-1')

    def test_unclassified_entry(self):
        inv = INVENTORY.replace('    kind: guarantee\n    rule: two writers never lose an update\n    tests: [packages/x/test/a.test.ts]\n',
                                '    kind: unclassified\n')
        self.assertFails(inv, needle='unclassified')

    def test_anchor_listed_in_two_files(self):
        dup = 'anchors:\n  "packages/x/src/a.ts#save":\n    kind: note\n    why: duplicate\n'
        self.assertFails(needle='packages/x/src/a.ts#save', extra={'spec/guarantees/y.yaml': dup})


class Skeleton(unittest.TestCase):
    def test_write_skeleton_adds_missing_anchors_as_unclassified(self):
        src = SOURCE + '\n/** Retries at most once. */\nexport function retry() {}\n'
        _, report = run(source=src, args=('--write-skeleton',))
        self.assertIn('packages/x/src/a.ts#retry', report['written'])
        self.assertIn('unclassified', report['written'])


if __name__ == '__main__':
    unittest.main()
