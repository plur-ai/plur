---
name: geo-visibility
description: Measure how often AI models mention your brand. Share-of-Voice scoring, per-model mention rates, cited-source analysis, and a content backlog of exactly what to write next.
version: 0.1.0
metadata:
  hermes:
    tags: [geo, ai-visibility, seo, share-of-voice, brand-monitoring, content-strategy]
    category: marketing
    requires_toolsets: []
---

# GEO Visibility Audit

Measure your brand's presence inside AI-generated answers. Find out which models mention you, which queries you're absent from, which competitor names appear instead, and which domains the models are citing — then turn that into a prioritized content backlog.

**GEO (Generative Engine Optimization)** = being cited by AI engines, not ranked by them. The models don't sort pages; they choose sources. This skill measures whether you are one of those sources.

## When to Use

- You want to know if AI models mention your product when users ask relevant questions
- You are benchmarking AI visibility before and after a content campaign
- You want to see which domains AI models cite for your topic (and optimize those surfaces)
- You want to know which queries you are invisible for — the content backlog

## What You Get

| Output | Description |
|---|---|
| **Share of Voice (SoV)** | % of prompt×model pairs where your brand is mentioned |
| **Per-model mention rate** | Which models know about you (often varies wildly) |
| **Content backlog** | Every prompt where you are absent across ALL models — exactly what to write |
| **Citation map** | Which domains AI models cite when answering your queries |
| **Competitor co-occurrence** | Which brands appear alongside or instead of yours |
| **Position score** | Where in the answer your first mention appears (earlier = stronger recall) |

## Prerequisites

```bash
# One-time: OpenRouter account (openrouter.ai) — one API key across every frontier model
export OPENROUTER_API_KEY=sk-or-...

# One-time: Python + pyyaml
pip install pyyaml
```

No other dependencies. The script uses Python's built-in `urllib` — no `requests` needed.

## Quickstart

### Step 1: Get the script and prompt file

Both ship alongside this document, in the same directory:

```
geo-visibility/
├── SKILL.md            ← you are here
├── geo_visibility.py   ← the scanner
└── geo_prompts.yaml    ← prompts, brand patterns, competitors, model list
```

Copy the two files into a working directory and run from there — the script
writes `results/` relative to the current directory:

```bash
mkdir -p ~/geo-audit && cd ~/geo-audit
cp /path/to/geo-visibility/geo_visibility.py .
cp /path/to/geo-visibility/geo_prompts.yaml .
python3 geo_visibility.py --help
```

### Step 2: Customize the prompt file

Edit `geo_prompts.yaml` — this is the core intellectual work of a GEO audit:

```yaml
brand:
  name: YourBrand
  patterns: ["yourbrand.com", "yourbrand-ai", "@yourbrand"]
  description: what your product actually is   # used only by --judge
  domains: ["yourbrand.com", "docs.yourbrand.com"]   # marked "⬅ us" in the citation map

competitors:
  - Competitor1
  - Competitor2
  - name: AmbiguousName          # use explicit patterns when the name is a common word
    patterns:
      - 'AmbiguousName\.(com|ai)'
      - 'AmbiguousName (Inc|Labs)\b'

# Illustrative only — verify against OpenRouter's live catalogue before each run:
#   curl -s https://openrouter.ai/api/v1/models | \
#     python3 -c "import json,sys;[print(m['id']) for m in json.load(sys.stdin)['data']]" | sort
models:
  - openai/gpt-5.2
  - anthropic/claude-sonnet-5
  - google/gemini-3.1-pro-preview
  - meta-llama/llama-4-maverick
  - deepseek/deepseek-chat-v3.1

prompts:
  category:
    - What are the best tools for [your category]?
    - What is the best open-source [your category] solution?

  problem:
    - My [problem your product solves]. How do I fix that?
    - How do I [job your product does]?

  comparison:
    - What are the best alternatives to [top competitor]?
    - [Competitor1] vs [Competitor2] — which should I use?

  brand:
    - What is [YourBrand]?
    - How does [YourBrand] compare to [Competitor]?
```

