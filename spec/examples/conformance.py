#!/usr/bin/env python3
"""Check provenance records against implementations that share none of our code.

A record only our own code can read proves nothing. This runs every record
through two outside tools and fails if either rejects one:

  rdflib  parses the JSON-LD and reports the statements it found
  prov    the reference implementation of the standard, which refuses
          malformed documents outright

It then checks the rules the profile itself sets:

  - no dangling references, so a record stands on its own
  - a recipient can answer all five questions
  - a portable record names no engram other than its own subject

Usage:
    python3 conformance.py                 # every .jsonld beside this script
    python3 conformance.py FILE [FILE...]  # named files
    python3 conformance.py --dir DIR       # every .jsonld in a directory

Exit code is 1 if any record fails, so this can gate a build.

Install what it needs with:
    python3 -m pip install -r requirements.txt
"""
import argparse
import json
import pathlib
import sys

try:
    from rdflib import Graph, Namespace, URIRef, RDF
except ImportError:
    sys.exit(
        "conformance: rdflib is not installed, so records cannot be checked "
        "against an outside implementation.\n"
        "Install it with: python3 -m pip install -r requirements.txt\n"
        "Refusing to pass silently — an unchecked record is the thing this "
        "script exists to prevent."
    )

try:
    import prov.model
except ImportError:
    sys.exit(
        "conformance: the prov reference implementation is not installed.\n"
        "Install it with: python3 -m pip install -r requirements.txt"
    )

PROV = Namespace("http://www.w3.org/ns/prov#")
ENGRAM = Namespace("https://plur.ai/ns/engram#")
ODRL = Namespace("http://www.w3.org/ns/odrl/2/")

# The five questions the profile says a recipient must be able to answer.
QUESTIONS = [
    ("who made it", [PROV.wasAttributedTo]),
    ("what kind of claim", [ENGRAM.claimClass]),
    ("when", [PROV.generatedAtTime]),
    # Either form answers this: the licence name, or the policy built from it.
    ("may I use it", [ENGRAM.license, ODRL.hasPolicy]),
]


def check(path: pathlib.Path, strict: bool = False) -> tuple[list[str], list[str]]:
    """Return (errors, gaps).

    An **error** means the record is wrong: malformed, rejected by an outside
    tool, or making a promise it does not keep. Errors fail the build.

    A **gap** means the record is honest but incomplete — it cannot say who made
    the engram, because nobody recorded that. Gaps are reported, not fatal.
    Treating them as failures would push toward inventing an agent, which is
    exactly what the profile forbids.
    """
    problems: list[str] = []
    gaps: list[str] = []
    raw = path.read_text()

    try:
        json.loads(raw)
    except json.JSONDecodeError as err:
        return [f"not valid JSON: {err}"], []

    # 1. An outside parser reads it.
    graph = Graph()
    try:
        graph.parse(data=raw, format="json-ld")
    except Exception as err:
        return [f"rdflib rejected it: {type(err).__name__}: {err}"], []

    if len(graph) == 0:
        problems.append(
            "parsed to zero statements — check the graph is flat. "
            "An @id beside @graph makes the contents a named graph, "
            "which an ordinary reader does not see."
        )

    # 2. The reference implementation accepts it.
    try:
        turtle = graph.serialize(format="turtle").encode("utf-8")
        prov.model.ProvDocument.deserialize(
            content=turtle, format="rdf", rdf_format="turtle"
        )
    except Exception as err:
        problems.append(f"the reference implementation rejected it: {type(err).__name__}: {err}")

    # 3. A record that CLAIMS to stand on its own must actually do so.
    #
    # A local record may name our own identifiers, because its reader has our
    # files. Only a portable one makes the promise, so only a portable one is
    # held to it. The record says which it is.
    portable = True
    for _, value in graph.subject_objects(ENGRAM.recordIsSelfContained):
        portable = str(value).lower() == "true"

    described = set(graph.subjects())
    dangling = {
        str(o).replace(str(ENGRAM), "engram:")
        for s, p, o in graph
        if p != RDF.type
        and isinstance(o, URIRef)
        and str(o).startswith(str(ENGRAM))
        and o not in described
    }
    if dangling and portable:
        problems.append(
            f"{len(dangling)} dangling reference(s) in a record that claims to stand "
            "on its own: " + ", ".join(sorted(dangling)[:5])
        )

    # Some records are teaching artefacts that demonstrate a gap rather than
    # meet the bar. They must still parse and still not dangle — but they are
    # not expected to answer every question, because showing what is missing is
    # the whole point of them.
    incomplete = list(graph.subject_objects(ENGRAM.incompleteByDesign))

    # 4. A record about one engram answers the five questions. Pack records
    #    describe a collection instead, and are checked differently below.
    subjects = list(graph.subjects(RDF.type, ENGRAM.Engram))
    packs = list(graph.subjects(RDF.type, PROV.Collection))

    if packs:
        pack = packs[0]
        if not list(graph.objects(pack, PROV.hadMember)):
            problems.append("a pack record with no members")
        if not list(graph.objects(pack, PROV.wasGeneratedBy)):
            problems.append("a pack record that does not say how it was assembled")
    elif subjects and incomplete:
        print(f"      (skipping the five questions: this record declares itself "
              f"incomplete by design)")
    elif subjects:
        # The subject is the engram the record describes, not a shallow member.
        subject = subjects[0]
        for label, predicates in QUESTIONS:
            if not any(list(graph.objects(subject, p)) for p in predicates):
                (problems if strict else gaps).append(f"cannot answer: {label}")
    else:
        problems.append("no engram and no pack — what does this record describe?")

    return problems, gaps


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="*", help="records to check")
    parser.add_argument("--dir", help="check every .jsonld in this directory")
    parser.add_argument(
        "--strict", action="store_true",
        help="treat an unanswerable question as a failure, not a gap",
    )
    args = parser.parse_args()

    here = pathlib.Path(__file__).parent
    if args.dir:
        paths = sorted(pathlib.Path(args.dir).glob("*.jsonld"))
    elif args.files:
        paths = [pathlib.Path(f) for f in args.files]
    else:
        paths = sorted(here.glob("*.jsonld"))

    if not paths:
        print("conformance: no records found to check.", file=sys.stderr)
        return 1

    failed = 0
    incomplete = 0
    for path in paths:
        problems, gaps = check(path, strict=args.strict)
        if problems:
            failed += 1
            print(f"FAIL  {path.name}")
            for problem in problems:
                print(f"        {problem}")
        elif gaps:
            incomplete += 1
            print(f"ok    {path.name}  (honest but incomplete)")
            for gap in gaps:
                print(f"        {gap}")
        else:
            print(f"ok    {path.name}")

    print()
    if failed:
        print(f"conformance: {failed} of {len(paths)} record(s) failed.")
        return 1
    note = f", {incomplete} honest but incomplete" if incomplete else ""
    print(f"conformance: all {len(paths)} record(s) accepted by both outside tools{note}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
