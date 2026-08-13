#!/usr/bin/env python3
"""
GEO visibility monitor — measure what major LLMs say about your brand (and competitors).

Closes the GEO feedback loop:
  * mention rate / Share-of-Voice per model and overall
  * position of the first brand mention in the answer (earlier = stronger)
  * competitor co-occurrence (who LLMs name instead of / alongside you)
  * CITED SOURCES (grounded mode) aggregated by domain = where to optimize
  * optional LLM-judge pass for accuracy + sentiment
  * the prompts where the brand is ABSENT in every model = the content backlog

Modes:
  parametric  - pure model recall (what's baked into training data)
  grounded    - web-grounded recall via OpenRouter ':online' (what live retrieval cites)

Usage:
  export OPENROUTER_API_KEY=sk-or-...
  python3 geo_visibility.py                        # parametric, default prompts/models
  python3 geo_visibility.py --mode grounded        # web-grounded; captures cited sources
  python3 geo_visibility.py --judge                # + accuracy/sentiment (uses judge_model)
  python3 geo_visibility.py --models openai/gpt-5.2 anthropic/claude-sonnet-5

Dependencies: pyyaml only (HTTP goes through urllib — no requests).

Cost: one run is len(prompts) x len(models) chat completions. With the shipped
50-prompt set and 5 models that is 250 calls; --mode grounded and --judge each
add roughly one more call per pair. See the SKILL.md cost table before running
a wide sweep — grounded calls are materially more expensive than parametric ones.
"""
import argparse
import json
import os
import re
import signal
import sys
import time
from datetime import datetime, timezone
import urllib.request
import urllib.error


class _CallTimeout(Exception):
    """Raised by the SIGALRM backstop when a request exceeds its wall-clock budget."""


def _alarm_handler(signum, frame):
    raise _CallTimeout()

try:
    import yaml
except ImportError:
    sys.exit("Missing dependency: pip install pyyaml")

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
HERE = os.path.dirname(os.path.abspath(__file__))
URL_RE = re.compile(r"https?://[^\s)\]\"'>}]+")


def _domain(u):
    m = re.match(r"https?://([^/]+)", u)
    d = m.group(1).lower() if m else u
    return d[4:] if d.startswith("www.") else d


def _extract_sources(msg, data, content):
    """Collect cited URLs from OpenRouter web-search annotations + top-level citations + inline links."""
    urls = []
    for a in (msg.get("annotations") or []):
        if a.get("type") == "url_citation":
            u = (a.get("url_citation") or {}).get("url")
            if u:
                urls.append(u)
    for u in (data.get("citations") or []):
        if isinstance(u, str):
            urls.append(u)
        elif isinstance(u, dict) and u.get("url"):
            urls.append(u["url"])
    urls += URL_RE.findall(content or "")
    seen, out = set(), []
    for u in urls:
        u = u.rstrip(".,);")
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def call_openrouter(model, prompt, api_key, timeout=90, retries=3):
    """Return (answer_text, sources, error). On success error is None; on failure answer is None.

    A SIGALRM backstop (timeout + 15s) hard-interrupts the request. The urllib
    socket timeout alone is not enough: OpenRouter can hold a connection open with
    keepalive trickle so no single read exceeds the socket timeout, and the call
    hangs forever. That silent hang is what froze the weekly cadence in July — a
    hung model call blocks the whole run with no error row and no crash. The alarm
    fires regardless of socket activity. Main-thread / Unix only (fine here).
    """
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": 800,
    }).encode()
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/plur-ai/plur",
        "X-Title": "GEO Visibility Monitor",
    }
    have_alarm = hasattr(signal, "SIGALRM")
    if have_alarm:
        signal.signal(signal.SIGALRM, _alarm_handler)
    last = None
    for attempt in range(retries):
        try:
            if have_alarm:
                signal.alarm(timeout + 15)
            req = urllib.request.Request(OPENROUTER_URL, data=body, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode())
            msg = data["choices"][0]["message"]
            content = msg.get("content") or ""
            return content, _extract_sources(msg, data, content), None
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}: {e.read().decode()[:200]}"
        except _CallTimeout:
            last = f"hard-timeout after {timeout + 15}s (hung connection)"
        except Exception as e:  # noqa: BLE001 — log and retry any transient failure
            last = str(e)
        finally:
            if have_alarm:
                signal.alarm(0)
        time.sleep(2 * (attempt + 1))
    return None, [], last


def first_brand_index(text, patterns, name=None):
    """Index of the first brand mention, or -1.

    `patterns` are matched as plain substrings; `name`, when given, is matched on
    a WORD BOUNDARY so a short brand does not hit inside longer words (the
    original motivation: "plur" must not match "plural"). Both come from the
    config — nothing about a specific brand is baked in here.
    """
    low = text.lower()
    idxs = [low.find(p.lower()) for p in patterns if low.find(p.lower()) >= 0]
    if name:
        idxs += [m.start() for m in re.finditer(rf"\b{re.escape(name)}\b", text, re.IGNORECASE)]
    return min(idxs) if idxs else -1