**Prompt design is strategy.** Write the exact queries your buyers type. Each prompt is a measurement point — the model either knows you or it doesn't.

### Step 3: Run parametric scan (what models have baked into training)

```bash
python3 geo_visibility.py
```

Progress prints as each model×prompt pair is scored. Typical run with the shipped set: 5 models × 50 prompts = 250 calls, ~8 minutes.

### Step 4: Run grounded scan (what live retrieval cites)

```bash
python3 geo_visibility.py --mode grounded
```

This appends `:online` to the model IDs via OpenRouter, activating real-time web search. The grounded scan is more expensive but reveals the **citation map** — which domains appear in answers. This tells you where to publish (GitHub, Reddit, npm, docs sites, or directories like AlternativeTo).

### Step 5: Read the summary

The script writes a Markdown summary to `results/summary-<timestamp>.md`. The
sample below is a real run from 2026-08-03 over a 30-prompt subset (`--groups`),
so it names the models current at that date rather than the defaults above, and
its scale is smaller than a full 50-prompt sweep. The per-model table is
truncated to three of the five rows:

```markdown
# GEO visibility — run 20260803T031118Z (grounded mode)

- Prompt×model answers scored: 148 of 150 (errors excluded)
- Share of Voice (YourBrand mentioned): 24.0%

## Per-model mention rate
| Model                        | Mentioned | Rate |
|---|---|---|
| openai/gpt-4o                | 8/30      | 27%  |
| anthropic/claude-sonnet-4    | 12/30     | 40%  |
| google/gemini-2.5-pro        | 2/30      | 7%   |
| …                            | …         | …    |

## Co-occurrence — who the LLMs name
| Brand        | Appearances |
|---|---|
| YourBrand    | 36          |
| Competitor1  | 28          |
| Competitor2  | 19          |

## Sources cited (where to optimize)
| Domain          | Times cited |
|---|---|
| github.com      | 245         |
| yourbrand.com   | 84 ⬅ us    |
| dev.to          | 25          |
| npm             | 21          |

## Content backlog — 8 prompts where YourBrand is ABSENT in every model
- [ ] What are the best alternatives to Competitor1?
- [ ] How do I solve [specific problem]?
```

### Step 6: Add LLM-judge pass (optional, costs extra)

```bash
python3 geo_visibility.py --judge
```

For each answer that mentions your brand, an LLM judge evaluates:
- **accuracy** (0.0–1.0): are the facts about your product correct?
- **sentiment**: positive / neutral / negative

Useful for catching "mentioned but described wrongly" — a silent brand damage pattern.

### What a run costs

The scan is `prompts × models` chat completions, so cost scales with your prompt set. For the shipped 50-prompt set across 5 models:

| Mode | Calls | Notes |
|---|---|---|
| `parametric` (default) | 250 | Short answers, no retrieval. The cheap baseline. |
| `--mode grounded` | 250 | Adds `:online`, which bills a web-search surcharge per call on top of tokens — materially more than parametric. |
| `--judge` | + up to 250 | One extra judge call per answer that mentions the brand, on the smaller `judge_model`. |

A full weekly cycle (parametric + grounded + judge) is therefore roughly 500–750 calls. Exact spend depends entirely on which models you pick and OpenRouter's current pricing, which moves — **price it before a wide sweep** rather than trusting a figure checked into a document:

```bash
curl -s https://openrouter.ai/api/v1/models | python3 -c "
import json,sys
want={'openai/gpt-5.2','anthropic/claude-sonnet-5','google/gemini-3.1-pro-preview'}
for m in json.load(sys.stdin)['data']:
    if m['id'] in want: print(m['id'], m['pricing'])"
```

Start with `--models` set to one cheap model and a trimmed prompt set to confirm your brand patterns match before spending on the full grid.

## Reading the Results

### Share of Voice (SoV)

Your headline number. The % of all prompt×model pairs where you were mentioned.

