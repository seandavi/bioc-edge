#!/usr/bin/env python3
"""Generate packages.json from real origins instead of from bioconductor.org.

The site build historically fetched VIEWS from the site it produces, converted it
to packages.json, and rendered ~7,600 package pages from that. This builds the
same packages.json, but sources each field from where the data actually
originates, and reports that provenance rather than hiding it.

Origins, per repository:

  bioc (software)              r-universe  — a genuine origin, no Bioconductor
                                             host involved
  data/annotation              VIEWS       ) no non-site origin exists for these
  data/experiment              VIEWS       ) yet: r-universe has no universe for
  workflows                    VIEWS       ) them, and PACKAGES lacks Title,
                                             Description, Maintainer, biocViews
  reverse dependencies         computed across all four repos + CRAN PACKAGES
  Rank                         bio-web-stats (separate service; served under
                                             the site hostname but not site output)

The VIEWS fallback is deliberate and flagged in the provenance report. It is not
an oversight; it is the honest state of the world, and it is the thing that has
to change before the package pages are independent of the site.

Usage:
    ./build-packages-json.py --bioc 3.23 --out ./out
    ./build-packages-json.py --bioc 3.23 --out ./out --software-origin views
"""

import argparse, collections, json, os, re, sys, urllib.request

UA = {"User-Agent": "Mozilla/5.0 bioc-cloudflare/packages-json-generator"}
SITE = "https://bioconductor.org"
REPOS = ["bioc", "data/annotation", "data/experiment", "workflows"]

# clean_dcfs in scripts/get_json.rb converts exactly these to arrays.
ARRAY_FIELDS = {
    "Depends", "Suggests", "Imports", "Enhances", "biocViews", "LinkingTo",
    "vignettes", "vignetteTitles", "Rfiles", "dependsOnMe", "importsMe",
    "suggestsMe", "linksToMe",
}
# Confirmed unread by any template, helper or script. Not emitted.
UNUSED = {
    "MD5sum", "NeedsCompilation", "git_url", "git_last_commit",
    "git_last_commit_date", "Date/Publication", "VignetteBuilder", "OS_type",
    "License_is_FOSS", "License_restricts_use", "organism",
}
REV = {"Depends": "dependsOnMe", "Imports": "importsMe",
       "Suggests": "suggestsMe", "LinkingTo": "linksToMe"}


def fetch(url, optional=False):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r:
            return r.read().decode("utf-8", "replace")
    except Exception as e:
        if optional:
            print(f"  ! optional fetch failed {url}: {e}", file=sys.stderr)
            return None
        raise


def parse_dcf(text):
    recs, cur, key = [], {}, None
    for line in text.splitlines():
        if not line.strip():
            if cur:
                recs.append(cur); cur, key = {}, None
            continue
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_.@/-]*):\s?(.*)$", line)
        if m:
            key, cur[m.group(1)] = m.group(1), m.group(2)
        elif key:
            cur[key] += " " + line.strip()
    if cur:
        recs.append(cur)
    return {r["Package"]: r for r in recs if "Package" in r}


def split_list(v):
    return [x.strip() for x in re.split(r",\s*", v) if x.strip()] if v else []


def dep_name(entry):
    return re.split(r"[ (]", str(entry))[0]


# ---------------------------------------------------------------- origins ---

def from_runiverse(universe, branch):
    """Software packages, from r-universe. A real origin."""
    pkgs = json.loads(fetch(f"https://{universe}.r-universe.dev/api/packages"))
    out = {}
    for p in pkgs:
        name = p["Package"]
        rec = {"Package": name, "Version": p.get("Version")}
        for role in ("Depends", "Imports", "Suggests", "LinkingTo", "Enhances"):
            vals = [d["package"] + (f" ({d['version']})" if d.get("version") else "")
                    for d in (p.get("_dependencies") or []) if d.get("role") == role]
            if vals:
                rec[role] = vals
        for k in ("Title", "Description", "Author", "Maintainer", "License", "URL",
                  "BugReports", "SystemRequirements", "PackageStatus", "Video"):
            if p.get(k):
                # r-universe preserves DESCRIPTION's line breaks; VIEWS folds them.
                # Match VIEWS so rendered pages are byte-comparable.
                rec[k] = re.sub(r"\s+", " ", str(p[k])).strip()
        if p.get("biocViews"):
            rec["biocViews"] = split_list(p["biocViews"])
        rec["git_branch"] = branch
        if p.get("Version"):
            rec["source.ver"] = f"src/contrib/{name}_{p['Version']}.tar.gz"
        vigs = p.get("_vignettes") or []
        if vigs:
            rec["vignettes"] = [f"vignettes/{name}/inst/doc/{v['filename']}" for v in vigs]
            rec["vignetteTitles"] = [v.get("title", v["filename"]) for v in vigs]
        assets = p.get("_assets") or []
        rec["hasNEWS"] = any("NEWS" in a for a in assets)
        rec["hasREADME"] = bool(p.get("_readme"))
        out[name] = rec
    return out