def load_competitors(raw):
    """Normalize the config's `competitors` into {name: [regex, ...]}.

    An entry is either a bare name (matched on a word boundary) or a mapping with
    explicit `patterns`. Patterns exist for the Engram case: the company shares its
    name with the common noun "engram", which appears in nearly every answer we
    score, so matching the bare name counts a hit on every row. Only unambiguous
    company markers (its domains, its funding) can be matched in free text.
    """
    competitors = {}
    for entry in raw:
        if isinstance(entry, dict):
            name = entry["name"]
            patterns = entry.get("patterns") or [rf"\b{re.escape(name)}\b"]
        else:
            name, patterns = entry, [rf"\b{re.escape(entry)}\b"]
        competitors[name] = patterns
    return competitors


def competitor_hits(text, competitors):
    return [
        name
        for name, patterns in competitors.items()
        if any(re.search(p, text, re.IGNORECASE) for p in patterns)
    ]


JUDGE_PROMPT = (
    "You are auditing an AI assistant's answer for how it treats a product called {brand}"
    "{descr}.\n\n"
    'ANSWER:\n"""\n{answer}\n"""\n\n'
    "Respond with ONLY a JSON object: "
    '{{"mentioned": true|false, "accuracy": 0.0-1.0, "sentiment": "pos"|"neu"|"neg", "note": "<=15 words"}}. '
    "accuracy = factual correctness of {brand}-related statements (1.0 mentioned+correct, "
    "0.0 mentioned+wrong, 0.5 if {brand} is not mentioned)."
)


def judge(answer, judge_model, api_key, brand="the brand", description=None):
    descr = f" ({description})" if description else ""
    prompt = JUDGE_PROMPT.format(answer=answer, brand=brand, descr=descr)
    out, _src, err = call_openrouter(judge_model, prompt, api_key)
    if err or not out:
        return {"note": f"judge_err:{err}"}
    m = re.search(r"\{.*\}", out, re.DOTALL)
    try:
        return json.loads(m.group(0)) if m else {"note": "judge_parse_fail"}
    except Exception:  # noqa: BLE001
        return {"note": "judge_parse_fail"}


def write_summary(out_dir, run_id, mode, models, competitors, rows, brand="Brand", own_domains=()):
    valid = [r for r in rows if r["error"] is None and r["answer_excerpt"] is not None]
    total = len(valid)
    mentioned = [r for r in valid if r["mentioned"]]
    sov = (len(mentioned) / total * 100) if total else 0.0

    per_model = {}
    for m in models:
        mr = [r for r in valid if r["model"] == m]
        per_model[m] = (sum(1 for r in mr if r["mentioned"]), len(mr))

    comp_counts = {c: 0 for c in competitors}
    for r in valid:
        for c in r["competitors"]:
            comp_counts[c] = comp_counts.get(c, 0) + 1

    # cited sources (grounded mode) — where to optimize
    dom_counts, answers_with_sources = {}, 0
    for r in valid:
        srcs = r.get("sources") or []
        if srcs:
            answers_with_sources += 1
        for u in srcs:
            d = _domain(u)
            dom_counts[d] = dom_counts.get(d, 0) + 1
    brand_cited = sum(1 for r in valid if r.get("brand_cited"))

    by_prompt = {}
    for r in valid:
        by_prompt.setdefault(r["prompt"], []).append(r["mentioned"])
    absent = [p for p, hits in by_prompt.items() if not any(hits)]

    lines = [
        f"# GEO visibility — run {run_id} ({mode} mode)",
        "",
        f"- Prompt×model answers scored: **{total}** (errors excluded)",
        f"- **Share of Voice ({brand} mentioned): {sov:.1f}%**",
        "",
        "## Per-model mention rate",
        f"| Model | {brand} mentioned | Rate |",
        "|---|---|---|",
    ]
    for m, (hit, tot) in per_model.items():
        rate = (hit / tot * 100) if tot else 0
        lines.append(f"| {m} | {hit}/{tot} | {rate:.0f}% |")

    lines += ["", "## Co-occurrence — who the LLMs name", "| Brand | Appearances |", "|---|---|",
              f"| **{brand}** | **{len(mentioned)}** |"]
    for c, ct in sorted(comp_counts.items(), key=lambda x: -x[1]):
        lines.append(f"| {c} | {ct} |")

    if dom_counts:
        lines += ["", "## Sources cited (where to optimize)",
                  f"- Answers with citations: {answers_with_sources}/{total}",
                  f"- Answers citing an own domain: **{brand_cited}**", "",
                  "| Domain | Times cited |", "|---|---|"]
        for d, ct in sorted(dom_counts.items(), key=lambda x: -x[1])[:25]:
            mark = " ⬅ us" if any(od in d for od in own_domains) else ""
            lines.append(f"| {d} | {ct}{mark} |")

    lines += ["", f"## Content backlog — {len(absent)} prompts where {brand} is ABSENT in *every* model",
              "_These are exactly what to write / seed next._", ""]
    lines += [f"- [ ] {p}" for p in absent]

    path = os.path.join(out_dir, f"summary-{run_id}.md")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    return path, sov


