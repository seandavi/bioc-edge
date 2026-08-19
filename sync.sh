#!/usr/bin/env bash
#
# Push the local mirror to R2, then purge exactly the objects that changed.
#
#   ./sync.sh                          crawl mirror -> R2 (phase 1)
#   RSYNC_SRC=... ./sync.sh          (value in .env, not in the repo)
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
# What the pull includes, as rsync filter rules. Kept in a file rather than
# inline because it is the scope decision, not a tuning knob -- see the header
# of ./rsync-filter for what is dropped and what it costs.
RSYNC_FILTER=${RSYNC_FILTER:-$(dirname "$0")/rsync-filter}
# How many changed URLs are still worth purging one at a time, rather than
# giving up and dropping the whole edge cache. The mechanics of the purge
# itself -- batch size, pacing, retries -- live in cf-purge.sh.
#
# The old ceiling of 300 came with a rationale written when this bucket held
# 507 objects: past a few hundred changes, purging the zone was fewer API calls
# than purging each URL. That reasoning does not survive the bucket growing to
# 1.65M objects. A zone purge now discards the entire edge cache, so every one
# of those objects refills from R2 on next request -- and the cache is the
# whole point of the architecture, not an optimisation on top of it.
#
# 10,000 is 100 requests and ~13 seconds of rate budget. Past that a zone purge
# genuinely is simpler, and a change that large should have a human attached
# anyway -- a release roll drops ~129k objects in one run.
PURGE_MAX=${PURGE_MAX:-10000}

. "$(dirname "$0")/cf-purge.sh"

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
  # rsync is the only way in: the docroot host is rrsync-locked, so nothing else can
  # even enumerate it. Since it has to run anyway, let it compute the delta.
  #
  # %i is an 11-char itemize code, %n the path relative to $DEST -- which is
  # exactly what `rclone --files-from` wants. Splitting on `|` is safe: no path
  # in the docroot contains one (inventory/README.md, "Access notes").
  mkdir -p "$DEST"
  [[ -f $RSYNC_FILTER ]] || { echo "no filter file at $RSYNC_FILTER" >&2; exit 1; }
  # rsync's exit code needs interpreting, not trusting. 23 means "some files
  # could not be transferred" and 24 means "some vanished before transfer" --
  # both are *normal* against a live docroot that is being rebuilt underneath
  # us, and 23 is permanent here: a dozen upstream files have been unreadable
  # since before this project started (they 403 from production too).
  #
  # Under set -e an unhandled 23 aborts the script the instant rsync returns,
  # so nothing after this point runs: no upload, no deletion, no symlink map,
  # no purge. The delta sync would fail on every run while looking like it
  # merely had a warning. Measured: a real run exited 23 after 21 minutes
  # having done nothing but the pull.
  set +e
  rsync -a --delete --out-format='%i|%n' \
    --filter="merge $RSYNC_FILTER" \
    ${DRY_RUN:+--dry-run} \
    "$RSYNC_SRC" "$DEST/" > "$log" 2> "$log.err"
  rc=$?
  set -e
  case $rc in
    0) ;;
    23|24) echo "rsync exit $rc: $(grep -c 'Permission denied\|vanished' "$log.err" || true) files skipped (unreadable or vanished) -- see $log.err" ;;
    *) echo "rsync failed, exit $rc -- aborting before touching R2" >&2
       tail -3 "$log.err" >&2; exit $rc ;;
  esac

  # `>f` = file content received. This is a *superset* of what R2 needs, and
  # the difference is not academic: rsync's quick check is size+mtime, so a
  # file the builder rewrote with identical bytes still itemizes `>f..t......`
  # and lands here. checkResults/ regenerates nightly across 2.6M files -- taken
  # at face value that is 2.6M pointless uploads and a nightly full-zone purge.
  # (`.f` is attribute-only, e.g. `.f...p.....` for chmod. Not a transfer.)
  #
  # Deletions of directories carry a trailing slash; object storage has no
  # directories, so drop them.
  cand=$(mktemp) gone=$(mktemp) links=$(mktemp) extless=$(mktemp)
  trap 'rm -f "$cand" "$gone" "$links" "$extless"' EXIT
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
  # Extensionless keys again, but the opposite answer from the crawl path.
  # rclone types by extension, so these would upload as octet-stream and
  # download rather than render -- and the Worker's contentType() fallback
  # cannot save them, because it only fires when the type is *missing*, not
  # when it is wrong.
  #
  # The crawl path types them text/html because there they are flattened
  # redirects. Here they are real files and none of them are HTML: 35,743 in
  # the filtered tree, overwhelmingly NEWS (27,065), LICENSE (7,122), README,
  # plus the repository indexes R itself reads -- VIEWS, PACKAGES, DESCRIPTION.
  # text/plain is the honest answer for all of them.
  #
  # Uploaded first for the same reason as the crawl path: the --checksum copy
  # below then sees them as current and will not overwrite the type.
  awk -F/ '$NF !~ /\./' "$cand" > "$extless"

  rlog=$log.rclone
  : > "$rlog"
  if [[ -z ${DRY_RUN:-} ]]; then
    [[ -s $extless ]] && rclone copy "$DEST" "r2:$BUCKET" --files-from "$extless" \
      --no-traverse --checksum --transfers 16 \
      --header-upload "Content-Type: text/plain; charset=utf-8" \
      --log-level INFO --log-file "$rlog"
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

  # Regenerate the mirror manifest. Without this the published file list keeps
  # describing whatever the last full load saw, so operators sync a stale set:
  # missing new packages, fetching deleted ones, failing hashes on updated
  # ones. ~72 LIST ops per run, about $0.23/month -- not worth making
  # conditional on whether packages/ happened to change.
  if [[ -z ${DRY_RUN:-} ]]; then
    "$(dirname "$0")/gen-manifest.sh" || echo "WARNING: manifest regeneration failed; the published one is now stale" >&2
  fi

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

zone_id=$(cf_zone_id "$ZONE") ||
  { echo "cannot resolve zone $ZONE; token may lack Zone:Read" >&2; exit 1; }

if ((${#changed[@]} > PURGE_MAX)); then
  echo "purging entire zone (${#changed[@]} > PURGE_MAX=$PURGE_MAX)"
  cf_purge_everything "$zone_id"
else
  urls=()
  for k in "${changed[@]}"; do urls+=("https://$HOST/$k"); done
  cf_purge_urls "$zone_id" "${urls[@]}"
  echo "purged ${#urls[@]} urls"
fi
