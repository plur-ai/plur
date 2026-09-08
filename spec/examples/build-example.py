#!/usr/bin/env python3
"""Build a worked provenance record from a real engram.

Produces two files, so an implementer can see both the gap and the goal:

  example-today.jsonld   what we can honestly generate right now
  example-target.jsonld  the same engram once the capture work has landed

Usage:  python3 build-example.py <ENGRAM-ID>
"""
import json, pathlib, sys, yaml

HOME = pathlib.Path.home() / ".plur"
OUT = pathlib.Path(__file__).parent

CONTEXT = {
    "prov": "http://www.w3.org/ns/prov#",
    "engram": "https://plur.ai/ns/engram#",
    "pa": "https://w3id.org/prov-agent#",
    "odrl": "http://www.w3.org/ns/odrl/2/",
    "xsd": "http://www.w3.org/2001/XMLSchema#",
}

LICENCE_POLICY = {
    "cc-by-sa-4.0": {
        "@type": "odrl:Set",
        "odrl:permission": [{
            "odrl:action": "odrl:use",
            "odrl:duty": [
                {"odrl:action": "odrl:attribute"},
                {"odrl:action": "odrl:shareAlike"},
            ],
        }],
    }
}

# Which history events become which activity, and what they mean.
ACTIVITY = {
    "engram_created":  ("engram:Learn", "learning"),
    "engram_updated":  ("engram:Revise", "revising"),
    "engram_merged":   ("engram:Consolidate", "consolidating"),
    "engram_promoted": ("engram:Promote", "promoting"),
    "engram_retired":  ("engram:Retire", "retiring"),
    "co_injection":    ("engram:Inject", "injecting"),
}


def load_engram(engram_id):
    data = yaml.safe_load((HOME / "engrams.yaml").read_text())
    for e in data.get("engrams", []):
        if e.get("id") == engram_id:
            return e
    sys.exit(f"engram {engram_id} not found")


def load_events(engram_id):
    events = []
    for path in sorted((HOME / "history").glob("*.jsonl")):
        for line in path.read_text().splitlines():
            if engram_id not in line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return events


def timestamp(value):
    return {"@value": value, "@type": "xsd:dateTime"}


def build(engram, events, target):
    """target=False -> only what exists today. target=True -> with capture landed."""
    eid = engram["id"]
    graph = []

    # --- the engram itself -------------------------------------------------
    born = (engram.get("temporal") or {}).get("learned_at") \
        or (engram.get("sources") or [{}])[0].get("stored_at")

    thing = {
        "@id": f"engram:{eid}",
        "@type": ["prov:Entity", "engram:Engram"],
        "engram:engramType": engram.get("type"),
        "engram:scope": engram.get("scope"),
        "engram:status": engram.get("status"),
        "engram:commitment": engram.get("commitment"),
        "engram:contentHash": f"sha256:{engram.get('content_hash')}",
        "prov:generatedAtTime": timestamp(born),
        "odrl:hasPolicy": LICENCE_POLICY["cc-by-sa-4.0"],
    }
    if engram.get("tags"):
        thing["engram:tags"] = engram["tags"]
    valid_until = (engram.get("temporal") or {}).get("valid_until")
    if valid_until:
        thing["engram:validUntil"] = valid_until

    # The free-text source field. A web address is a real external source.
    src = engram.get("source") or ""
    if src.startswith("http"):
        thing["prov:hadPrimarySource"] = {"@id": src}
    elif src:
        thing["engram:sourceNote"] = src

    if target:
        thing["engram:claimClass"] = "documented"
        thing["prov:value"] = engram.get("statement")
        thing["prov:wasAttributedTo"] = {"@id": "engram:agent/unidentified"}
    else:
        thing["engram:claimClass"] = None  # not recorded today

    graph.append({k: v for k, v in thing.items() if v is not None})

    # --- activities, from the real history log -----------------------------
    seen_agents = set()
    for ev in events:
        kind = ev.get("event")
        if kind not in ACTIVITY:
            continue
        cls, _ = ACTIVITY[kind]
        data = ev.get("data") or {}
        # An injection is keyed by its own identifier, not the engram's.
        act_id = f"engram:act/{ev.get('engram_id')}" if kind == "co_injection" \
            else f"engram:act/{eid}-{kind}"
        act = {
            "@id": act_id,
            "@type": ["prov:Activity", cls],
            "prov:startedAtTime": timestamp(ev["timestamp"]),
            "prov:endedAtTime": timestamp(ev["timestamp"]),
        }
        if kind == "engram_created":
            act["prov:generated"] = {"@id": f"engram:{eid}"}
        if kind == "co_injection":
            # A portable record must name only the engram it is about.
            #
            # The log lists every engram injected together. Those identifiers
            # belong to the sender's store, and shipping them would tell the
            # recipient what else the sender holds. Record the count instead,
            # and drop the session identifier, which means nothing to them.
            ids = data.get("ids", [])
            act["prov:used"] = {"@id": f"engram:{eid}"}
            act["engram:usedAlongsideCount"] = max(0, len(ids) - 1)
            act["engram:queryHash"] = data.get("query_hash")
            if not target and data.get("session_id"):
                act["engram:session"] = f"engram:session/{data['session_id']}"
        if target:
            agent = "engram:agent/software/plur-mcp"
            act["prov:wasAssociatedWith"] = {"@id": agent}
            seen_agents.add(agent)
        graph.append(act)

    # --- agents ------------------------------------------------------------
    if target:
        graph.append({
            "@id": "engram:agent/unidentified",
            "@type": "prov:Agent",
            "engram:identityKnown": False,
            "engram:note": "No identity was configured when this was written.",
        })
        for a in sorted(seen_agents):
            graph.append({
                "@id": a,
                "@type": ["prov:SoftwareAgent", "pa:AIAgent"],
                "engram:runtimeName": "plur-mcp",
                "prov:actedOnBehalfOf": {"@id": "engram:agent/unidentified"},
            })

    # The record describes itself as the first node of a flat graph.
    #
    # Do NOT put "@id"/"@type" beside "@graph" at the top level. That makes the
    # contents a *named* graph, and an ordinary parse then sees only the wrapper.
    # A flat "@graph" is read by every parser into the default graph.
    record = {
        "@id": f"engram:record/{eid}",
        "@type": ["prov:Bundle", "prov:Entity"],
        "prov:generatedAtTime": timestamp("2026-08-21T09:00:00Z"),
        "engram:describes": {"@id": f"engram:{eid}"},
        "engram:recordIsSelfContained": True,
    }
    return {"@context": CONTEXT, "@graph": [record] + graph}


def main():
    eid = sys.argv[1] if len(sys.argv) > 1 else "ENG-2026-08-12-002"
    engram = load_engram(eid)
    events = load_events(eid)
    print(f"engram {eid}: {len(events)} history events found")
    for label, is_target in (("today", False), ("target", True)):
        doc = build(engram, events, is_target)
        path = OUT / f"example-{label}.jsonld"
        path.write_text(json.dumps(doc, indent=2) + "\n")
        print(f"  wrote {path.name}  ({len(doc['@graph'])} nodes)")


if __name__ == "__main__":
    main()
