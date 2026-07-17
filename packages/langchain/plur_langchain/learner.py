"""
Extract learnings from assistant messages.

Multi-strategy extraction (first match wins):
1. Brain-emoji block fenced by `---` delimiters (highest confidence, fast path)
2. Alternative markers anywhere in the message — `🧠 I learned:`, `I learned:`,
   `Key takeaway[s]:`, `Noted:`, `Correction noted:` — must start a line and be
   followed by a newline; block ends at a blank line, `---`, or EOF.
3. Sentence-level fallback — regex patterns for self-corrections, commitments,
   and factual corrections. Each match gets a confidence score; only sentences
   above the threshold (default 0.7) are returned. Hypotheticals and reasoning
   are explicitly filtered out.

Conservative matching to avoid false positives: markers must be line-anchored
and the captured body is split on lines with bullet/number prefixes stripped.
"""

import re

# --- Strategy 1: Brain-emoji block ---

_BRAIN_PATTERN = re.compile(
    r'---\s*\n\U0001f9e0 I learned:\s*\n([\s\S]*?)(?:\n---|\n\n[^-]|$)'
)

# --- Strategy 2: Alternative markers ---

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

# --- Strategy 3: Sentence-level fallback ---

_SENTENCE_PATTERNS: list[tuple[re.Pattern, float]] = [
    # Self-corrections (0.9)
    (re.compile(r'^I was wrong\b'), 0.9),
    (re.compile(r'^I was mistaken\b'), 0.9),
    (re.compile(r'^I stand corrected\b'), 0.9),
    (re.compile(r'^I had (?:this|it|the|that) backwards\b'), 0.9),
    (re.compile(r'^I need to correct\b'), 0.9),
    (re.compile(r'^Looking at this more carefully'), 0.9),
    (re.compile(r'^Actually,\s+(?:the|it|this)\b'), 0.9),
    (re.compile(r'^Correction:\s'), 0.9),
    (re.compile(r'^I now know that\b'), 0.9),
    (re.compile(r'^I see now that\b'), 0.9),
    (re.compile(r'^I had the .+ (?:backwards|wrong|confused)'), 0.9),
    # Commitments/rules (0.8)
    (re.compile(r'^From now on I will\b'), 0.8),
    (re.compile(r"^I'll make sure to\b"), 0.8),
    (re.compile(r'^I will remember to\b'), 0.8),
    (re.compile(r'^I must never\b'), 0.8),
    (re.compile(r'^I should never\b'), 0.8),
    (re.compile(r'^You should always\b'), 0.8),
    (re.compile(r'^You must never\b'), 0.8),
    (re.compile(r'^You should never\b'), 0.8),
    (re.compile(r'^You must always\b'), 0.8),
    (re.compile(r'^(?:You|I) (?:should|must) (?:always|never)\b'), 0.8),
    # Contextual instructions (0.8) — "When/Before/To/For X, you should/must Y"
    (re.compile(r'^(?:When|Before|To|For|If you) .{5,}(?:you |I )(?:should|must|need to|will need to)\b'), 0.8),
    (re.compile(r'^Always \w'), 0.8),
    # Factual corrections (0.7)
    (re.compile(r'^The (?:correct|actual|right|proper) (?:way|approach|flag|type|path|order|method|return type)\b'), 0.7),
    (re.compile(r'^After checking (?:the source|again|the docs?)\b'), 0.7),
    (re.compile(r'^The version bump requires\b'), 0.7),
    (re.compile(r'^Reviewing the (?:spec|code|source|docs?) again'), 0.7),
]

_HYPOTHETICAL_PREFIX = re.compile(
    r'^(?:If (?:we|you|someone|the team) (?:were|ever|decide)|'
    r'Were we to\b|One (?:approach|could|option)\b|In theory\b|'
    r"I don't see a clear\b|That's an interesting\b|"
    r'If the (?:remote|team|server)\b)'
)

_REASONING_PREFIX = re.compile(
    r'^(?:Spreading activation\b|RRF fusion\b|'
    r'The decay formula\b|In ACT-R\b|BM25 uses\b|'
    r'Good software should\b|APIs should\b|'
    r'Error handling should\b|Memory consolidation\b)'
)

_NEUTRAL_PREFIX = re.compile(
    r'^(?:The current test suite\b|The .+ tool accepts\b|'
    r'Session lifecycle:\b|The five packs\b|'
    r'Looking at the telemetry\b|The hermes plugin\b)'
)


def _extract_lines(block: str) -> list[str]:
    return [
        line.strip()
        for raw_line in block.split('\n')
        if (line := _BULLET_PREFIX.sub('', raw_line).strip())
        and len(line) >= 10
    ]


def _sentence_fallback(text: str) -> list[tuple[str, float]]:
    """Strategy 3: extract sentences matching correction/commitment patterns.

    Returns list of (sentence, confidence) tuples.
    """
    results: list[tuple[str, float]] = []
    for sentence in re.split(r'(?<=[.!?])\s+', text):
        sentence = sentence.strip()
        if len(sentence) < 20:
            continue
        if _HYPOTHETICAL_PREFIX.match(sentence):
            continue
        if _REASONING_PREFIX.match(sentence):
            continue
        if _NEUTRAL_PREFIX.match(sentence):
            continue
        for pattern, confidence in _SENTENCE_PATTERNS:
            if pattern.match(sentence):
                results.append((sentence, confidence))
                break
    return results


def extract_learning_patterns(text: str, min_confidence: float = 0.7) -> list[str]:
    """Extract self-reported learnings from assistant message.

    Multi-strategy extraction:
    1. Brain-emoji block (highest confidence, fast path)
    2. Alternative markers (I learned:, Noted:, etc.)
    3. Sentence-level fallback with confidence scoring

    Args:
        text: Assistant message text
        min_confidence: Minimum confidence threshold for strategy 3 (default 0.7)

    Returns:
        List of learning statements (min 10 chars for strategies 1-2,
        min 20 chars for strategy 3).
    """
    # Strategy 1: brain-emoji block (highest confidence)
    if (match := _BRAIN_PATTERN.search(text)):
        return _extract_lines(match.group(1))

    # Strategy 2: alt markers
    if (match := _ALT_MARKER_PATTERN.search(text)):
        return _extract_lines(match.group(1))

    # Strategy 3: sentence-level fallback
    matches = _sentence_fallback(text)
    return [s for s, conf in matches if conf >= min_confidence]