def from_views(version, repo, branch):
    """Fallback for repositories with no origin outside the site yet."""
    dcf = parse_dcf(fetch(f"{SITE}/packages/{version}/{repo}/VIEWS"))
    out = {}
    for name, r in dcf.items():
        rec = {}
        for k, v in r.items():
            if k in UNUSED:
                continue
            rec[k] = split_list(v) if k in ARRAY_FIELDS else v
        for k in ("hasNEWS", "hasREADME", "hasINSTALL", "hasLICENSE"):
            if k in rec:
                rec[k] = str(rec[k]).strip().upper() == "TRUE"
        rec.setdefault("git_branch", branch)
        out[name] = rec
    return out


def load_ranks(repo, version):
    """Rank is not package metadata and not site output — it comes from
    bio-web-stats, a separate Flask/Postgres service fed by a daily Athena job
    over CloudFront logs. Confirmed live: /packages/stats/* answers with
    `Server: waitress` while every other path answers `Server: Apache/2.4.52`,
    so this is already decoupled from master and is a genuine origin. It is
    only *addressed* through the shared hostname — which means the routing for
    this path is a must-preserve item during any cutover.

    Note the directory and filename slugs differ for the data repositories."""
    dirslug, fileslug = {
        "bioc": ("bioc", "bioc"),
        "workflows": ("workflows", "workflows"),
        "data/annotation": ("data-annotation", "annotation"),
        "data/experiment": ("data-experiment", "experiment"),
    }[repo]
    txt = fetch(f"{SITE}/packages/stats/{dirslug}/{fileslug}_pkg_scores.tab", optional=True)
    if not txt:
        return {}
    ranks = {}
    for line in txt.splitlines():
        if line.startswith("Package\t"):
            continue
        parts = line.split("\t")
        if len(parts) >= 2:
            try:
                ranks[parts[0].strip()] = int(parts[1])
            except ValueError:
                pass
    return ranks


# ------------------------------------------------------------------ build ---

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bioc", default="3.23")
    ap.add_argument("--out", default="./out")
    ap.add_argument("--universe", default="bioc-release")
    ap.add_argument("--software-origin", choices=["runiverse", "views"], default="runiverse")
    args = ap.parse_args()

    branch = "devel" if args.universe == "bioc" else "RELEASE_" + args.bioc.replace(".", "_")
    provenance, repos = {}, {}

    for repo in REPOS:
        if repo == "bioc" and args.software_origin == "runiverse":
            print(f"[{repo}] origin: r-universe ({args.universe})", file=sys.stderr)
            repos[repo] = from_runiverse(args.universe, branch)
            provenance[repo] = f"r-universe:{args.universe}"
        else:
            why = "no non-site origin available" if repo != "bioc" else "forced"
            print(f"[{repo}] origin: VIEWS  ({why})", file=sys.stderr)
            repos[repo] = from_views(args.bioc, repo, branch)
            provenance[repo] = "VIEWS (circular)"

    # Reverse dependencies span every repository AND CRAN — a Bioconductor page
    # lists CRAN packages that depend on it. So the graph is built from all four
    # repos plus CRAN's own PACKAGES index, which is a genuine external origin.
    rev = collections.defaultdict(lambda: collections.defaultdict(set))
    for repo, pkgs in repos.items():
        for name, rec in pkgs.items():
            for role, field in REV.items():
                for d in rec.get(role, []):
                    rev[dep_name(d)][field].add(name)

    cran = fetch("https://cran.r-project.org/src/contrib/PACKAGES", optional=True)
    if cran:
        n = 0
        for name, rec in parse_dcf(cran).items():
            for role, field in REV.items():
                for d in split_list(rec.get(role, "")):
                    rev[dep_name(d)][field].add(name)
            n += 1
        print(f"folded {n} CRAN packages into the reverse-dependency graph", file=sys.stderr)

    total = 0
    for repo, pkgs in repos.items():
        ranks = load_ranks(repo, args.bioc)
        for name, rec in pkgs.items():
            for field in REV.values():
                if rev[name][field]:
                    rec[field] = sorted(rev[name][field], key=str.lower)
            if name in ranks:
                rec["Rank"] = ranks[name]
            rec["dependencyCount"] = str(len({
                dep_name(d) for role in ("Depends", "Imports", "LinkingTo")
                for d in rec.get(role, []) if dep_name(d) != "R"
            }))
        d = os.path.join(args.out, args.bioc, repo)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "packages.json"), "w", encoding="utf-8") as fh:
            json.dump(pkgs, fh, indent=2, sort_keys=True)
        total += len(pkgs)
        print(f"  wrote {len(pkgs):>5} packages  {d}/packages.json", file=sys.stderr)

    print(f"\n{total} packages written under {args.out}/{args.bioc}", file=sys.stderr)
    print("\nprovenance:", file=sys.stderr)
    for repo, src in provenance.items():
        print(f"  {repo:<18} {src}", file=sys.stderr)
    print(f"  {'Rank':<18} bio-web-stats (separate service, genuine origin)", file=sys.stderr)
    print(f"  {'reverse deps':<18} computed across all four repos + CRAN", file=sys.stderr)


if __name__ == "__main__":
    main()
