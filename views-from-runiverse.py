#!/usr/bin/env python3
"""Reconstruct a Bioconductor VIEWS file from the r-universe API, and report how
much of the real VIEWS it reproduces.

Background: the site build reads VIEWS from bioconductor.org, which is circular —
the build fetching its own published output. r-universe is a genuine origin for
package metadata, so this measures how far it gets us.

Usage:
    ./views-from-runiverse.py --bioc 3.23                 # fetch + compare
    ./views-from-runiverse.py --bioc 3.23 --emit out.VIEWS  # write reconstruction

Findings as of 2026-08-03 (BioC 3.23, software repo): r-universe carries 2417 of
2418 packages. Package metadata reproduces cleanly. What it cannot supply is the
repository-artifact fields — MD5sum, win.binary.ver, Archs, Rfiles, hasINSTALL,
hasLICENSE — because those describe files in Bioconductor's package repository,
not the package source. Those must come from the repository itself (PACKAGES plus
a directory listing); MD5sum turns out to be referenced nowhere in the site.
"""

import argparse, collections, datetime, json, re, sys, urllib.request

UA = {"User-Agent": "Mozilla/5.0 bioc-cloudflare/views-spike"}
# Fields that describe files in the package repository rather than the package
# itself. r-universe structurally cannot know these; don't count them as failures.
REPO_ARTIFACT_FIELDS = {
    "MD5sum", "win.binary.ver", "Archs", "Rfiles", "hasINSTALL", "hasLICENSE",
    "mac.binary.big-sur-x86_64.ver", "mac.binary.sonoma-arm64.ver",
}
ROLE2REV = {
    "Depends": "dependsOnMe", "Imports": "importsMe",
    "Suggests": "suggestsMe", "LinkingTo": "linksToMe",
}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r:
        return r.read()


def parse_dcf(text):
    """Parse DCF into {package: {field: value}}. Continuation lines are folded
    with a single space, which is lossy for multi-line prose — see caveat below."""
    recs, cur, key = [], {}, None
    for line in text.splitlines():
        if not line.strip():
            if cur:
                recs.append(cur)
                cur, key = {}, None
            continue
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_.@/-]*):\s?(.*)$", line)
        if m:
            key, cur[m.group(1)] = m.group(1), m.group(2)
        elif key:
            cur[key] += " " + line.strip()
    if cur:
        recs.append(cur)
    return {r["Package"]: r for r in recs if "Package" in r}


def reverse_deps(pkgs):
    rev = collections.defaultdict(lambda: collections.defaultdict(list))
    for name, p in pkgs.items():
        for d in p.get("_dependencies") or []:
            field = ROLE2REV.get(d.get("role"))
            if field and d["package"] != "R":
                rev[d["package"]][field].append(name)
    return rev


def reconstruct(name, p, rev, branch):
    r = {"Package": name, "Version": p.get("Version")}
    for role in ("Depends", "Imports", "Suggests", "LinkingTo", "Enhances"):
        vals = [
            d["package"] + (f" ({d['version']})" if d.get("version") else "")
            for d in (p.get("_dependencies") or []) if d.get("role") == role
        ]
        if vals:
            r[role] = ", ".join(vals)
    for k in ("License", "NeedsCompilation", "Title", "Description", "biocViews",
              "Author", "Maintainer", "URL", "BugReports", "VignetteBuilder",
              "SystemRequirements", "OS_type", "PackageStatus", "Date/Publication",
              "organism", "Video", "License_restricts_use", "License_is_FOSS"):
        if p.get(k):
            r[k] = p[k]

    r["git_url"] = f"https://git.bioconductor.org/packages/{name}"
    r["git_branch"] = branch
    commit = p.get("_commit") or {}
    if commit.get("id"):
        r["git_last_commit"] = commit["id"][:7]
    if commit.get("time"):
        r["git_last_commit_date"] = datetime.datetime.utcfromtimestamp(
            commit["time"]).strftime("%Y-%m-%d")
    if p.get("Version"):
        r["source.ver"] = f"src/contrib/{name}_{p['Version']}.tar.gz"

    vignettes = p.get("_vignettes") or []
    if vignettes:
        r["vignettes"] = ", ".join(
            f"vignettes/{name}/inst/doc/{v['filename']}" for v in vignettes)
        r["vignetteTitles"] = ", ".join(v.get("title", "") for v in vignettes)

    assets = p.get("_assets") or []
    r["hasNEWS"] = "TRUE" if any("NEWS" in a for a in assets) else "FALSE"
    r["hasREADME"] = "TRUE" if p.get("_readme") else "FALSE"

    for field in ROLE2REV.values():
        if rev[name][field]:
            r[field] = ", ".join(sorted(rev[name][field]))
    r["dependencyCount"] = str(len([
        d for d in (p.get("_dependencies") or [])
        if d.get("role") in ("Depends", "Imports", "LinkingTo") and d["package"] != "R"
    ]))
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bioc", default="3.23", help="Bioconductor version, e.g. 3.23")
    ap.add_argument("--universe", default="bioc-release",
                    help="r-universe name: bioc-release (release) or bioc (devel)")
    ap.add_argument("--repo", default="bioc",
                    help="bioc | data/annotation | data/experiment | workflows")
    ap.add_argument("--emit", help="write the reconstructed VIEWS here")
    args = ap.parse_args()

    # devel builds off the git default branch; release off the RELEASE_x_y branch.
    branch = "devel" if args.universe == "bioc" else "RELEASE_" + args.bioc.replace(".", "_")
    print(f"fetching r-universe: {args.universe} ...", file=sys.stderr)
    pkgs = {p["Package"]: p
            for p in json.loads(get(f"https://{args.universe}.r-universe.dev/api/packages"))}
    print(f"fetching real VIEWS: BioC {args.bioc} {args.repo} ...", file=sys.stderr)
    views = parse_dcf(get(
        f"https://bioconductor.org/packages/{args.bioc}/{args.repo}/VIEWS").decode("utf-8", "replace"))

    rev = reverse_deps(pkgs)
    built = {n: reconstruct(n, p, rev, branch) for n, p in pkgs.items()}

    print(f"\npackages: VIEWS={len(views)} r-universe={len(pkgs)} "
          f"missing_from_runiverse={sorted(set(views) - set(pkgs))}\n")

    total, exact, absent = collections.Counter(), collections.Counter(), collections.Counter()
    for name, real in views.items():
        rec = built.get(name)
        if not rec:
            continue
        for field, value in real.items():
            total[field] += 1
            if field not in rec:
                absent[field] += 1
            elif str(rec[field]).strip() == str(value).strip():
                exact[field] += 1

    print(f"{'FIELD':<24}{'n':>7}{'exact':>8}{'%':>7}{'absent':>8}  note")
    for field, n in total.most_common():
        note = "repository artifact" if field in REPO_ARTIFACT_FIELDS else ""
        # A field present but rarely exact is a formatting problem, not missing data.
        if not note and absent[field] == 0 and exact[field] / n < 0.9:
            note = "present, formatting differs"
        print(f"{field:<24}{n:>7}{exact[field]:>8}{100*exact[field]/n:>6.1f}%"
              f"{absent[field]:>8}  {note}")

    if args.emit:
        with open(args.emit, "w", encoding="utf-8") as fh:
            for name in sorted(built):
                for k, v in built[name].items():
                    if v is not None:
                        fh.write(f"{k}: {v}\n")
                fh.write("\n")
        print(f"\nwrote {args.emit}", file=sys.stderr)


if __name__ == "__main__":
    main()
