"""
Extract learnings from assistant messages.

Two patterns:
1. Brain emoji section with bullet points (semi-explicit)
2. Correction markers (future enhancement)

Conservative matching to avoid false positives.
"""

import re

_BRAIN_PATTERN = re.compile(
    r'---\s*\n\U0001f9e0 I learned:\s*\n([\s\S]*?)(?:\n---|\n\n[^-]|$)'
)


def extract_learning_patterns(text: str) -> list[str]:
    """Extract self-reported learnings from assistant message.

    Returns list of learning statements (min 10 chars each).
    """
    match = _BRAIN_PATTERN.search(text)
    if not match:
        return []

    return [
        line.strip()
        for raw_line in match.group(1).split('\n')
        if (line := re.sub(r'^[-\u2022*]\s*', '', raw_line).strip())
        and len(line) >= 10
    ]
