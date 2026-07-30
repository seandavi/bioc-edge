#!/usr/bin/env bash
#
# Push the local mirror to R2, then purge exactly the objects that changed.
#
#   ./sync.sh                          crawl mirror -> R2 (phase 1)
#   RSYNC_SRC=$RSYNC_SRC ./sync.sh
#                                      pull from the upstream docroot host, push only what moved
#   DRY_RUN=1 ./sync.sh                report what would change, change nothing
#
# Two ways to learn what changed, because the two sources differ in scale:
#
#   crawl  (~500 objects)  rclone sync compares both sides itself.
#   rsync  (3.7M objects)  rsync computes the delta while pulling, and we feed
#                          only those keys to rclone. A full `rclone sync` here
#                          would be pathological: R2's ListObjectsV2 returns
#                          size/ETag/LastModified but not user metadata, and
#                          rclone keeps mtime in user metadata -- so a modtime
#                          comparison forces a HEAD per object. 3.7M Class B
#                          ops per run, hours before a byte moves.
#
# Worker cache entries are keyed by resolved R2 object key (cacheUrl() in
# worker/src/keys.ts), so the keys reported as changed map 1:1 onto the
# URLs to purge. Keying on request URLs instead would mean purging every URL
# form that resolves to an object -- /help/, /help and /help/index.html.
set -euo pipefail

BUCKET=${BUCKET:-bioc-site}
DEST=${DEST:-mirror}
HOST=${HOST:-bioc-dev.cancerdatasci.org}
ZONE=${ZONE:-cancerdatasci.org}
# Excluded from the rsync pull. LoriTempToRemove/ is 6.1 GB / 2,701 files of
# abandoned staging in the docroot -- the name is upstream's, not ours.
# checkResults/ is the open one: 2,607,459 files (70% of all objects) for 38 GB,
# regenerated daily, and robots.txt already disallows it. See MIGRATION.md.
RSYNC_EXCLUDE=${RSYNC_EXCLUDE:-LoriTempToRemove/}
# Purge-by-URL takes 30 URLs per call and is the only targeted option below
# Enterprise. Past this many changes it is fewer API calls to purge the zone
# and let the edge refill from R2 -- egress is free and Class B is $0.36/M.
PURGE_MAX=${PURGE_MAX:-300}

[[ -n ${RSYNC_SRC:-} || -d $DEST ]] ||
  { echo "no mirror at $DEST -- run ./crawl.sh site first" >&2; exit 1; }
: "${CLOUDFLARE_API_TOKEN:?run: ./make-env.sh && set -a && . ./.env && set +a}"

log=sync-$(date +%Y%m%dT%H%M%S).log

# Reconciliation. RSYNC_SRC mode trusts rsync's delta and never looks at the
# bucket, so a failed upload or a hand-edited object diverges silently and
# forever. This is the pass that catches it, and it is why the delta mode is
# safe to run hourly.
#
# --checksum, not the default size+modtime: R2 returns the MD5 as the ETag on
# single-part uploads, so both sides of the comparison come out of the bucket
# LIST -- no HEAD per object. It costs a full local read to hash 488 GB, which
# is exactly why this is a weekly job and not the hourly one.
if [[ -n ${RECONCILE:-} ]]; then
  # rclone check exits non-zero when it finds differences, which is the
  # interesting case, not an error -- so don't let set -e eat it.
  rclone check "$DEST" "r2:$BUCKET" --checksum --checkers 32 \
    --missing-on-dst "$log.missing" --differ "$log.differ" || true
  echo "drift: $(wc -l < "$log.missing") missing on R2, $(wc -l < "$log.differ") differing"
  echo "re-upload with: rclone copy $DEST r2:$BUCKET --files-from <(cat $log.missing $log.differ) --no-traverse"
  exit
fi

# rclone derives Content-Type from the file extension, so extensionless keys
# would upload as application/octet-stream and download rather than render.
# They exist because wget saves a redirect's body under the requested path,
# so they are HTML. This runs *before* the sync below: rclone then sees them
# as already current and will not re-upload them with a guessed type.
#
# Crawl mirrors only. The docroot has real extensionless files that are *not*
# HTML -- VIEWS, DESCRIPTION, PACKAGES -- and typing those as text/html would
# corrupt them.
if [[ -z ${DRY_RUN:-} && -z ${RSYNC_SRC:-} ]]; then
  extless=$(mktemp)
  (cd "$DEST" && find . -type f ! -name '*.*' -printf '%P\n') > "$extless"
  if [[ -s $extless ]]; then
    rclone copy "$DEST" "r2:$BUCKET" --files-from "$extless" \
      --header-upload "Content-Type: text/html; charset=utf-8" \
      --log-level INFO --log-file "$log"
    echo "$(wc -l < "$extless") extensionless objects typed as text/html"
  fi
  rm -f "$extless"
fi

