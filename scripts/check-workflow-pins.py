#!/usr/bin/env python3
"""Fail CI when an external action is executable through a mutable reference.

Checked positions are exactly the ones GitHub Actions executes:
  - workflows:      jobs.<id>.uses (reusable workflow) and jobs.<id>.steps[*].uses
  - local actions:  runs.steps[*].uses (composite action.yml / action.yaml)

Each value there must be a local path (`./...`, inside the repository) or
`owner/repo[/path]@<40-hex commit SHA>`. A key named `uses` anywhere else --
an action input under `with:`, an `env:` entry -- is data, not an action, and
is ignored.

Every local reference is followed: `./path` is resolved to its action.yml
(or, for a reusable workflow, the workflow file) and scanned in turn, so an
unpinned action cannot hide behind a local wrapper. Composite actions under
.github/actions/ are scanned even when nothing references them yet.

The file is read with a YAML loader, so merge keys, anchors and aliases,
flow mappings, quoted keys and quoted values all resolve exactly as GitHub
resolves them. The check fails closed: a file that does not parse (including
one whose aliases recurse too deeply), a missing local action, or a missing
YAML parser is an error, never a pass.
"""
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - exercised only on a broken runner
    raise SystemExit('check-workflow-pins: PyYAML is required (python3-yaml); refusing to pass without it')

PINNED = re.compile(r'[\w.-]+/[\w./-]+@[0-9a-f]{40}')


class _Lines(dict):
    """A mapping that remembers the source line of each key."""
    lines: dict


class _LineLoader(yaml.SafeLoader):
    pass


def _construct_map(loader, node):
    data = _Lines()
    data.lines = {}
    yield data
    loader.flatten_mapping(node)  # merge keys (<<) first, with their own marks
    for key_node, _ in node.value:
        try:
            data.lines.setdefault(loader.construct_object(key_node, deep=True), key_node.start_mark.line + 1)
        except TypeError:
            pass  # unhashable key; construct_mapping below reports it
    data.update(loader.construct_mapping(node, deep=True))


_LineLoader.add_constructor('tag:yaml.org,2002:map', _construct_map)


def _line(mapping, key):
    return getattr(mapping, 'lines', {}).get(key, '?')


def _load(path: Path):
    return yaml.load(path.read_text(), Loader=_LineLoader)


def _positions(document, kind):
    """Yield (container, value) for every executable `uses` in a document."""
    if not isinstance(document, dict):
        return
    if kind == 'workflow':
        jobs = document.get('jobs')
        if not isinstance(jobs, dict):
            return
        for job in jobs.values():
            if not isinstance(job, dict):
                continue
            if 'uses' in job:
                yield job, job['uses']
            yield from _steps(job.get('steps'))
    else:
        runs = document.get('runs')
        if isinstance(runs, dict):
            yield from _steps(runs.get('steps'))


def _steps(steps):
    if not isinstance(steps, list):
        return
    for step in steps:
        if isinstance(step, dict) and 'uses' in step:
            yield step, step['uses']


def _local_target(root: Path, reference: str):
    """The file a `./` reference executes, or an error string."""
    target = (root / reference).resolve()
    if not target.is_relative_to(root.resolve()):
        return None, 'local reference leaves the repository'
    if target.is_file() and target.suffix in ('.yml', '.yaml'):
        return (target, 'workflow'), None
    for name in ('action.yml', 'action.yaml'):
        if (target / name).is_file():
            return (target / name, 'action'), None
    return None, 'local action has no action.yml or action.yaml'


def violations(root: Path):
    root = root.resolve()
    queue = [(p, 'workflow') for p in sorted((root / '.github/workflows').glob('*.y*ml'))]
    actions = root / '.github/actions'
    if actions.is_dir():
        queue += [(p, 'action') for p in sorted(actions.glob('**/action.y*ml'))]
    seen = set()
    while queue:
        path, kind = queue.pop(0)
        path = path.resolve()
        if path in seen:
            continue
        seen.add(path)
        name = path.relative_to(root)
        try:
            document = _load(path)
            found = list(_positions(document, kind))
        except (yaml.YAMLError, RecursionError, TypeError) as error:
            reason = 'nesting or aliases recurse too deeply' if isinstance(error, RecursionError) else str(error).splitlines()[0]
            yield f'{name}: cannot parse YAML, so its actions cannot be checked: {reason}'
            continue
        for container, value in found:
            line = _line(container, 'uses')
            if not isinstance(value, str):
                shape = 'a mapping' if isinstance(value, dict) else 'a list' if isinstance(value, list) else type(value).__name__
                yield f'{name}:{line}: `uses` must be a single string reference, not {shape}'
                continue
            if value.startswith('./'):
                target, problem = _local_target(root, value)
                if problem:
                    yield f'{name}:{line}: {problem}: {value}'
                else:
                    queue.append(target)
                continue
            if not PINNED.fullmatch(value):
                yield f'{name}:{line}: external action must use a full commit SHA: {value}'


def main(root: Path) -> int:
    errors = list(violations(root))
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        return 1
    print('All external workflow actions use immutable commit IDs.')
    return 0


if __name__ == '__main__':
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
    sys.exit(main(target))
