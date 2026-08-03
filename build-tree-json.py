#!/usr/bin/env python3
"""Generate tree.json (the biocViews category hierarchy) from real origins.

tree.json drives the package category browser. The legacy build produced it from
VIEWS via the biocViews R package; this builds it from two genuine origins:

  the vocabulary   Bioconductor/biocViews, inst/dot/biocViewsVocab.dot — the
                   editable source of the term hierarchy (a DAG, not a tree:
                   a term may have several parents)
  the assignments  each package's biocViews field in packages.json

Output format is what the jsTree widget expects, and it is not uniform:

  term with packages     {"data": "Name (n)", "attr": {"packageList": "a,b,c",
                                                       "id": "Name"}, "children": [...]}
  term with none         {"data": "Name", "childnum": 0, "children": [...]}

The two package figures on a node are different sets, which is the easy mistake:
`packageList` holds packages filed DIRECTLY under the term, while the count in
`data` is CUMULATIVE over the subtree. AssayDomain renders "AssayDomain (960)"
while carrying 13 packages. Terms with no direct assignments but populated
descendants fall back to the cumulative set (ChipManufacturer, ChipName).

The vocabulary is pinned per release: terms are added over time, so devel's list
against an older release invents categories that did not exist then.

biocViews.json is deliberately not generated: nothing reads it, and its own
source in get_json.rb is marked "todo - remove this".

Usage:
    ./build-tree-json.py --bioc 3.23 --json-dir astro/data --out /tmp/tree.json
"""

import argparse, json, os, re, sys, urllib.request

VOCAB_TMPL = ("https://raw.githubusercontent.com/Bioconductor/biocViews/{ref}/"
              "inst/dot/biocViewsVocab.dot")
# The vocabulary evolves: terms are added between releases. Using devel's term
# list against an older release invents categories that did not exist then, so
# the vocabulary must be pinned to the matching RELEASE_x_y branch. Those
# branches only go back to RELEASE_3_7; older releases can only be approximated.
OLDEST_VOCAB_BRANCH = (3, 7)
# Each root term is populated from exactly one repository.
ROOTS = [
    ("Software", "bioc"),
    ("AnnotationData", "data/annotation"),
    ("ExperimentData", "data/experiment"),
    ("Workflow", "workflows"),
]


def vocab_ref(version):
    """Branch of biocViews whose vocabulary matches this release."""
    major, minor = (int(x) for x in version.split("."))
    if (major, minor) >= (3, 24):          # current devel
        return "devel"
    if (major, minor) >= OLDEST_VOCAB_BRANCH:
        return f"RELEASE_{major}_{minor}"
    return None


def load_vocab(url):
    """Parse the DOT digraph into {parent: [children]}, preserving file order."""
    req = urllib.request.Request(url, headers={"User-Agent": "bioc-cloudflare"})
    with urllib.request.urlopen(req, timeout=120) as r:
        text = r.read().decode("utf-8", "replace")
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)  # strip block comments
    kids = {}
    for parent, child in re.findall(r'"?([A-Za-z0-9_.]+)"?\s*->\s*"?([A-Za-z0-9_.]+)"?', text):
        kids.setdefault(parent, [])
        if child not in kids[parent]:
            kids[parent].append(child)
    return kids


def descendants(term, kids, seen=None):
    """All terms at or below `term`. The vocabulary is a DAG, so guard revisits."""
    seen = seen if seen is not None else set()
    if term in seen:
        return seen
    seen.add(term)
    for c in kids.get(term, []):
        descendants(c, kids, seen)
    return seen


def build_node(term, kids, pkg_terms, cache):
    """Depth-first build of one jsTree node.

    The two package figures on a node are NOT the same set, which is easy to get
    wrong: `packageList` holds only packages filed directly under this term,
    while the count shown in `data` is cumulative over the whole subtree. So
    AssayDomain renders as "AssayDomain (960)" while carrying 13 packages.
    """
    if term not in cache:
        covered = descendants(term, kids)
        direct = sorted((p for p, terms in pkg_terms.items() if term in terms),
                        key=str.lower)
        cumulative = sorted((p for p, terms in pkg_terms.items() if terms & covered),
                            key=str.lower)
        # Terms nothing is filed under directly, but which have populated
        # descendants, fall back to the cumulative set. This is what the legacy
        # output does for ChipManufacturer and ChipName: annotation packages
        # declare the child term (CodelinkChip, adme16cod) and never the parent.
        cache[term] = (direct or cumulative, len(cumulative))
    direct, total = cache[term]
    children = [build_node(c, kids, pkg_terms, cache) for c in kids.get(term, [])]
    if total:
        return {"data": f"{term} ({total})",
                "attr": {"packageList": ",".join(direct), "id": term},
                "children": children}
    # Terms nothing is filed under render without a count.
    return {"data": term, "childnum": 0, "children": children}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bioc", default="3.23")
    ap.add_argument("--json-dir", default="astro/data",
                    help="directory holding <version>/<repo>/packages.json")
    ap.add_argument("--out", default="tree.json")
    ap.add_argument("--vocab-ref", help="override the biocViews branch/tag")
    args = ap.parse_args()

    ref = args.vocab_ref or vocab_ref(args.bioc)
    if ref is None:
        print(f"! no biocViews branch for {args.bioc} (branches start at "
              f"RELEASE_{OLDEST_VOCAB_BRANCH[0]}_{OLDEST_VOCAB_BRANCH[1]}); "
              f"falling back to devel, expect extra terms", file=sys.stderr)
        ref = "devel"
    kids = load_vocab(VOCAB_TMPL.format(ref=ref))
    print(f"vocabulary @ {ref}: {len(kids)} terms with children, "
          f"{sum(len(v) for v in kids.values())} edges", file=sys.stderr)

    tree = []
    for root, repo in ROOTS:
        path = os.path.join(args.json_dir, args.bioc, repo, "packages.json")
        if not os.path.exists(path):
            print(f"  skip {root}: no {path}", file=sys.stderr)
            continue
        pkgs = json.load(open(path, encoding="utf-8"))
        # A package with no biocViews terms still belongs to its root, which is
        # how the roots come to carry the entire repository.
        pkg_terms = {
            name: (set(p.get("biocViews") or []) | {root})
            for name, p in pkgs.items()
        }
        node = build_node(root, kids, pkg_terms, {})
        tree.append(node)
        print(f"  {root:<15} {len(pkgs):>5} packages -> {node['data']}", file=sys.stderr)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(tree, fh)
    print(f"wrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
