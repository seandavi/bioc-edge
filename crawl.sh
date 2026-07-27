#!/usr/bin/env bash
#
# Mirror bioconductor.org over HTTP into ./mirror, laid out so that
# `rclone sync mirror r2:bioc-site` produces keys identical to live URLs.
#
#   ./crawl.sh site        non-package site (phase 1), honors robots.txt
#   ./crawl.sh packages    package landing pages + vignettes (phase 2)
#   ./crawl.sh canonical   pass 2: store redirect targets at their real paths
#   ./crawl.sh refresh     re-fetch known URLs conditionally (cheap, frequent)
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
urls="$DEST.urls"

phase=${1:-}

# Pass 2. The link graph points at shortcuts (/packages/Foo), those redirect
# to canonical pages (/packages/release/bioc/html/Foo.html), and wget saves
# the body under the *requested* path -- so the canonical URL, which is what
# everything links to and search engines index, is never stored.
#
# One log line carries both halves: the final URL, and a filename wget derived
# from the requested path. Where they disagree, it was a redirect.
#
# ponytail: POC-grade. An rsync from staging makes this whole pass disappear.
if [[ $phase == canonical ]]; then
  src_log=${LOG:-crawl-site.log}
  [[ -s $src_log ]] || { echo "no $src_log -- run ./crawl.sh site first" >&2; exit 1; }
  map="$DEST.redirects.tsv"

  awk -v dest="$DEST" '
    /URL:/ {
      u = substr($3, 5)
      if (!match($0, /"[^"]*"/)) next
      f = substr($0, RSTART + 1, RLENGTH - 2)
      if (index(f, dest "/") != 1) next           # stale line from an older DEST
      rel = substr(f, length(dest) + 2)
      p = u; sub(/^https?:\/\/[^\/]+/, "", p)     # url path, scheme-agnostic
      expect = (p ~ /\/$/) ? substr(p, 2) "index.html" : substr(p, 2)
      if (rel == expect) next                     # saved where it was fetched
      print "/" rel "\t" p
    }' "$src_log" | sort -u > "$map"

  echo "$(wc -l < "$map") redirects found"
  [[ -s $map ]] || exit 0

  # Baked into the Worker bundle rather than KV or an R2 lookup: ~200 entries
  # is nothing in memory, and a redeploy per crawl is fine at POC scale.
  jq -Rn '[inputs | split("\t") | {(.[0]): .[1]}] | add // {}' < "$map" > worker/src/redirects.json
  echo "wrote worker/src/redirects.json"

  cut -f2 "$map" | sed "s|^|$SITE|" | sort -u > "$DEST.targets"
  wget --no-host-directories --no-verbose -S --append-output="crawl-canonical.log" \
       --wait="$WAIT" --random-wait --limit-rate="$RATE" \
       --tries=3 --timeout=30 --waitretry=10 --user-agent="$UA" \
       --directory-prefix="$DEST" -e robots=off --no-recursive \
       --input-file="$DEST.targets" || [[ $? == 8 ]]

  # The flattened copies are redundant now that the Worker 301s these paths,
  # and removing them keeps the mirror URL-faithful.
  (cd "$DEST" && cut -f1 "$map" | sed 's|^/||' | tr '\n' '\0' | xargs -0 rm -f)
  echo "canonical pass done: $(find "$DEST" -type f | wc -l) objects"
  exit 0
fi

case "$phase" in
  site)
    # robots.txt already disallows /packages/, /checkResults/, /biocViews/,
    # /stats/, /data/ and friends, so honoring it scopes this to the
    # non-package site for free. Archives are phase 3.
    targets=("$SITE/")
    # Course materials are mostly lecture media: three .mp4 files alone are
    # 711 MB, against 2 MB for every HTML page on the site. Crawling those
    # over HTTP pulls gigabytes off the very box whose IOPS we are trying to
    # protect, so they are excluded by default. MEDIA=1 to include them.
    reject='(\?|\.(tar\.gz|tgz|tar\.bz2|zip)$)'
    [[ ${MEDIA:-} == 1 ]] || reject='(\?|\.(tar\.gz|tgz|tar\.bz2|zip|mp4|m4v|mov|avi|mkv|webm|pptx?|docx?|xlsx?)$)'
    extra=(--reject-regex="$reject")
    ;;
  refresh)
    # Discovery and refresh have to be separate passes. wget's -N cannot do
    # both: on a 304 it has no body to extract links from, so a recursive
    # re-crawl dies at the first unchanged page and silently walks nothing.
    # So: recurse without -N to discover (infrequent), then re-fetch the
    # discovered URL list with -N and no recursion (frequent, conditional).
    [[ -s $urls ]] || { echo "no $urls -- run ./crawl.sh site first" >&2; exit 1; }
    targets=()
    extra=(-N --no-recursive --input-file="$urls" -e robots=off)
    ;;
  packages)
    # robots.txt disallows the entire package section. This is our own site
    # and we need the landing pages, so override -- but stay out of
    # src/ and bin/, which are the multi-TB phase 3 repo.
    targets=("$SITE/packages/release/bioc/")
    extra=(-e robots=off --no-parent --reject-regex='(\?|/(src|bin)/)')
    ;;
  *)
    echo "usage: $0 {site|packages|canonical|refresh}" >&2
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
  # NOT --mirror: it implies -N, which kills recursion on the first 304.
  --recursive --level=inf
  --no-host-directories
  --page-requisites
  # Belt-and-braces: without --span-hosts wget already refuses to leave the
  # start host, which is what keeps the crawl off www.bioconductor.org (a
  # distinct host serving 200, not a redirect to the apex).
  --domains=bioconductor.org
  --wait="$WAIT" --random-wait --limit-rate="$RATE"
  --tries=3 --timeout=30 --waitretry=10
  --user-agent="$UA"
  # -S logs response headers (and survives --no-verbose), which is how the
  # redirect map gets built: /books/* answer with 4-hop chains that wget
  # otherwise flattens into an extensionless file at the requested path.
  -S
  --directory-prefix="$DEST"
  --no-verbose --append-output="$log"
)

[[ ${SPIDER:-} == 1 ]] && common+=(--spider)

# Discovery re-fetches everything, and wget suffixes rather than overwrites
# an existing file, so a discovery crawl needs a clean destination.
if [[ $phase != refresh && -d $DEST ]]; then
  echo "note: $DEST exists; discovery expects it empty (rm -rf it first)" >&2
fi

[[ $phase == refresh ]] || : > "$log"
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

# The URL list is what `refresh` re-fetches; discovery is the only way to
# learn about new pages, so it has to run on its own schedule.
if [[ $phase != refresh ]]; then
  sed -n 's/.*URL:\([^ ]*\).*/\1/p' "$log" | sort -u > "$urls"
  echo "$(wc -l < "$urls") urls recorded in $urls"
fi

printf '%s objects, %s\n' "$(find "$DEST" -type f | wc -l)" "$(du -sh "$DEST" | cut -f1)"
