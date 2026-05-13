"""
Extract learnings from assistant messages.

Multi-strategy extraction (first match wins for S1/S2; S3 is sentence-level fallback):
1. Brain-emoji block fenced by `---` delimiters (confidence 1.0)
2. Alternative markers anywhere in the message (confidence 0.9)
3. Sentence-level patterns — self-corrections, discoveries, first-person commitments
   (confidence 0.75–0.85, filtered at >= 0.7 before returning)
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

_BULLET_PREFIX = re.compile(r'^[-*•]\s+|^\d+[.)]\s+')

_SENTENCE_BREAK = re.compile(r'(?<=[.!?])\s+(?=[A-Z])')

_S3_PATTERNS: list[tuple[re.Pattern, float]] = [
    # Self-corrections: explicit acknowledgment of error
    (re.compile(r'\bI was (wrong|mistaken|incorrect)\b', re.IGNORECASE), 0.85),
    (re.compile(r'\bI (stand|was) corrected\b', re.IGNORECASE), 0.85),
    (re.compile(r'\bI had\b.{0,60}\b(wrong|backwards|backward|reversed)\b', re.IGNORECASE), 0.85),
    (re.compile(r'\bI need to correct\b', re.IGNORECASE), 0.85),
    # "Correction: ..." prefix (distinct from "Correction noted:" which is Strategy 2)
    (re.compile(r'^Correction(?! noted):\s', re.IGNORECASE), 0.85),
    # Discovery: realisation or newly-confirmed fact
    (re.compile(r'\bI (now know|see now|now see)\b', re.IGNORECASE), 0.75),
    (re.compile(r'\bI see (now )?(that|why|how)\b', re.IGNORECASE), 0.75),
    (re.compile(r'^I missed\b', re.IGNORECASE), 0.75),
    (re.compile(r'\bLooking at this more carefully\b', re.IGNORECASE), 0.75),
    (re.compile(r'^After checking\b', re.IGNORECASE), 0.80),
    (re.compile(r'^Reviewing the (spec|code|source|docs)\b', re.IGNORECASE), 0.75),
    (re.compile(r'^Actually, the\b', re.IGNORECASE), 0.80),
    (re.compile(r'^The correct (way|approach|path|flag|format|answer|pattern)\b', re.IGNORECASE), 0.80),
    (re.compile(r'^The actual \w+', re.IGNORECASE), 0.80),
    # First-person forward commitments (I will/should/must never/always/remember)
    (re.compile(r'^From now on I\b', re.IGNORECASE), 0.75),
    (re.compile(r'^I (should|must|will) (never|always|remember|make sure|ensure)\b', re.IGNORECASE), 0.75),
    (re.compile(r"^I'?ll? (make sure|remember|always|never)\b", re.IGNORECASE), 0.75),
]

_MIN_SENTENCE_LEN = 10


def _extract_lines(block: str) -> list[str]:
    return [
        line.strip()
        for raw_line in block.split('\n')
        if (line := _BULLET_PREFIX.sub('', raw_line).strip())
        and len(line) >= _MIN_SENTENCE_LEN
    ]


def _match_strategy3(sentence: str) -> float:
    """Return confidence if sentence matches a Strategy 3 pattern, else 0.0."""
    for pattern, confidence in _S3_PATTERNS:
        if pattern.search(sentence):
            return confidence
    return 0.0


def extract_learning_patterns(text: str) -> list[tuple[str, float]]:
    """Extract self-reported learnings from assistant message.

    Returns (statement, confidence) pairs with confidence >= 0.7.
    Strategy 1 (brain block) → 1.0, Strategy 2 (alt markers) → 0.9,
    Strategy 3 (sentence-level) → 0.75–0.85. First match wins for S1/S2.
    """
    if (match := _BRAIN_PATTERN.search(text)):
        return [(line, 1.0) for line in _extract_lines(match.group(1))]

    if (match := _ALT_MARKER_PATTERN.search(text)):
        return [(line, 0.9) for line in _extract_lines(match.group(1))]

    results: list[tuple[str, float]] = []
    for sentence in _SENTENCE_BREAK.split(text):
        sentence = sentence.strip()
        if len(sentence) < _MIN_SENTENCE_LEN:
            continue
        confidence = _match_strategy3(sentence)
        if confidence >= 0.7:
            results.append((sentence, confidence))
    return results