def main():
    ap = argparse.ArgumentParser(description="LLM visibility monitor — measure brand presence in AI answers")
    ap.add_argument("--prompts", default=os.path.join(HERE, "geo_prompts.yaml"))
    ap.add_argument("--out", default=os.path.join(HERE, "results"))
    ap.add_argument("--mode", choices=["parametric", "grounded"], default="parametric")
    ap.add_argument("--models", nargs="*", help="override the model list from the yaml")
    ap.add_argument("--judge", action="store_true", help="add accuracy/sentiment via judge_model")
    ap.add_argument("--sleep", type=float, default=1.0, help="seconds between calls")
    ap.add_argument("--groups", nargs="*", help="only run these prompt groups (e.g. engram_term)")
    args = ap.parse_args()

    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        sys.exit("Set OPENROUTER_API_KEY (see README.md).")

    with open(args.prompts) as f:
        cfg = yaml.safe_load(f)
    brand_cfg = cfg["brand"]
    brand_name = brand_cfg.get("name", "Brand")
    brand_patterns = brand_cfg["patterns"]
    brand_description = brand_cfg.get("description")
    # Domains counted as "ours" in the citation map. Defaults to any pattern that
    # looks like a domain, so an unconfigured brand still marks its own sites.
    own_domains = [d.lower() for d in brand_cfg.get("domains", [])] or [
        p.lower() for p in brand_patterns if "." in p and "/" not in p and "\\" not in p
    ]
    competitors = load_competitors(cfg["competitors"])
    models = args.models or cfg["models"]
    judge_model = cfg.get("judge_model", "openai/gpt-5-mini")
    groups = cfg["prompts"]
    if args.groups:
        groups = {k: v for k, v in groups.items() if k in args.groups}
        if not groups:
            sys.exit(f"No matching groups. Available: {list(cfg['prompts'])}")

    os.makedirs(args.out, exist_ok=True)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    jsonl_path = os.path.join(args.out, f"run-{run_id}.jsonl")
    history_path = os.path.join(args.out, "history.jsonl")

    rows = []
    total = sum(len(v) for v in groups.values()) * len(models)
    n = 0
    consecutive_errors = 0
    with open(jsonl_path, "w") as jf, open(history_path, "a") as hf:
        for model in models:
            model_id = model + (":online" if args.mode == "grounded" else "")
            for group, prompts in groups.items():
                for prompt in prompts:
                    n += 1
                    answer, sources, err = call_openrouter(model_id, prompt, api_key)
                    idx = first_brand_index(answer, brand_patterns, brand_name) if answer else -1
                    own_sources = [u for u in sources if any(d in _domain(u) for d in own_domains)]
                    row = {
                        "run_id": run_id,
                        "ts": datetime.now(timezone.utc).isoformat(),
                        "mode": args.mode,
                        "model": model,
                        "group": group,
                        "prompt": prompt,
                        "error": err,
                        "mentioned": idx >= 0,
                        "position": round(idx / len(answer), 3) if answer and idx >= 0 else None,
                        "competitors": competitor_hits(answer, competitors) if answer else [],
                        "sources": sources,
                        "brand_cited": bool(own_sources),
                        "answer_excerpt": (answer[:280] + "…") if answer and len(answer) > 280 else answer,
                    }
                    if args.judge and answer:
                        row["judge"] = judge(answer, judge_model, api_key, brand_name, brand_description)
                    rows.append(row)
                    line = json.dumps(row)
                    jf.write(line + "\n")
                    hf.write(line + "\n")
                    flag = f"{brand_name} ✓" if row["mentioned"] else ("ERR" if err else "·")
                    src = f" [{len(sources)} src]" if sources else ""
                    print(f"[{n}/{total}] {model:38} {group:12} {flag}{src}")
                    consecutive_errors = consecutive_errors + 1 if err else 0
                    if consecutive_errors >= 15:
                        print(f"\nABORT: {consecutive_errors} consecutive API errors "
                              f"(last: {str(err)[:160]}) — key/credits problem, not worth "
                              f"burning the remaining {total - n} calls.", file=sys.stderr)
                        sys.exit(2)
                    time.sleep(args.sleep)

    if not any(not r["error"] for r in rows):
        print("\nFATAL: 0 answers scored — every call errored. No summary written "
              "(an all-zero summary would blank the content backlog downstream).",
              file=sys.stderr)
        sys.exit(2)

    summary_path, sov = write_summary(args.out, run_id, args.mode, models, competitors, rows,
                                      brand_name, own_domains)
    print(f"\nShare of Voice: {sov:.1f}%")
    print(f"Raw:     {jsonl_path}")
    print(f"Summary: {summary_path}")


if __name__ == "__main__":
    main()
