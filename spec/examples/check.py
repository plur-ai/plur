#!/usr/bin/env python3
"""Check a provenance example against outside tools, and against the profile's own rules."""
import json, sys, pathlib
from rdflib import Graph, Namespace, URIRef, RDF
PROV = Namespace("http://www.w3.org/ns/prov#")
EN = Namespace("https://plur.ai/ns/engram#")

def check(path):
    print(f"\n=== {path.name} ===")
    raw = path.read_text()
    doc = json.loads(raw)
    g = Graph()
    g.parse(data=raw, format="json-ld")
    print(f"  parsed: {len(g)} statements")

    for cls in ("Entity", "Activity", "Agent", "Bundle"):
        n = len(list(g.subjects(RDF.type, PROV[cls])))
        print(f"    prov:{cls:<9} {n}")

    # Self-contained: every object that is an engram: address must be described.
    described = set(g.subjects())
    dangling = set()
    for s, p, o in g:
        if p == RDF.type:
            continue  # a class need not be described in the same document
        if isinstance(o, URIRef) and str(o).startswith(str(EN)) and o not in described:
            dangling.add((str(p).split("#")[-1], str(o).replace(str(EN), "engram:")))
    if dangling:
        print(f"  DANGLING references ({len(dangling)}) — record is NOT self-contained:")
        for pred, ref in sorted(dangling)[:8]:
            print(f"      {pred} -> {ref}")
    else:
        print("  ok  no dangling references")

    # The five questions the profile says a recipient must be able to answer.
    ent = next(iter(g.subjects(RDF.type, EN.Engram)), None)
    q = {
        "who made it":      (ent, PROV.wasAttributedTo),
        "how (claim class)":(ent, EN.claimClass),
        "when":             (ent, PROV.generatedAtTime),
        "what from":        (ent, PROV.hadPrimarySource),
        "may I use it":     (ent, URIRef("http://www.w3.org/ns/odrl/2/hasPolicy")),
    }
    print("  recipient can answer:")
    for label, (s, p) in q.items():
        got = bool(s is not None and next(g.objects(s, p), None) is not None)
        print(f"      {'yes' if got else 'NO '}  {label}")
    return len(dangling) == 0

ok = all(check(p) for p in sorted(pathlib.Path(".").glob("example-*.jsonld")))
sys.exit(0 if ok else 1)