if [[ -n ${RSYNC_SRC:-} ]]; then
  # rsync is the only way in: the upstream docroot host is rrsync-locked, so nothing else can
  # even enumerate it. Since it has to run anyway, let it compute the delta.
  #
  # %i is an 11-char itemize code, %n the path relative to $DEST -- which is
  # exactly what `rclone --files-from` wants. Splitting on `|` is safe: no path
  # in the docroot contains one (inventory/README.md, "Access notes").
  mkdir -p "$DEST"
  rsync -a --delete --out-format='%i|%n' \
    ${RSYNC_EXCLUDE:+--exclude="$RSYNC_EXCLUDE"} \
    ${DRY_RUN:+--dry-run} \
    "$RSYNC_SRC" "$DEST/" > "$log"

  # `>f` = file content received. This is a *superset* of what R2 needs, and
  # the difference is not academic: rsync's quick check is size+mtime, so a
  # file the builder rewrote with identical bytes still itemizes `>f..t......`
  # and lands here. checkResults/ regenerates nightly across 2.6M files -- taken
  # at face value that is 2.6M pointless uploads and a nightly full-zone purge.
  # (`.f` is attribute-only, e.g. `.f...p.....` for chmod. Not a transfer.)
  #
  # Deletions of directories carry a trailing slash; object storage has no
  # directories, so drop them.
  cand=$(mktemp) gone=$(mktemp) links=$(mktemp)
  trap 'rm -f "$cand" "$gone" "$links"' EXIT
  awk -F'|' '$1 ~ /^>f/         {print $2}' "$log" > "$cand"
  awk -F'|' '$1 ~ /^\*deleting/ && $2 !~ /\/$/ {print $2}' "$log" > "$gone"

  # So rclone is the second, precise filter. --checksum compares local MD5
  # against R2's ETag and skips the byte-identical ones. Affordable only
  # because it runs over the candidate list rather than the bucket: rsync cuts
  # 3.7M objects to thousands, then this cuts thousands to what actually moved.
  #
  # --files-from makes rclone stat only the named keys instead of listing the
  # bucket. Correct *because* the list is short; the same flag on a full sync
  # is the disaster it exists to avoid.
  #
  # Symlinks are not passed (`>f` excludes rsync's `cL`), and rclone would skip
  # them anyway without --links. That is intended: R2 has no symlinks and the
  # Worker resolves them. Regenerate the map with `find $DEST -type l`.
  rlog=$log.rclone
  : > "$rlog"
  if [[ -z ${DRY_RUN:-} ]]; then
    [[ -s $cand ]] && rclone copy "$DEST" "r2:$BUCKET" --files-from "$cand" \
      --no-traverse --checksum --transfers 16 --log-level INFO --log-file "$rlog"
    [[ -s $gone ]] && rclone delete "r2:$BUCKET" --files-from "$gone"
  fi

  # Symlinks are upstream state, not configuration: bioc-LATEST links move
  # nightly and contrib/ aliases appear whenever an R version rolls. Checking a
  # map into the repo would mean a commit and a deploy per upstream change, so
  # the run that observes a link is the run that publishes it. rsync recreated
  # them locally, so the mirror already has the answer.
  #
  # Published last, deliberately. A map uploaded before the objects points at
  # keys that do not exist yet.
  find "$DEST" -type l -printf '%P\t%l\n' | LC_ALL=C sort |
    jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {(.[0]): .[1]}) | add // {}' \
    > "$links"
  if [[ -z ${DRY_RUN:-} ]]; then
    rclone rcat "r2:$BUCKET/_symlinks.json" < "$links" \
      --header-upload "Content-Type: application/json"
  fi
  echo "$(jq 'length' < "$links") symlinks mapped"

  # Purge what rclone actually wrote, not what rsync offered. Using the
  # candidate list here would purge thousands of URLs for a handful of real
  # changes -- and blow past PURGE_MAX into a full zone purge most nights.
  mapfile -t changed < <(
    { sed -n 's/.*INFO  : \(.*\): \(Copied\|Updated\).*/\1/p' "$rlog"; cat "$gone"; } | sort -u
  )
  echo "${#changed[@]} objects changed ($(wc -l < "$cand") rsync candidates, $(wc -l < "$gone") deleted)"
else
  # Deliberately `sync`, not `copy`: the mirror is authoritative and deletions
  # have to propagate. Run DRY_RUN=1 first on any layout change.
  rclone sync "$DEST" "r2:$BUCKET" \
    --log-level INFO --log-file "$log" \
    --transfers 16 --checkers 32 \
    ${DRY_RUN:+--dry-run}

  # rclone logs `INFO  : <key>: Copied (new)` / `Updated` / `Deleted`.
  mapfile -t changed < <(
    sed -n 's/.*INFO  : \(.*\): \(Copied\|Updated\|Deleted\|Moved\).*/\1/p' "$log" | sort -u
  )
  echo "${#changed[@]} objects changed (log: $log)"
fi

if [[ ${DRY_RUN:-} == 1 ]]; then
  printf '%s\n' "${changed[@]:0:20}"
  exit 0
fi
[[ ${#changed[@]} -gt 0 ]] || exit 0

api="https://api.cloudflare.com/client/v4"
auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json")

zone_id=$(curl -sS "${auth[@]}" "$api/zones?name=$ZONE" | jq -r '.result[0].id // empty')
[[ -n $zone_id ]] || { echo "cannot resolve zone $ZONE; token may lack Zone:Read" >&2; exit 1; }

purge_body() {
  local ok
  ok=$(curl -sS -X POST "${auth[@]}" --data "$1" "$api/zones/$zone_id/purge_cache" |
    jq -r '.success, (.errors[]?.message)' | head -3)
  [[ $ok == true ]] || { echo "purge failed: $ok" >&2; return 1; }
}

if ((${#changed[@]} > PURGE_MAX)); then
  echo "purging entire zone (${#changed[@]} > PURGE_MAX=$PURGE_MAX)"
  purge_body '{"purge_everything":true}'
else
  urls=()
  for k in "${changed[@]}"; do urls+=("https://$HOST/$k"); done
  for ((i = 0; i < ${#urls[@]}; i += 30)); do
    purge_body "$(jq -nc --args '{files: $ARGS.positional}' "${urls[@]:i:30}")"
  done
  echo "purged ${#urls[@]} urls"
fi
