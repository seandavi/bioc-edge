#!/usr/bin/env python3
"""Model the information flow from r-universe builds to bioconductor.org binaries.

Binaries reach bioconductor.org by a path nobody currently has a view of:
r-universe builds a package on GitHub Actions across many platforms and R
versions, biocUniTools' harvest.R accepts some of those, and the result is
published. What is missing is an explicit account of WHICH builds exist, WHICH
were propagated, and WHY the rest were not.

The risk it guards against: r-universe rotates old R builds out. Once a
harvested binary's R *series* ages out upstream it can no longer be re-fetched,
and the copy on bioconductor.org becomes the only surviving artifact with
nothing recording what it derived from. Measured over 80 packages of release
3.23 this is not yet happening — R binaries are compatible within a major.minor
series, and r-universe still builds 4.6.x — so it is a latent risk that this
report makes visible before it bites. Compare Bioconductor/biocUniTools#2,
which asks where the R version of an artifact is recorded.

Reports, per package, the three facts that make the flow legible:

  version   does r-universe's package version match what Bioconductor ships?
  commit    does r-universe's RemoteSha match Bioconductor's git_last_commit?
  R         does r-universe still offer a build at the R version Bioconductor's
            release is pinned to?

The third decays over time and is invisible unless asked for: Bioconductor pins
R for a whole release cycle, r-universe tracks R as it moves, so the two agree
at harvest time and diverge at the next R patch release.

Usage:
    ./model-binary-flow.py --bioc 3.23 --limit 60
    ./model-binary-flow.py --bioc 3.23 --package limma
"""

import argparse, collections, json, re, sys, urllib.request

UA = {"User-Agent": "Mozilla/5.0 bioc-cloudflare/binary-flow-model"}
SITE = "https://bioconductor.org"


def fetch(url, as_json=True):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r:
            raw = r.read()
        return json.loads(raw) if as_json else raw.decode("utf-8", "replace")
    except Exception as e:
        print(f"  ! {url}: {e}", file=sys.stderr)
        return None


def site_config():
    txt = fetch(f"{SITE}/config.yaml", as_json=False) or ""
    keys = ("release_version", "devel_version",
            "r_version_associated_with_release", "r_version_associated_with_devel")
    return {k: (re.search(rf'^{k}: *"?([^"\n]+)"?', txt, re.M) or [None, None])[1] for k in keys}


def pinned_r(bioc_version, cfg):
    if bioc_version == cfg.get("release_version"):
        return cfg.get("r_version_associated_with_release")
    if bioc_version == cfg.get("devel_version"):
        return cfg.get("r_version_associated_with_devel")
    return None


def rminor(v):
    """R binaries are keyed by major.minor; 4.6.0 and 4.6.1 share a contrib dir."""
    return ".".join(str(v).split(".")[:2]) if v else None


def classify(bioc_pkg, uni_pkg, want_r):
    """Compare one package across the two systems."""
    if uni_pkg is None:
        return dict(state="absent-upstream", detail="not in r-universe")

    out = {}
    out["version_match"] = bioc_pkg.get("Version") == uni_pkg.get("Version")
    bsha = (bioc_pkg.get("git_last_commit") or "").strip()
    usha = (uni_pkg.get("RemoteSha") or "").strip()
    # Bioconductor stores the short hash, r-universe the full one.
    out["commit_match"] = bool(bsha and usha and usha.startswith(bsha))

    bins = uni_pkg.get("_binaries") or []
    offered = {rminor(b.get("r")) for b in bins if b.get("os") in ("win", "mac")}
    out["r_offered"] = sorted(x for x in offered if x)
    out["r_exact"] = rminor(want_r) in offered

    if not out["version_match"]:
        out["state"] = "version-skew"
    elif not out["r_exact"]:
        out["state"] = "r-aged-out"
    elif not out["commit_match"]:
        out["state"] = "commit-skew"
    else:
        out["state"] = "aligned"
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bioc", default="3.23")
    ap.add_argument("--limit", type=int, default=60)
    ap.add_argument("--package", help="inspect a single package")
    args = ap.parse_args()

    cfg = site_config()
    want_r = pinned_r(args.bioc, cfg)
    universe = "bioc-release" if args.bioc == cfg.get("release_version") else "bioc"
    print(f"bioc {args.bioc}  pinned R {want_r}  vs  {universe}.r-universe.dev", file=sys.stderr)
    if not want_r:
        print("! only release and devel have a pinned R version; nothing to compare",
              file=sys.stderr)
        return

    bioc = fetch(f"{SITE}/packages/json/{args.bioc}/bioc/packages.json")
    if not bioc:
        return
    names = [args.package] if args.package else sorted(bioc)[: args.limit]

    rows, counts = [], collections.Counter()
    for name in names:
        if name not in bioc:
            print(f"  ! {name} not in bioc {args.bioc}", file=sys.stderr)
            continue
        uni = fetch(f"https://{universe}.r-universe.dev/api/packages/{name}")
        res = classify(bioc[name], uni, want_r)
        counts[res["state"]] += 1
        rows.append((name, bioc[name].get("Version"), (uni or {}).get("Version"), res))

    if args.package:
        for name, bv, uv, res in rows:
            print(f"\n{name}")
            print(f"  bioconductor version {bv}   r-universe version {uv}")
            print(f"  commit match : {res.get('commit_match')}")
            print(f"  R pinned     : {want_r}  ({rminor(want_r)} series)")
            print(f"  R offered    : {res.get('r_offered')}")
            print(f"  state        : {res['state']}")
        return

    print(f"\n{'PACKAGE':<26}{'bioc':<12}{'r-universe':<12}state")
    for name, bv, uv, res in rows:
        if res["state"] != "aligned":
            print(f"{name:<26}{str(bv):<12}{str(uv):<12}{res['state']}")
    total = sum(counts.values())
    print(f"\nsummary over {total} packages:")
    for state, n in counts.most_common():
        print(f"  {state:<18} {n:>4}  ({100*n/total:.0f}%)")
    print("\nstates:")
    print("  aligned         same version, same commit, and r-universe still offers")
    print("                  a build at the release's pinned R series")
    print("  r-aged-out      version and commit agree, but r-universe no longer")
    print("                  builds for that R series — the bioconductor.org copy")
    print("                  is now the only surviving artifact")
    print("  version-skew    r-universe has a different package version")
    print("  commit-skew     same version, different source commit")
    print("  absent-upstream not present in r-universe at all")


if __name__ == "__main__":
    main()
