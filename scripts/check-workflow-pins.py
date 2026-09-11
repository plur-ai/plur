#!/usr/bin/env python3
"""Fail CI when an external action is executable through a mutable reference."""
import re
from pathlib import Path


def violations(root: Path):
    for workflow in sorted((root / '.github/workflows').glob('*.y*ml')):
        for number, line in enumerate(workflow.read_text().splitlines(), 1):
            match = re.match(r'\s*(?:-\s*)?uses:\s*([^\s#]+)', line)
            if not match:
                continue
            reference = match[1]
            if reference.startswith('./'):
                continue
            if not re.fullmatch(r'[\w.-]+/[\w./-]+@[0-9a-f]{40}', reference):
                yield f'{workflow.relative_to(root)}:{number}: external action must use a full commit SHA: {reference}'


if __name__ == '__main__':
    errors = list(violations(Path(__file__).resolve().parents[1]))
    if errors:
        raise SystemExit('\n'.join(errors))
    print('All external workflow actions use immutable commit IDs.')
