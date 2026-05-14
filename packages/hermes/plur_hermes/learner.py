"""
Extract learnings from assistant messages.

Multi-strategy extraction (first match wins):
1. Brain-emoji block fenced by `---` delimiters (highest confidence, fast path)
2. Alternative markers anywhere in the message — `🧠 I learned:`, `I learned:`,
   `Key takeaway[s]:`, `Noted:`, `Correction noted:` — must start a line and be
   followed by a newline; block ends at a blank line, `---`, or EOF.
3. Sentence-level fallback — when no marker is found, scan for sentences that
   match correction/preference patterns: "Correction: ...", "The correct way is ...",
   "I/We should/must/always/never/prefer/avoid ...".

Conservative matching to avoid false positives: markers must be line-anchored
and the captured body is split on lines with bullet/number prefixes stripped.
Sentence fallback requires "I" or "We" subject or explicit "Correction:" prefix
to keep false-positive rate below 15%.
"""

import re

_BRAIN_PATTERN = re.compile(
    r'---\s*\n\U0001f9e0 I learned:\s*\n([\s\S]*?)(?:\n---|\n\n[^-]|$)'
)

_ALT_MARKERS = (
    r'\U0001f9e0 I learned:',
    r'I learned:',
    r'Key takeaways?:',
    r'Noted:',
    r'Correction noted:',
)
_ALT_MARKER_PATTERN = re.compile(
    r'(?:^|\n)\s*(?:' + '|'.join(_ALT_MARKERS) + r')[ \t]*\n'
    r'([\s\S]*?)(?:\n[ \t]*\n|\n---|$)'
)

# Sentence-level fallback: conservative patterns that strongly signal a correction
# or stated preference. Minimum 25 chars to filter noise.
# Anchor: line start OR after ". " (sentence boundary within a paragraph).
_SENTENCE_PATTERN = re.compile(
    r'(?:(?:^|\n)[ \t]*|(?<=\. ))'
    r'('
    r'Correction:\s+\S[^\n]{14,}'
    r'|The (?:correct|proper|best) way (?:is|to) \S[^\n]{9,}'
    r'|(?:I|We) (?:should|must|will|prefer|avoid|always|never) \S[^\n]{9,}'
    r')',
    re.IGNORECASE,
)

_BULLET_PREFIX = re.compile(r'^[-*•]\s+|^\d+[.)]\s+')


def _extract_lines(block: str) -> list[str]:
    return [
        line.strip()
        for raw_line in block.split('\n')
        if (line := _BULLET_PREFIX.sub('', raw_line).strip())
        and len(line) >= 10
    ]


def extract_learning_patterns(text: str) -> list[str]:
    """Extract self-reported learnings from assistant message.

    Returns list of learning statements (min 10 chars each).
    """
    if (match := _BRAIN_PATTERN.search(text)):
        return _extract_lines(match.group(1))

    if (match := _ALT_MARKER_PATTERN.search(text)):
        return _extract_lines(match.group(1))

    # Sentence-level fallback: no marker found, scan for correction/preference sentences
    sentences = _SENTENCE_PATTERN.findall(text)
    return [s.strip() for s in sentences if len(s.strip()) >= 25]
