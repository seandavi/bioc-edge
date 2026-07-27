#!/usr/bin/env bash
#
# Mirror bioconductor.org over HTTP into ./mirror, laid out so that
# `rclone sync mirror r2:bioc-site` produces keys identical to live URLs.
#
#   ./crawl.sh site        non-package site (phase 1), honors robots.txt
#   ./crawl.sh packages    package landing pages + vignettes (phase 2)
#   SPIDER=1 ./crawl.sh packages    count and size without filling disk
#
# SPIDER still transfers every page -- wget has to read the HTML to follow
# links -- it just does not keep them. It saves disk, not load on master.
#
# CloudFront misses most HTML on this site, so the crawl lands on master --
# the machine whose IOPS we are trying not to exhaust. It is rate limited by
# default and should run off-peak; watch EBS metrics during the first pass.
# RATE and WAIT are the knobs; lower RATE / raise WAIT if latency climbs.
set -euo pipefail

SITE=${SITE:-https://bioconductor.org}
DEST=${DEST:-mirror}
RATE=${RATE:-2m}
WAIT=${WAIT:-0.5}
# Identifies the crawl in master's access logs so it can be told apart from
# the bot traffic we are investigating, and excluded from those counts.
UA=${UA:-"bioc-r2-migration/0.1 (+https://github.com/Bioconductor/bioc-cloudflare)"}

phase=${1:-}
case "$phase" in
  site)
    # robots.txt already disallows /packages/, /checkResults/, /biocViews/,
    # /stats/, /data/ and friends, so honoring it scopes this to the
    # non-package site for free. Archives are phase 3.
    targets=("$SITE/")
    extra=(--reject-regex='(\?|\.(tar\.gz|tgz|tar\.bz2|zip)$)')
    ;;
  packages)
    # robots.txt disallows the entire package section. This is our own site
    # and we need the landing pages, so override -- but stay out of
    # src/ and bin/, which are the multi-TB phase 3 repo.
    targets=("$SITE/packages/release/bioc/")
    extra=(-e robots=off --no-parent --reject-regex='(\?|/(src|bin)/)')
    ;;
  *)
    echo "usage: $0 {site|packages}" >&2
    exit 2
    ;;
esac

log="crawl-$phase.log"

# --mirror is -r -N -l inf: recursive, unlimited depth, and timestamped so
# re-crawls issue conditional requests instead of refetching everything.
#
# Deliberately NOT used: --convert-links and --adjust-extension. Both rewrite
# paths, and R2 keys have to match live URLs byte for byte.
common=(
  --mirror
  --no-host-directories
  --page-requisites
  # Belt-and-braces: without --span-hosts wget already refuses to leave the
  # start host, which is what keeps the crawl off www.bioconductor.org (a
  # distinct host serving 200, not a redirect to the apex).
  --domains=bioconductor.org
  --wait="$WAIT" --random-wait --limit-rate="$RATE"
  --tries=3 --timeout=30 --waitretry=10
  --user-agent="$UA"
  --directory-prefix="$DEST"
  --no-verbose --append-output="$log"
)

[[ ${SPIDER:-} == 1 ]] && common+=(--spider)

echo "crawling $phase -> $DEST (rate=$RATE wait=${WAIT}s), logging to $log"
# wget exits 8 on any server-error response; a few 404s in the link graph
# should not kill a multi-hour crawl.
wget "${common[@]}" "${extra[@]}" "${targets[@]}" || [[ $? == 8 ]]

if [[ ${SPIDER:-} == 1 ]]; then
  # --no-verbose logs as: <date> URL:<url> [<bytes>/<total>] -> "<file>" [n]
  awk '/URL:/ && match($0, /\[[0-9]+\//) {n++; b+=substr($0, RSTART+1, RLENGTH-2)} \
       END {printf "%d objects, %.3f GB\n", n, b/1e9}' "$log"
  exit 0
fi

# wget mirrors the production robots.txt, which on the prototype host would
# invite indexing of a duplicate of the entire site. Deny everything instead.
# Drop this line if this mirror is ever promoted to production.
printf 'User-agent: *\nDisallow: /\n' > "$DEST/robots.txt"

printf '%s objects, %s\n' "$(find "$DEST" -type f | wc -l)" "$(du -sh "$DEST" | cut -f1)"
