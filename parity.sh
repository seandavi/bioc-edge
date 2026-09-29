#!/usr/bin/env bash
#
# Daily parity probe: does bioconductor.org (the new stack) answer like
# master.bioconductor.org (the legacy origin)? master stays up until parity is
# reached, so this is the gate for turning it off.
#
# For each path, both hosts are asked once, redirects NOT followed, and three
# things are compared: status, redirect target (host-normalized), and the
# content-type's major type on 200s. Bodies aren't compared: package landing
# pages are rebuilt by the Astro site and differ by design, and machine files
# are covered by the sync's own checks.
#
# Known differences live in parity-known.tsv, each with its reason (a decision or
# an open issue). They're reported, not failed on. A known entry whose hosts now
# AGREE is reported as FIXED so the entry gets deleted. Anything else is a failure.
#
#   ./parity.sh                  core paths + a date-seeded package sample
#   PATHS_FILE=paths.txt ./parity.sh
#
# Politeness: master is the box this project exists to retire. Requests to it are
# serialized with a sleep, bodies are discarded, and the UA is attributable.
set -uo pipefail

NEW=${NEW:-https://bioconductor.org}
OLD=${OLD:-https://master.bioconductor.org}
KNOWN=${KNOWN:-$(dirname "$(readlink -f "$0")")/parity-known.tsv}
UA=${UA:-'bioc-edge-parity/0.2 (+https://github.com/seandavi/bioc-edge; seandavi@gmail.com)'}
WAIT=${WAIT:-0.5}

# probe <base> <path> -> "status|location|ctype-major"
# '|' not tab: tab is whitespace to `read`, so an empty location would collapse
# and the content type would land in the location field.
probe() {
  curl -s -o /dev/null --max-time 30 -A "$UA" -w '%{http_code}|%{redirect_url}|%{content_type}' "$1$2" |
    awk -F'|' '{ct=$3; sub(/[;\/].*/, "", ct); print $1 "|" $2 "|" ct}'
}

# split_probe <probe line> -> the three fields on separate lines (for tests)
split_probe() { local a b c; IFS='|' read -r a b c <<<"$1"; printf '%s\n%s\n%s\n' "$a" "$b" "$c"; }

# Host-normalize a redirect target so /x on either host compares equal.
norm_loc() { sed -E 's#^https?://(www\.|master\.)?bioconductor\.org##' <<<"$1"; }

# compare <new status> <new loc> <new ctype> <old status> <old loc> <old ctype> -> same | diff
# Pure; pinned by test-parity.sh.
compare() {
  local ns=$1 nl=$2 nc=$3 os=$4 ol=$5 oc=$6
  [[ $ns == "$os" ]] || { echo diff; return; }
  [[ $(norm_loc "$nl") == "$(norm_loc "$ol")" ]] || { echo diff; return; }
  # Content-type only matters on 200s, and only when master sent one: Apache
  # sends none for many plain files (PACKAGES, .dcf), which isn't a difference.
  if [[ $ns == 200 && -n $oc && $nc != "$oc" ]]; then echo diff; return; fi
  echo same
}

# known_reason <path> -> the reason from parity-known.tsv, or nothing.
# Format: <extended regex>\t<reason>. Lines starting with # are comments.
known_reason() {
  [[ -f $KNOWN ]] || return 0
  awk -F'\t' -v p="$1" '!/^#/ && NF >= 2 && p ~ $1 { print $2; exit }' "$KNOWN"
}

core_paths() {
  cat <<'P'
/
/install/
/help/
/about/
/developers/
/packages/
/packages/release/BiocViews.html
/packages/devel/BiocViews.html
/packages/release/bioc/html/limma.html
/packages/devel/bioc/html/limma.html
/packages/release/bioc/src/contrib/PACKAGES
/packages/release/bioc/src/contrib/PACKAGES.gz
/packages/release/bioc/src/contrib/PACKAGES.rds
/packages/release/bioc/VIEWS
/packages/devel/bioc/src/contrib/PACKAGES.gz
/packages/release/data/annotation/src/contrib/PACKAGES.gz
/packages/release/data/experiment/src/contrib/PACKAGES.gz
/packages/release/workflows/src/contrib/PACKAGES.gz
/packages/3.23/bioc/src/contrib/Archive/limma/
/packages/3.23/container-binaries/bioconductor_docker/src/contrib/PACKAGES.gz
/packages/3.23/BiocManager
/packages/limma
/packages/stats/
/packages/stats/bioc/limma/
/config.yaml
/BiocManager.dcf
/bioc-version
/checkResults/
/checkResults/3.23/bioc-LATEST/
/checkResults/3.23/bioc-LATEST/limma/
/checkResults/3.23/bioc-LATEST/limma/raw-results/
/checkResults/3.23/bioc-LATEST/limma/raw-results
/checkResults/3.23/bioc-LATEST/limma/raw-results/nebbiolo1/checksrc-summary.dcf
/help/course-materials/
/about/privacy
/robots.txt
P
}

# A date-seeded sample of release and devel packages, from the live indexes:
# landing page, source tarball and the three binaries each.
sampled_paths() {
  local seed; seed=$(date +%F)
  for ver in release devel; do
    local pk; pk=$(curl -fsS -A "$UA" "$NEW/packages/$ver/bioc/src/contrib/PACKAGES") || continue
    awk '/^Package:/{p=$2} /^Version:/{print p, $2}' <<<"$pk" |
      shuf -n 5 --random-source=<(yes "$seed$ver") |
      while read -r p v; do
        echo "/packages/$ver/bioc/html/$p.html"
        echo "/packages/$ver/bioc/src/contrib/${p}_$v.tar.gz"
      done
  done
}

main() {
  for h in "$NEW" "$OLD"; do
    local home; home=$(probe "$h" /)
    [[ ${home%%|*} == 200 ]] || { echo "sanity: $h/ -> [$home]"; exit 1; }
  done
  local paths
  if [[ -n ${PATHS_FILE:-} ]]; then paths=$(cat "$PATHS_FILE"); else paths="$(core_paths)"$'\n'"$(sampled_paths)"; fi
  local fail=0 n=0 known=0 fixed=0
  while read -r p; do
    [[ -z $p ]] && continue
    n=$((n + 1))
    local r ns nl nc os ol oc
    IFS='|' read -r ns nl nc <<<"$(probe "$NEW" "$p")"
    IFS='|' read -r os ol oc <<<"$(probe "$OLD" "$p")"
    r=$(known_reason "$p")
    if [[ $(compare "$ns" "$nl" "$nc" "$os" "$ol" "$oc") == same ]]; then
      if [[ -n $r ]]; then echo "FIXED    $p  [$ns]  known entry can go: $r"; fixed=$((fixed + 1)); fi
    elif [[ -n $r ]]; then
      echo "known    $p  new=[$ns $nl] master=[$os $ol]  $r"; known=$((known + 1))
    else
      echo "MISMATCH $p  new=[$ns $nl $nc] master=[$os $ol $oc]"; fail=1
    fi
    sleep "$WAIT"
  done <<<"$paths"
  echo "checked $n paths: $known known differences, $fixed fixed, $([[ $fail == 1 ]] && echo 'new mismatches (above)' || echo 'no new mismatches')"
  exit $fail
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