| SoV | Interpretation |
|---|---|
| 0–5% | Not present in AI answers for your topic |
| 5–20% | Emerging recall — recognized for some queries |
| 20–50% | Solid presence — gaps remain in comparison queries |
| 50%+ | Strong recall across the category |

Most products in growing categories start at 0–10%. The content backlog tells you how to move it.

### Per-model variance matters

Frontier models often have very different recall for the same brand, and the gaps are the actionable part — they point to channel-specific work rather than generic "make more content".

Two patterns we have observed across our own weekly runs, offered as hypotheses to test rather than as claims about how these systems work internally:

- Low **Gemini** recall has tracked with an absence of YouTube content and weak presence on Google-indexed properties.
- Low **Claude** recall has tracked with thin coverage on the sources its web search surfaces.

Neither vendor publishes its retrieval architecture, so treat these as correlations from one brand's data. The useful move is to check whether the same correlation holds for you: change one channel, re-run, and see whether that model's rate moves.

### The citation map is your SEO roadmap

In grounded mode, every cited domain is a surface where you could publish:
- **GitHub** dominant → strengthen README and Discussions
- **npm/PyPI** present → optimize package metadata
- **Reddit** present → ensure your brand appears in key threads
- **Roundup sites** present → get listed on AlternativeTo, SaaSHub, StackShare
- **YouTube** present → high value for Gemini/AI Overviews specifically

### Content backlog = your editorial calendar

Every prompt in the `absent` list is a query where the model could not name you across any tested model. These are not hypothetical gaps — they are live answers your competitors' names appear in. Write one piece of content targeting each absent prompt, optimize it for the citation signals in the citation map, and re-run the scan in 4–8 weeks.

## Prompt Group Design

Organize prompts into groups for cleaner reporting. Recommended groups:

| Group | Purpose |
|---|---|
| `category` | "What is the best X?" — category ownership |
| `problem` | "I have problem Y" — pain-point queries |
| `comparison` | "X vs Y vs Z" — highest SoV gap risk |
| `runtime` | "How do I add X to [specific tool]?" — integration queries |
| `definitional` | "What is X?" — concept ownership |
| `brand` | Direct brand queries — baseline sanity check |

Run `--groups comparison` to isolate one group:

```bash
python3 geo_visibility.py --groups comparison
```

## Cadence Recommendation

| Frequency | Mode | Purpose |
|---|---|---|
| Weekly | parametric | Track SoV trend; catch fast-moving changes |
| Monthly | grounded | Update citation map; measure off-domain ROI |
| After campaigns | both | Measure lift from specific content investments |

The script appends every run to `results/history.jsonl` — a permanent record. SoV trend over time is the primary success metric.

## Full CLI Reference

```
python3 geo_visibility.py [OPTIONS]

  --prompts FILE     Prompt YAML file (default: geo_prompts.yaml)
  --out DIR          Results directory (default: results/)
  --mode MODE        parametric or grounded (default: parametric)
  --models M [M...]  Override model list from YAML
  --judge            Add accuracy/sentiment judge pass per answer
  --sleep SECS       Delay between API calls (default: 1.0)
  --groups G [G...]  Run only named prompt groups
```

## Files Written

```
results/
  run-<timestamp>.jsonl      Raw scored rows (one JSON per prompt×model pair)
  summary-<timestamp>.md     Human-readable report with SoV, backlog, citation map
  history.jsonl              Appended from every run — your longitudinal record
```

## Related Skills

- **[plur-memory](../plur-memory/SKILL.md)** — run the scan weekly via nightshift; PLUR stores findings as engrams and injects them into future sessions so your agent always has current SoV context without re-reading reports. Pair with geo-visibility to persist your SoV baseline, which models know you, and which content gaps you have already addressed.

## Built With

This methodology was developed and battle-tested by the [PLUR](https://plur.ai) team as part of the PLUR agent coordination framework — an open-source, local-first memory layer for AI agents. The scan has been running weekly since 2026-06-01 across five frontier models and a 50-prompt set — 250 pairs per run, of which the scored count varies as errored calls are excluded.
